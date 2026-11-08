#!/usr/bin/env bun
/**
 * Unit tests for `rossii update` (src/update.ts).
 *
 * Only the pure part: version comparison, asset naming, checksum parsing and
 * the destination decision. The network path is exercised by hand —
 * `rossii update --check` and a real download into a temp `--dir`.
 *
 * Usage: bun scripts/update-test.ts   (or `bun run test`)
 */

import assert from "node:assert/strict";

import {
  assetName,
  compareVersions,
  normalizeTag,
  parseChecksum,
  parseVersion,
  releasePlatform,
  resolveInstallTarget,
} from "../src/update.ts";

type Check = [name: string, run: () => void];
const checks: Check[] = [];

checks.push(["parseVersion understands tags, releases and prereleases", () => {
  assert.deepEqual(parseVersion("3.5.2"), { core: [3, 5, 2], pre: null });
  assert.deepEqual(parseVersion("v3.5.2"), { core: [3, 5, 2], pre: null });
  assert.deepEqual(parseVersion("v3.5.2-rc.1"), { core: [3, 5, 2], pre: "rc.1" });
  assert.equal(parseVersion("3.5"), null);
  assert.equal(parseVersion("vNext"), null);
  assert.equal(parseVersion(""), null);
}]);

checks.push(["compareVersions orders releases and prereleases", () => {
  assert.ok(compareVersions("3.5.2", "3.5.1") > 0);
  assert.ok(compareVersions("3.5.1", "3.5.2") < 0);
  assert.equal(compareVersions("3.5.2", "v3.5.2"), 0);
  assert.ok(compareVersions("3.10.0", "3.9.9") > 0, "numeric, not string order");
  assert.ok(compareVersions("3.5.2", "3.5.2-rc.1") > 0, "a release beats its prerelease");
  assert.ok(compareVersions("3.5.2-rc.1", "3.5.2-rc.2") < 0);
}]);

checks.push(["normalizeTag adds the v prefix once", () => {
  assert.equal(normalizeTag("3.5.2"), "v3.5.2");
  assert.equal(normalizeTag("v3.5.2"), "v3.5.2");
  assert.equal(normalizeTag(" 3.5.2 "), "v3.5.2");
}]);

checks.push(["assetName matches the release naming", () => {
  assert.equal(assetName("3.5.2", "linux", "x86_64"), "rossii-3.5.2-linux-x86_64");
}]);

checks.push(["parseChecksum reads the first hash of a .sha256 file", () => {
  const hash = "7826ec0265883033985d755a5395cfae2dc65acd86a0ddcd0c1d12811d5494c9";
  assert.equal(parseChecksum(`${hash}  rossii-3.5.2-linux-x86_64\n`), hash);
  assert.equal(parseChecksum(`  ${hash.toUpperCase()} *rossii`), hash, "lowercased");
  assert.equal(parseChecksum("not a checksum"), null);
  assert.equal(parseChecksum(""), null);
}]);

checks.push(["resolveInstallTarget replaces a rossii binary, else uses ~/.local/bin", () => {
  const home = "/home/tester";
  assert.equal(
    resolveInstallTarget({ dir: "/opt/bin", execPath: "/usr/local/bin/rossii", home }),
    "/opt/bin/rossii",
    "--dir wins",
  );
  assert.equal(
    resolveInstallTarget({ execPath: "/usr/local/bin/rossii", home }),
    "/usr/local/bin/rossii",
    "a standalone binary updates itself",
  );
  assert.equal(
    resolveInstallTarget({ execPath: "/home/tester/.bun/bin/bun", home }),
    "/home/tester/.local/bin/rossii",
    "running from source installs to the conventional place",
  );
  assert.equal(
    resolveInstallTarget({ execPath: "/home/tester/bin/rossii-3.5.1-linux-x86_64", home }),
    "/home/tester/.local/bin/rossii",
    "a renamed release file does not overwrite itself",
  );
}]);

checks.push(["releasePlatform knows what is actually published", () => {
  assert.deepEqual(releasePlatform("linux", "x64"), { os: "linux", arch: "x86_64" });
  assert.deepEqual(releasePlatform("linux", "x86_64"), { os: "linux", arch: "x86_64" });
  assert.equal(releasePlatform("linux", "arm64"), null);
  assert.equal(releasePlatform("darwin", "x64"), null);
}]);

// ─── Runner ──────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ ${checks.length} checks passed`);
