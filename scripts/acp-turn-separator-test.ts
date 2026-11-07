#!/usr/bin/env bun
/**
 * Unit tests for the turn separator (src/acp/turn-separator.ts).
 *
 * The dashed rule is the only visual boundary between two exchanges, so the
 * checks pin the three things that would make it wrong: it must fill exactly
 * the viewport width (an overlong line is clipped and eats the marker column),
 * it must be dashes rather than a solid rule, and it must not appear before the
 * first turn of a session.
 *
 * Usage: bun scripts/acp-turn-separator-test.ts
 */

import assert from "node:assert/strict";

import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { beginTurn, TurnSeparator } from "../src/acp/turn-separator";
import type { ChatContext } from "../src/acp/chat-context";

type Check = [name: string, run: () => void];

const checks: Check[] = [];
const ok = (name: string, fn: () => void) => checks.push([name, fn]);

/** Plain text of a rendered line (the rule is coloured). */
const plain = (line: string): string => stripTerminalSequences(line);

/** A context stub with only what `beginTurn` touches. */
const fakeCtx = (): ChatContext =>
  ({ transcript: new Container(), turnsStarted: 0 }) as unknown as ChatContext;

// ─── The line ───────────────────────────────────────────────────────────────

ok("one line, as wide as the viewport", () => {
  for (const width of [2, 12, 40, 80, 200]) {
    const lines = new TurnSeparator().render(width);
    assert.equal(lines.length, 1, `${width}: exactly one line`);
    assert.equal(visibleWidth(lines[0]!), width, `${width}: fills the width`);
  }
});

ok("it is a dashed rule, not a solid one", () => {
  const body = plain(new TurnSeparator().render(20)[0]!).trim();
  assert.ok(body.length > 0);
  assert.equal(new Set(body).size, 1, "a single repeated character");
  assert.equal(body[0], "┈", "the dash character");
});

ok("the rule sits at the transcript's indent", () => {
  const line = new TurnSeparator().render(20)[0]!;
  assert.equal(line.length - line.trimStart().length, 1, "one leading space");
});

ok("a viewport narrower than the indent renders an empty line", () => {
  assert.deepEqual(new TurnSeparator().render(1), [""]);
});

ok("invalidate is a no-op (the line has no state)", () => {
  const separator = new TurnSeparator();
  separator.invalidate();
  assert.equal(separator.render(10).length, 1);
});

// ─── Between turns only ─────────────────────────────────────────────────────

ok("the first turn of a session gets no separator", () => {
  const ctx = fakeCtx();
  const separator = beginTurn(ctx);
  assert.equal(separator, null);
  assert.equal(ctx.turnsStarted, 1);
  assert.equal(ctx.transcript.children.length, 0, "nothing was inserted");
});

ok("every later turn opens with one", () => {
  const ctx = fakeCtx();
  beginTurn(ctx); // first turn
  const second = beginTurn(ctx);
  assert.ok(second, "the second turn returns the separator");
  assert.equal(ctx.turnsStarted, 2);
  assert.deepEqual(ctx.transcript.children, [second]);

  const third = beginTurn(ctx);
  assert.ok(third);
  assert.equal(ctx.turnsStarted, 3);
  assert.deepEqual(ctx.transcript.children, [second, third]);
});

ok("the separator is inserted where the turn starts (in order)", () => {
  const ctx = fakeCtx();
  beginTurn(ctx);
  const marker = { render: () => ["❯ question"], invalidate: () => {} };
  ctx.transcript.addChild(marker);
  beginTurn(ctx);
  assert.equal(ctx.transcript.children.length, 2);
  assert.equal(ctx.transcript.children[0], marker);
  assert.ok(ctx.transcript.children[1] instanceof TurnSeparator, "the rule comes before the question");
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
