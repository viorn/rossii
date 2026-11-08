/**
 * `rossii update` — check GitHub releases and replace the installed binary.
 *
 * Mirrors install-release.sh rather than re-implementing it differently:
 * `/releases/latest` for a stable release (`--pre` looks at the newest
 * published one, prereleases included), the `rossii-<ver>-linux-x86_64`
 * asset (legacy `cgoose-…` names still resolve), SHA-256 verification against
 * the asset digest, and an atomic rename in the destination directory.
 *
 * Nothing here needs goose or a TTY: it works before the wizard starts.
 */

import { createHash } from "node:crypto";
import { createReadStream, chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import pc from "picocolors";

import pkg from "../package.json";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_REPO = "viorn/rossii";
const DEFAULT_INSTALL_DIR = join(homedir(), ".local", "bin");
const BIN_NAME = "rossii";

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

export interface ParsedVersion {
  /** Numeric major/minor/patch */
  core: [number, number, number];
  /** Prerelease suffix (`rc.1` in `3.5.2-rc.1`), null for a release */
  pre: string | null;
}

/** Parse `3.5.2`, `v3.5.2` or `v3.5.2-rc.1`; null when it is not a version. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim().replace(/^v/i, ""));
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal.
 *  A release outranks a prerelease of the same core (`3.5.2` > `3.5.2-rc.1`). */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre);
}

/** `v3.5.2` from `3.5.2`; an already prefixed tag is returned as-is. */
export function normalizeTag(value: string): string {
  const tag = value.trim();
  return tag.startsWith("v") ? tag : `v${tag}`;
}

/** Release asset name for a version and platform (`linux`/`x86_64`). */
export function assetName(version: string, os: string, arch: string): string {
  return `${BIN_NAME}-${version}-${os}-${arch}`;
}

/** First SHA-256 in a `.sha256` file (`<hash>  <name>`). */
export function parseChecksum(text: string): string | null {
  const match = /(?:^|\s)([0-9a-f]{64})(?:\s|$)/i.exec(text.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Where the new binary goes.
 *
 * A standalone `rossii` replaces itself in place; anything else (running from
 * source with `bun src/index.ts`, or a hand-renamed release file) installs to
 * `~/.local/bin/rossii`, the same place install-release.sh uses.
 */
export function resolveInstallTarget(opts: {
  dir?: string;
  execPath: string;
  home: string;
}): string {
  if (opts.dir) return join(opts.dir, BIN_NAME);
  return basename(opts.execPath) === BIN_NAME
    ? opts.execPath
    : join(opts.home, ".local", "bin", BIN_NAME);
}

/** Platform names used by the release assets, or null when none is published. */
export function releasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { os: string; arch: string } | null {
  if (platform !== "linux") return null;
  if (arch !== "x64" && arch !== "x86_64") return null;
  return { os: "linux", arch: "x86_64" };
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

interface Release {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
}

function repo(): string {
  return process.env.ROSSII_REPO || DEFAULT_REPO;
}

async function github<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `rossii/${pkg.version}`,
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo()}${path}`, { headers });
  } catch (error) {
    throw new Error(`cannot reach api.github.com: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const hint = response.status === 403 ? " (GitHub API rate limit? set GITHUB_TOKEN)" : "";
    throw new Error(`GitHub API ${response.status} for ${path}${hint}`);
  }
  return (await response.json()) as T;
}

/** The release to install: a pinned tag, the newest (--pre), or the stable latest. */
async function findRelease(opts: { version?: string; pre: boolean }): Promise<Release> {
  if (opts.version) {
    return github<Release>(`/releases/tags/${encodeURIComponent(normalizeTag(opts.version))}`);
  }
  if (opts.pre) {
    const releases = await github<Release[]>("/releases?per_page=20");
    const release = releases.find((candidate) => !candidate.draft);
    if (!release) throw new Error("no published releases yet");
    return release;
  }
  return github<Release>("/releases/latest");
}

// ─── Download ────────────────────────────────────────────────────────────────

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Expected checksum: the asset digest, else the sibling `.sha256` asset. */
async function expectedChecksum(
  release: Release,
  asset: ReleaseAsset,
): Promise<{ value: string | null; source: string }> {
  const digest = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
  if (digest) return { value: digest.toLowerCase(), source: "asset digest" };

  const sibling = release.assets.find((candidate) => candidate.name === `${asset.name}.sha256`);
  if (sibling) {
    try {
      const response = await fetch(sibling.browser_download_url, {
        headers: { "User-Agent": `rossii/${pkg.version}` },
      });
      if (response.ok) {
        const parsed = parseChecksum(await response.text());
        if (parsed) return { value: parsed, source: "sha256 file" };
      }
    } catch {
      // fall through to "no checksum"
    }
  }
  return { value: null, source: "none" };
}

// ─── Command ─────────────────────────────────────────────────────────────────

interface UpdateOptions {
  check: boolean;
  pre: boolean;
  force: boolean;
  noChecksum: boolean;
  version?: string;
  dir?: string;
}

