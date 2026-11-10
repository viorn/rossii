#!/usr/bin/env bun
/**
 * Unit tests for the chat watchdogs (src/acp/timeouts.ts, src/acp/timeout-state.ts).
 *
 * Pins the three things the chat now relies on:
 *   - **parsing**: `/timeout 30m`, `/timeout tool 1h`, `/timeout reset`, units
 *     required for anything but plain milliseconds;
 *   - **precedence**: environment > project file > set > built-in, and a
 *     malformed environment value falling through instead of pinning the guard
 *     to the built-in constant;
 *   - **the guard decision**: a permission prompt or a running tool call is not
 *     "the agent went silent" — the two false cancels the change exists for.
 *
 * No TUI, no goose, no `~/.config/rossii`: `buildTimeouts` takes the saved
 * values as an argument.
 *
 * Usage: bun scripts/acp-timeouts-test.ts
 */

import assert from "node:assert/strict";

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  IDLE_TIMEOUT_ENV,
  describeTimeout,
  formatDuration,
  parseTimeoutCommand,
  parseTimeoutSpec,
  planIdleAction,
  resolveTimeout,
  type IdleGuardInput,
  type ResolvedTimeout,
} from "../src/acp/timeouts";
import { buildTimeouts, timeoutWarnings } from "../src/acp/timeout-state";

type Check = [name: string, run: () => void];

const checks: Check[] = [];
const ok = (name: string, fn: () => void) => checks.push([name, fn]);

// ─── formatDuration ─────────────────────────────────────────────────────────

ok("formatDuration: 0 is 'off', and the units stay readable", () => {
  assert.equal(formatDuration(0), "off");
  assert.equal(formatDuration(-5), "off");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(300_000), "5m");
  assert.equal(formatDuration(5_400_000), "1h 30m");
  assert.equal(formatDuration(DEFAULT_TURN_TIMEOUT_MS), "4h");
  assert.equal(formatDuration(Number.NaN), "off");
});

// ─── parseTimeoutSpec ───────────────────────────────────────────────────────

ok("parseTimeoutSpec: units, plain milliseconds and off", () => {
  assert.deepEqual(parseTimeoutSpec("90s"), { ms: 90_000 });
  assert.deepEqual(parseTimeoutSpec("30m"), { ms: 1_800_000 });
  assert.deepEqual(parseTimeoutSpec("2h"), { ms: 7_200_000 });
  assert.deepEqual(parseTimeoutSpec("600000"), { ms: 600_000 });
  assert.deepEqual(parseTimeoutSpec("250ms"), { ms: 250 });
  assert.deepEqual(parseTimeoutSpec("1.5h"), { ms: 5_400_000 });
  assert.deepEqual(parseTimeoutSpec("off"), { ms: 0 });
  assert.deepEqual(parseTimeoutSpec(" OFF "), { ms: 0 });
});

ok("parseTimeoutSpec: junk is an error, not a silently wrong value", () => {
  for (const bad of ["", "  ", "soon", "5 minutes", "-30m", "m30"]) {
    const parsed = parseTimeoutSpec(bad);
    assert.ok("error" in parsed, `"${bad}" should not parse`);
  }
});

// ─── parseTimeoutCommand ────────────────────────────────────────────────────

ok("parseTimeoutCommand: bare value targets the idle guard", () => {
  assert.deepEqual(parseTimeoutCommand([]), { kind: "both", action: "show" });
  assert.deepEqual(parseTimeoutCommand(["30m"]), { kind: "idle", action: "set", ms: 1_800_000 });
});

ok("parseTimeoutCommand: `tool` targets the tool guard", () => {
  assert.deepEqual(parseTimeoutCommand(["tool", "1h"]), { kind: "tool", action: "set", ms: 3_600_000 });
  assert.deepEqual(parseTimeoutCommand(["idle", "90s"]), { kind: "idle", action: "set", ms: 90_000 });
});

