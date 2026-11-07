#!/usr/bin/env bun
/**
 * Unit tests for `ROSSII_ACP_BLOCKS` (src/acp/block-mode.ts).
 *
 * The setting picks one of four expand/collapse behaviours for the thought and
 * tool blocks. These checks pin the parser (words, the 1–4 digits, the warning
 * on a typo) and the two predicates the blocks consult — the per-mode rendering
 * is covered by acp-thought-test.ts / acp-tool-call-block-test.ts.
 *
 * Usage: bun scripts/acp-block-mode-test.ts
 */

import assert from "node:assert/strict";

import {
  BLOCK_MODE_ENV,
  DEFAULT_BLOCK_MODE,
  endsExpanded,
  parseBlockMode,
  startsExpanded,
  type BlockMode,
} from "../src/acp/block-mode";

type Check = [name: string, run: () => void];

const checks: Check[] = [];
const ok = (name: string, fn: () => void) => checks.push([name, fn]);

// ─── Defaults ───────────────────────────────────────────────────────────────

ok("unset means the quiet default (`closed`)", () => {
  assert.equal(DEFAULT_BLOCK_MODE, "closed");
  assert.deepEqual(parseBlockMode(undefined), { mode: "closed", invalid: null });
  assert.deepEqual(parseBlockMode(""), { mode: "closed", invalid: null });
  assert.deepEqual(parseBlockMode("   "), { mode: "closed", invalid: null });
});

// ─── Words ──────────────────────────────────────────────────────────────────

ok("the four names parse", () => {
  for (const mode of ["live", "open", "done", "closed"] as const) {
    assert.deepEqual(parseBlockMode(mode), { mode, invalid: null });
  }
});

ok("names are case-insensitive and trimmed", () => {
  assert.equal(parseBlockMode("  CLOSED ").mode, "closed");
  assert.equal(parseBlockMode("Done").mode, "done");
});

ok("the modes can be picked by their number", () => {
  const byNumber: Record<string, BlockMode> = { "1": "live", "2": "open", "3": "done", "4": "closed" };
  for (const [digit, mode] of Object.entries(byNumber)) {
    assert.deepEqual(parseBlockMode(digit), { mode, invalid: null });
  }
});

ok("the friendly aliases map onto the four modes", () => {
  assert.equal(parseBlockMode("expanded").mode, "open");
  assert.equal(parseBlockMode("finished").mode, "done");
  assert.equal(parseBlockMode("collapsed").mode, "closed");
});

// ─── Bad values ─────────────────────────────────────────────────────────────

ok("a typo falls back to the default and warns", () => {
  const { mode, invalid } = parseBlockMode("opne");
  assert.equal(mode, DEFAULT_BLOCK_MODE);
  assert.ok(invalid, "a warning is produced");
  assert.ok(invalid!.includes(BLOCK_MODE_ENV), "the warning names the setting");
  assert.ok(invalid!.includes("opne"), "the warning quotes the value");
  assert.ok(invalid!.includes("closed"), "the warning names the fallback");
});

ok("an out-of-range number warns too", () => {
  assert.equal(parseBlockMode("5").mode, DEFAULT_BLOCK_MODE);
  assert.ok(parseBlockMode("5").invalid);
  assert.ok(parseBlockMode("0").invalid);
});

// ─── The two predicates ─────────────────────────────────────────────────────

const MODES: BlockMode[] = ["live", "open", "done", "closed"];

ok("start expanded: live and open", () => {
  assert.deepEqual(MODES.map(startsExpanded), [true, true, false, false]);
});

ok("expanded when finished: open and done", () => {
  assert.deepEqual(MODES.map(endsExpanded), [false, true, true, false]);
});

ok("`open` and `closed` never change state", () => {
  for (const mode of ["open", "closed"] as const) {
    assert.equal(startsExpanded(mode), endsExpanded(mode), `${mode} keeps one state`);
  }
});

// ─── Run all checks ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}: ${err}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
