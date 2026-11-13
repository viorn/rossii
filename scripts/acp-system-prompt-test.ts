#!/usr/bin/env bun
/**
 * Unit tests for `applySystemPrompt` (src/acp/chat-extensions.ts).
 *
 * The regression these pin: the legacy `cgoose` key was cleared with
 * `mode: "set"` + empty text. In `mode: "set"` goose ignores `key` and reads
 * empty text as "clear the override", so the cleanup wiped the prompt that had
 * just been applied — the set's system prompt never reached the agent and the
 * session row kept `system_prompt_override = NULL`.
 *
 * Usage: bun run test   (or `bun scripts/acp-system-prompt-test.ts`)
 */

import assert from "node:assert/strict";
import { applySystemPrompt } from "../src/acp/chat-extensions";
import { PROMPT_KEY, LEGACY_PROMPT_KEY } from "../src/acp/chat-context";

type Call = { method: string; params: any };

function fakeCtx(failOn?: string): { ctx: any; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (failOn && params.key === failOn) throw new Error("boom");
      return {};
    },
  };
  return { ctx: { client }, calls };
}

type Check = [name: string, run: () => Promise<void>];

const checks: Check[] = [
  ["the set's prompt goes out as mode=set", async () => {
    const { ctx, calls } = fakeCtx();
    await applySystemPrompt(ctx, "s1", "PROMPT");
    assert.equal(calls[0].method, "_goose/unstable/session/system-prompt/set");
    assert.equal(calls[0].params.mode, "set");
    assert.equal(calls[0].params.text, "PROMPT");
    assert.equal(calls[0].params.key, PROMPT_KEY);
  }],

  ["the legacy key is cleared with mode=append, never mode=set", async () => {
    const { ctx, calls } = fakeCtx();
    await applySystemPrompt(ctx, "s1", "PROMPT");
    const legacy = calls.filter((c) => c.params.key === LEGACY_PROMPT_KEY);
    assert.equal(legacy.length, 1, "the legacy key is cleared exactly once");
    assert.equal(legacy[0].params.mode, "append", "mode=set + empty text clears the override");
    assert.equal(legacy[0].params.text, "");
  }],

  ["no request clears the override after it was set", async () => {
    const { ctx, calls } = fakeCtx();
    await applySystemPrompt(ctx, "s1", "PROMPT");
    const clearing = calls.filter((c) => c.params.mode === "set" && c.params.text.trim() === "");
    assert.deepEqual(clearing, [], "an empty mode=set request wipes the prompt just applied");
  }],

  ["an empty prompt is still sent as mode=set (that is how None clears it)", async () => {
    const { ctx, calls } = fakeCtx();
    await applySystemPrompt(ctx, "s1", "");
    assert.equal(calls[0].params.mode, "set");
    assert.equal(calls[0].params.text, "");
  }],

  ["a failing legacy cleanup does not throw", async () => {
    const { ctx } = fakeCtx(LEGACY_PROMPT_KEY);
    await applySystemPrompt(ctx, "s1", "PROMPT");
  }],
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    await run();
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