ok("parseTimeoutCommand: reset targets one guard or both", () => {
  assert.deepEqual(parseTimeoutCommand(["reset"]), { kind: "both", action: "reset" });
  assert.deepEqual(parseTimeoutCommand(["reset", "tool"]), { kind: "tool", action: "reset" });
  assert.ok("error" in parseTimeoutCommand(["reset", "everything"]));
});

ok("parseTimeoutCommand: errors carry a usable hint", () => {
  const missing = parseTimeoutCommand(["tool"]);
  assert.ok("error" in missing && /needs a value/.test(missing.error));
  const junk = parseTimeoutCommand(["banana"]);
  assert.ok("error" in junk && /not a timeout/.test(junk.error));
});

// ─── Precedence ─────────────────────────────────────────────────────────────

const PROJECT_IDLE = 1_800_000;
const SET_IDLE = 3_600_000;

function idleWith(overrides: Partial<Parameters<typeof resolveTimeout>[0]>): ResolvedTimeout {
  return resolveTimeout({
    envName: IDLE_TIMEOUT_ENV,
    fallbackMs: DEFAULT_IDLE_TIMEOUT_MS,
    ...overrides,
  });
}

ok("precedence: the environment wins over the project and the set", () => {
  const resolved = idleWith({
    env: "600000",
    project: PROJECT_IDLE,
    set: SET_IDLE,
  });
  assert.equal(resolved.ms, 600_000);
  assert.equal(resolved.source, "env");
  assert.equal(resolved.env, IDLE_TIMEOUT_ENV);
  assert.deepEqual(resolved.overridden, { ms: PROJECT_IDLE, source: "project" });
});

ok("precedence: without the environment, the project file wins over the set", () => {
  const resolved = idleWith({ project: PROJECT_IDLE, set: SET_IDLE });
  assert.equal(resolved.ms, PROJECT_IDLE);
  assert.equal(resolved.source, "project");
  assert.equal(resolved.overridden, undefined);
});

ok("precedence: a set default applies only where nothing is saved", () => {
  const resolved = idleWith({ set: SET_IDLE });
  assert.equal(resolved.ms, SET_IDLE);
  assert.equal(resolved.source, "set");
});

ok("precedence: nothing set anywhere → the built-in default", () => {
  const resolved = idleWith({});
  assert.equal(resolved.ms, DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolved.source, "default");
});

ok("a malformed environment value is reported and does not win", () => {
  const resolved = idleWith({ env: "5m", project: PROJECT_IDLE });
  assert.equal(resolved.ms, PROJECT_IDLE, "the saved value applies instead of the default");
  assert.equal(resolved.source, "project");
  assert.match(String(resolved.invalid), /ROSSII_ACP_IDLE_TIMEOUT_MS="5m"/);
  assert.match(String(resolved.invalid), /ignored/);
});

ok("an explicit 0 from the environment disables the guard (the 'just this run' switch)", () => {
  const resolved = idleWith({ env: "0", project: PROJECT_IDLE });
  assert.equal(resolved.ms, 0);
  assert.equal(resolved.source, "env");
});

