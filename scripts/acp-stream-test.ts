#!/usr/bin/env bun
/**
 * Regression tests for the streaming renderer (src/acp/chat-stream.ts).
 *
 * The bug this pins: goose sends whitespace-only `agent_message_chunk`s (a
 * plain "\n\n") between a tool call and the text that follows it. Each chunk
 * used to open an `❮ Answer · 0 chars` block, so the transcript filled with
 * empty answers. The block is now created only on the first *visible* chunk;
 * a message that never produces one stays hidden.
 *
 * No agent and no terminal: `handleSessionUpdate` is driven with a fake
 * ChatContext whose transcript is a real pi-tui Container.
 *
 * Usage: bun scripts/acp-stream-test.ts   (or `bun run test`)
 */

import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";

import { closeMessage, flushStream, handleSessionUpdate, hasVisibleAnswerText } from "../src/acp/chat-stream.ts";
import type { ChatContext } from "../src/acp/chat-context.ts";
import type { SessionNotification } from "../src/acp/types.ts";

// ─── Fixture ─────────────────────────────────────────────────────────────────

interface FakeContext {
  transcript: Container;
  renderCount: number;
}

/** Just enough of a ChatContext for the agent-message paths. */
function makeContext(): { ctx: ChatContext; fake: FakeContext } {
  const transcript = new Container();
  const fake: FakeContext = { transcript, renderCount: 0 };
  const ctx = {
    transcript,
    tui: { requestRender: () => { fake.renderCount++; } },
    lastAgentActivity: 0,
    // Streaming state
    currentMd: null,
    currentMessageId: null,
    streamBuffer: "",
    pendingAnswer: "",
    answerLabelLine: null,
    answerChars: 0,
    // Closers
    currentThought: null,
    thoughtBlocks: [],
    userLine: null,
    userBuffer: "",
    userMessageId: null,
    // Tool calls
    toolCallBlocks: new Map(),
    toolBlocks: [],
    blockMode: "closed",
    altScreen: true,
    busy: false,
  } as unknown as ChatContext;
  return { ctx, fake };
}

/** Deliver one `session/update` notification. */
function send(ctx: ChatContext, update: Record<string, unknown>): void {
  handleSessionUpdate(ctx, { update } as unknown as SessionNotification);
}

function textChunk(ctx: ChatContext, text: string, messageId = "m1"): void {
  send(ctx, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });
}

/** The markdown currently in the block (the repaint itself is throttled). */
function answerText(ctx: ChatContext): string {
  flushStream(ctx, true);
  return (ctx.currentMd as any)?.text ?? "";
}

// ─── Checks ──────────────────────────────────────────────────────────────────

type Check = [name: string, run: () => void];
const checks: Check[] = [];

checks.push(["hasVisibleAnswerText ignores whitespace and zero-width characters", () => {
  assert.equal(hasVisibleAnswerText(""), false);
  assert.equal(hasVisibleAnswerText("\n\n"), false);
  assert.equal(hasVisibleAnswerText("   \t\r\n"), false);
  assert.equal(hasVisibleAnswerText("\u200b\ufeff"), false);
  assert.equal(hasVisibleAnswerText("ok"), true);
  assert.equal(hasVisibleAnswerText("\n\nok"), true);
}]);

checks.push(["a whitespace-only message creates no answer block", () => {
  const { ctx, fake } = makeContext();
  textChunk(ctx, "\n\n");
  closeMessage(ctx);
  assert.equal(fake.transcript.children.length, 0, "no empty answer may be added");
  assert.equal(ctx.currentMd, null);
  assert.equal(ctx.answerLabelLine, null);
}]);

checks.push(["whitespace before the first visible chunk is buffered, not shown alone", () => {
  const { ctx, fake } = makeContext();
  textChunk(ctx, "\n\n");
  assert.equal(fake.transcript.children.length, 0, "still nothing to render");

  textChunk(ctx, "Hello");
  assert.equal(fake.transcript.children.length, 1);
  assert.equal(answerText(ctx), "\n\nHello", "the buffered separator is kept in order");
  assert.equal(ctx.answerChars, 7);
  assert.match((ctx.answerLabelLine as any).text, /7 chars/);
}]);

checks.push(["an empty message before a tool call leaves no answer behind", () => {
  const { ctx, fake } = makeContext();
  textChunk(ctx, "\n\n");
  send(ctx, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "shell",
    status: "in_progress",
    rawInput: { command: "ls" },
  });

  assert.equal(fake.transcript.children.length, 1, "only the tool block");
  assert.equal(ctx.currentMd, null, "the answer was closed empty");
  assert.equal(ctx.pendingAnswer, "", "nothing is left over for the next message");
}]);

checks.push(["a new messageId drops the buffered whitespace of the previous one", () => {
  const { ctx, fake } = makeContext();
  textChunk(ctx, "\n\n", "m1");
  textChunk(ctx, "Hi", "m2");

  assert.equal(fake.transcript.children.length, 1);
  assert.equal(answerText(ctx), "Hi", "the empty message must not prefix the next answer");
}]);

checks.push(["whitespace between two visible chunks stays inside one answer", () => {
  const { ctx, fake } = makeContext();
  textChunk(ctx, "Hello");
  textChunk(ctx, "\n\n");
  textChunk(ctx, "world");

  assert.equal(fake.transcript.children.length, 1);
  assert.equal(answerText(ctx), "Hello\n\nworld");
  assert.equal(ctx.answerChars, 12);
}]);

checks.push(["the empty-answer guard does not swallow a real answer after a tool call", () => {
  const { ctx, fake } = makeContext();
  textChunk(ctx, "\n\n");
  send(ctx, { sessionUpdate: "tool_call", toolCallId: "t1", title: "shell", status: "in_progress" });
  textChunk(ctx, "\n\nDone.");
  closeMessage(ctx);

  assert.equal(fake.transcript.children.length, 2, "tool block + one answer");
  assert.equal(ctx.currentMd, null);

  const answer = fake.transcript.children[1] as Container;
  assert.equal(answer.children.length, 2, "label + markdown");
  assert.equal((answer.children[1] as any).text, "\n\nDone.");
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