function parseArgs(args: string[]): UpdateOptions | null {
  const opts: UpdateOptions = { check: false, pre: false, force: false, noChecksum: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--check":
      case "-c":
        opts.check = true;
        break;
      case "--pre":
      case "--prerelease":
        opts.pre = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--no-checksum":
        opts.noChecksum = true;
        break;
      case "--version":
      case "-v":
        if (!args[++i]) return null;
        opts.version = args[i];
        break;
      case "--dir":
      case "-d":
        if (!args[++i]) return null;
        opts.dir = args[i];
        break;
      case "-h":
      case "--help":
        printUpdateHelp();
        return null;
      default:
        if (arg.startsWith("--version=")) opts.version = arg.slice("--version=".length);
        else if (arg.startsWith("--dir=")) opts.dir = arg.slice("--dir=".length);
        else {
          console.error(pc.red(`✗ unknown option: ${arg}`));
          printUpdateHelp();
          return null;
        }
    }
  }
  return opts;
}

function printUpdateHelp(): void {
  console.log(`rossii update — install a newer release of rossii

Usage:
  rossii update [options]

Options:
  -c, --check          only report whether a newer release exists
      --pre            consider prereleases (the newest published release)
  -v, --version <tag>  install a specific release (e.g. 3.5.2 or v3.5.2)
  -d, --dir <path>     install into <path> (default: the running binary, else ~/.local/bin)
      --force          reinstall even when the version is the same or older
      --no-checksum    install without verifying SHA-256 (not recommended)
  -h, --help           show this help

Environment:
  ROSSII_INSTALL_DIR   same as --dir
  ROSSII_REPO          GitHub repo to update from (default: viorn/rossii)
  GITHUB_TOKEN         sent to the API when set (higher rate limit)`);
}

export async function runUpdate(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (!opts) return args.some((arg) => arg === "-h" || arg === "--help") ? 0 : 1;

  const installDir = opts.dir ?? process.env.ROSSII_INSTALL_DIR;
  const platform = releasePlatform();
  if (!platform) {
    console.error(pc.red(`✗ no ${process.platform}-${process.arch} build is published — releases carry linux-x86_64 only`));
    console.error(pc.dim("  build from source instead: git clone … && bash build.sh"));
    return 1;
  }

  let release: Release;
  try {
    release = await findRelease(opts);
  } catch (error) {
    console.error(pc.red(`✗ ${(error as Error).message}`));
    return 1;
  }

  const version = release.tag_name.replace(/^v/, "");
  const current = pkg.version;
  const comparison = compareVersions(version, current);

  console.log(`${pc.dim("installed:")} ${pc.cyan(current)}   ${pc.dim("available:")} ${pc.cyan(release.tag_name)}`);

  if (opts.check) {
    if (comparison > 0) console.log(pc.green(`✓ rossii ${version} is available — run \`rossii update\``));
    else console.log(pc.dim("· already up to date"));
    return 0;
  }

  // An explicitly pinned version installs even when it is the same or older;
  // an unpinned update only moves forward.
  if (comparison <= 0 && !opts.version && !opts.force) {
    console.log(pc.dim("· already up to date"));
    return 0;
  }

  const expectedName = assetName(version, platform.os, platform.arch);
  const legacyName = `cgoose-${version}-${platform.os}-${platform.arch}`;
  const asset = release.assets.find((candidate) =>
    candidate.name === expectedName || candidate.name === legacyName,
  );
  if (!asset) {
    console.error(pc.red(`✗ release ${release.tag_name} has no ${expectedName} asset`));
    return 1;
  }

  const target = resolveInstallTarget({
    dir: installDir,
    execPath: process.execPath,
    home: homedir(),
  });

  // Write next to the target, so the final rename is atomic and never crosses
  // a filesystem boundary.
  const temp = `${target}.new-${process.pid}`;
  try {
    mkdirSync(dirname(target), { recursive: true });

    console.log(pc.dim(`  downloading ${asset.name}…`));
    const response = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": `rossii/${pkg.version}` },
    });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    await Bun.write(temp, response);

    const actual = await sha256(temp);

    if (opts.noChecksum) {
      console.log(pc.yellow("⚠ checksum verification skipped (--no-checksum)"));
    } else {
      const expected = await expectedChecksum(release, asset);
      if (!expected.value) {
        throw new Error(
          `release ${release.tag_name} publishes no checksum for ${asset.name} — pass --no-checksum to install anyway`,
        );
      }
      if (actual !== expected.value) {
        throw new Error(`SHA-256 mismatch for ${asset.name}\n  expected ${expected.value}\n  actual   ${actual}`);
      }
      console.log(pc.dim(`  sha256 ok (${expected.source})`));
    }

    chmodSync(temp, 0o755);
    renameSync(temp, target);
  } catch (error) {
    if (existsSync(temp)) rmSync(temp, { force: true });
    console.error(pc.red(`✗ ${(error as Error).message}`));
    if ((error as NodeJS.ErrnoException).code === "EACCES") {
      console.error(pc.dim(`  ${target} is not writable — pass --dir <dir> or fix the permissions`));
    }
    return 1;
  }

  console.log(`\n  ${pc.green("✓")} rossii ${version} installed`);
  console.log(`    ${pc.dim("binary:")} ${target}`);

  const targetDir = dirname(target);
  const onPath = (process.env.PATH ?? "").split(":").includes(targetDir);
  if (target !== process.execPath && !onPath) {
    console.log(`\n  ${pc.yellow("⚠")} ${targetDir} is not in PATH`);
  }
  return 0;
}