ok("buildTimeouts: reads the environment through the layer helper", () => {
  const state = buildTimeouts(undefined, {});
  assert.equal(state.idle.ms, DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(state.tool.ms, DEFAULT_TOOL_TIMEOUT_MS);
  assert.equal(state.turn.ms, DEFAULT_TURN_TIMEOUT_MS);
  assert.equal(state.idle.source, "default");
});

// ─── describeTimeout / warnings ─────────────────────────────────────────────

ok("describeTimeout: names the layer, and what the environment shadows", () => {
  assert.equal(describeTimeout(idleWith({})), "5m (default)");
  assert.equal(describeTimeout(idleWith({ project: PROJECT_IDLE })), "30m (project)");
  assert.equal(
    describeTimeout(idleWith({ env: "600000", project: PROJECT_IDLE })),
    `10m (env ${IDLE_TIMEOUT_ENV}; project 30m is ignored)`,
  );
  assert.equal(
    describeTimeout(idleWith({ env: "1800000", project: PROJECT_IDLE })),
    `30m (env ${IDLE_TIMEOUT_ENV})`,
    "the same value is not reported as ignored",
  );
});

ok("timeoutWarnings: a typo and an environment override are both spoken out loud", () => {
  const typo = timeoutWarnings({
    idle: idleWith({ env: "5m" }),
    tool: idleWith({}),
    turn: idleWith({}),
  });
  assert.equal(typo.length, 1);
  assert.match(typo[0], /not a non-negative number/);

  const shadow = timeoutWarnings({
    idle: idleWith({ env: "600000", project: PROJECT_IDLE }),
    tool: idleWith({}),
    turn: idleWith({}),
  });
  assert.equal(shadow.length, 1);
  assert.match(shadow[0], /comes from ROSSII_ACP_IDLE_TIMEOUT_MS/);
  assert.match(shadow[0], /overrides \/timeout/);

  assert.deepEqual(
    timeoutWarnings({ idle: idleWith({}), tool: idleWith({}), turn: idleWith({}) }),
    [],
    "a plain default says nothing",
  );
});

// ─── planIdleAction ─────────────────────────────────────────────────────────

const NOW = 10_000_000;

function guard(overrides: Partial<IdleGuardInput> = {}): IdleGuardInput {
  return {
    now: NOW,
    lastActivity: NOW - 6 * 60_000, // six silent minutes: past the 5 min idle guard
    busy: true,
    hasSession: true,
    exiting: false,
    agentDead: false,
    cancelRequested: false,
    awaitingUser: false,
    runningTool: null,
    idleMs: DEFAULT_IDLE_TIMEOUT_MS,
    toolMs: DEFAULT_TOOL_TIMEOUT_MS,
    ...overrides,
  };
}

ok("planIdleAction: real silence cancels the turn", () => {
  const decision = planIdleAction(guard());
  assert.equal(decision.kind, "cancel");
  assert.match(
    "reason" in decision ? decision.reason : "",
    /no agent activity for 6m — cancelling the turn/,
  );
});

ok("planIdleAction: a permission prompt left open is not silence", () => {
  assert.deepEqual(planIdleAction(guard({ awaitingUser: true })), { kind: "wait" });
});

ok("planIdleAction: a running tool uses its own, larger threshold", () => {
  // The `sleep 600` case: six silent minutes while the block is still pending —
  // the idle guard must not read that as a dead agent.
  assert.deepEqual(planIdleAction(guard({ runningTool: "sleep 600" })), { kind: "wait" });

  // ...but a tool that has been silent past its own threshold is a real hang.
  const overdue = planIdleAction(
    guard({ runningTool: "sleep 600", lastActivity: NOW - 31 * 60_000 }),
  );
  assert.equal(overdue.kind, "cancel");
  assert.match(
    "reason" in overdue ? overdue.reason : "",
    /tool "sleep 600" produced no output for 31m — cancelling the turn/,
  );
});

ok("planIdleAction: toolMs = 0 leaves only the hard cap", () => {
  assert.deepEqual(
    planIdleAction(guard({ runningTool: "sleep 600", toolMs: 0, lastActivity: NOW - 3 * 3_600_000 })),
    { kind: "wait" },
  );
});

ok("planIdleAction: idleMs = 0 leaves only the hard cap", () => {
  assert.deepEqual(planIdleAction(guard({ idleMs: 0, lastActivity: NOW - 3 * 3_600_000 })), { kind: "wait" });
});

ok("planIdleAction: an idle chat, a dead agent or a cancelled turn never fire", () => {
  assert.deepEqual(planIdleAction(guard({ busy: false })), { kind: "wait" });
  assert.deepEqual(planIdleAction(guard({ hasSession: false })), { kind: "wait" });
  assert.deepEqual(planIdleAction(guard({ agentDead: true })), { kind: "wait" });
  assert.deepEqual(planIdleAction(guard({ exiting: true })), { kind: "wait" });
  assert.deepEqual(planIdleAction(guard({ cancelRequested: true })), { kind: "wait" });
});

// ─── Runner ─────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${String((error as Error)?.message ?? error)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ watchdogs: ${checks.length} checks passed (parsing, precedence, guard decisions)`);
