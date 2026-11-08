/**
 * `rossii doctor` — one screen that answers "why is this not working?".
 *
 * Everything reported here is read the same way the launcher and the chat read
 * it: the same config files, the same env helpers, the same `bun:sqlite`
 * reader. It never writes anything (the sessions DB is opened read-only).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import pc from "picocolors";

import pkg from "../package.json";
import { env } from "./utils";
import { getConfigProviders, getDiscoveredCustomProviders, getGooseConfigPath } from "./config";
import { getRossiiPaths, listSessionSets, readRossiiConfig } from "./rossii-config";
import { getAllSessions, getSessionsDbPath } from "./sessions";
import { getRepoRoot, getWorktreeSessionNames, getWorktreeState, isInsideGitRepo } from "./worktree";
import { parseBlockMode, BLOCK_MODE_ENV } from "./acp/block-mode";
import {
  resolveTimeoutMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  IDLE_TIMEOUT_ENV,
  TURN_TIMEOUT_ENV,
} from "./acp/timeouts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sh(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function line(label: string, value: string): void {
  console.log(`  ${pc.dim(label.padEnd(10))} ${value}`);
}

function ok(value: string): string {
  return `${pc.green("✓")} ${value}`;
}

function bad(value: string): string {
  return `${pc.red("✗")} ${value}`;
}

function warn(value: string): string {
  return `${pc.yellow("⚠")} ${value}`;
}

function pathState(path: string): string {
  return existsSync(path) ? ok(path) : warn(`${path} (missing)`);
}

/** Child-process settings that are validated when the chat starts — validate
 *  them here too, so a typo is visible without opening a session. */
function configWarnings(): string[] {
  const warnings: string[] = [];

  const mode = (env("ACP_MODE") ?? "").trim().toLowerCase();
  if (mode && !["acp", "chat", "1", "on", "true", "yes", "classic", "session", "0", "off", "false", "no"].includes(mode)) {
    warnings.push(`ROSSII_ACP_MODE="${mode}" is not recognised — ACP (chat) mode will be used`);
  }

  const blocks = parseBlockMode(env("ACP_BLOCKS"));
  if (blocks.invalid) warnings.push(blocks.invalid);

  const steer = env("ACP_STEER");
  if (steer !== undefined && steer !== "0" && steer !== "1") {
    warnings.push(`ROSSII_ACP_STEER="${steer}" is not 0 or 1 — steering stays on`);
  }

  for (const [raw, fallback, name] of [
    [env("ACP_IDLE_TIMEOUT_MS"), DEFAULT_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_ENV],
    [env("ACP_PROMPT_TIMEOUT_MS"), DEFAULT_TURN_TIMEOUT_MS, TURN_TIMEOUT_ENV],
  ] as const) {
    const resolved = resolveTimeoutMs(raw, fallback, name);
    if (resolved.invalid) warnings.push(resolved.invalid);
  }

  if (env("NO_WORKTREE") === "1" && env("FORCE_WORKTREE") === "1") {
    warnings.push("ROSSII_NO_WORKTREE=1 and ROSSII_FORCE_WORKTREE=1 are both set — the force flag wins");
  }

  const legacy = Object.keys(process.env)
    .filter((key) => key.startsWith("CGOOSE_"))
    .map((key) => key);
  if (legacy.length > 0) {
    warnings.push(`legacy settings in use: ${legacy.join(", ")} (ROSSII_* wins)`);
  }

  return warnings;
}

/** `ROSSII_*` values that are actually set in this shell. */
function envSettings(): string[] {
  return Object.keys(process.env)
    .filter((key) => key.startsWith("ROSSII_") || key.startsWith("CGOOSE_"))
    .sort()
    .map((key) => `${key}=${process.env[key]}`);
}

// ─── Doctor ──────────────────────────────────────────────────────────────────

/** Print the diagnostic report. Returns the process exit code. */
export function runDoctor(): number {
  console.log(`\n  ${pc.green("🪿 rossii doctor")}\n`);

  // ── Runtime ──────────────────────────────────────────────────────────────
  line("rossii", `${pkg.version} ${pc.dim(`· bun ${Bun.version} · ${process.platform} ${process.arch}`)}`);

  // ── goose ────────────────────────────────────────────────────────────────
  const gooseVersion = sh("goose", ["--version"])?.split("\n")[0] ?? null;
  if (!gooseVersion) {
    line("goose", bad("not found on PATH — install it before running rossii"));
    console.log(`\n  ${pc.dim("Everything else is skipped: rossii launches goose.")}\n`);
    return 1;
  }
  line("goose", ok(gooseVersion));

  const acp = sh("goose", ["acp", "--help"]) !== null;
  line("acp", acp
    ? ok("supported (chat mode)")
    : warn("not supported by this goose — rossii falls back to the classic TUI"));

  // ── goose config / providers ─────────────────────────────────────────────
  const gooseConfig = getGooseConfigPath();
  line("config", pathState(gooseConfig));

  let providers: string[] = [];
  try {
    const configured = getConfigProviders();
    const discovered = getDiscoveredCustomProviders(configured);
    providers = [...configured, ...discovered].map((p) => p.name);
  } catch { /* unreadable config is reported through the path line above */ }
  line("providers", providers.length > 0
    ? `${providers.length} (${providers.join(", ")})`
    : warn("none — run `goose configure` first"));

  // ── rossii config / sets ─────────────────────────────────────────────────
  const paths = getRossiiPaths();
  line("rossii cfg", pathState(paths.configPath));
  const rossiiConfig = readRossiiConfig();
  line("mode", `${rossiiConfig.default_mode} ${pc.dim("(default_mode in config.json; -m / -w override)")}`);

  let sets: string[] = [];
  try {
    sets = Object.keys(listSessionSets());
  } catch { /* reported as empty */ }
  line("sets", sets.length > 0 ? `${sets.length} (${sets.join(", ")})` : pc.dim("none"));

  // ── sessions DB ──────────────────────────────────────────────────────────
  const db = getSessionsDbPath();
  if (!existsSync(db)) {
    line("sessions", warn(`${db} (missing — no sessions yet)`));
  } else {
    const sessions = getAllSessions();
    const byType = sessions.reduce<Record<string, number>>((acc, s) => {
      const type = s.session_type ?? "user";
      acc[type] = (acc[type] ?? 0) + 1;
      return acc;
    }, {});
    const counts = Object.entries(byType)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, n]) => `${type} ${n}`)
      .join(", ");
    line("sessions", `${ok(db)} ${pc.dim(`— ${sessions.length} visible (${counts || "none"})`)}`);
    line("", pc.dim("read with bun:sqlite, no external sqlite3 needed"));
  }

  // ── worktrees ────────────────────────────────────────────────────────────
  if (!isInsideGitRepo()) {
    line("worktree", pc.dim("not a git repository — sessions run in the current directory"));
  } else {
    const repoRoot = getRepoRoot() ?? "?";
    const names = getWorktreeSessionNames();
    const dirty = names.filter((name) => getWorktreeState(name)?.dirty);
    line("worktree", `${ok(repoRoot)} ${pc.dim(`— ${names.length} session worktree(s)`)}`);
    if (dirty.length > 0) {
      line("", warn(`uncommitted changes: ${dirty.join(", ")} (deletion will ask first)`));
    }
  }

  // ── env ──────────────────────────────────────────────────────────────────
  const settings = envSettings();
  line("env", settings.length > 0
    ? settings.join("\n               ")
    : pc.dim("none set — defaults apply"));

  // ── warnings ─────────────────────────────────────────────────────────────
  const warnings = configWarnings();
  if (warnings.length > 0) {
    console.log();
    for (const warning of warnings) line("warning", warn(warning));
  } else {
    line("warnings", pc.dim("none"));
  }

  console.log(`\n  ${pc.dim("block mode:")} ${parseBlockMode(env("ACP_BLOCKS")).mode}  ` +
    `${pc.dim(`(${BLOCK_MODE_ENV}; live|open|done|closed)`)}\n`);

  return 0;
}
