/**
 * The dashed line that separates one turn of the conversation from the next.
 *
 * A transcript of a long session became a wall of `❯ question` / answer / bars
 * with nothing to say where one exchange ended and the next began. Every turn
 * now opens with a dim dashed rule, so the eye can find the question that
 * belongs to an answer:
 *
 *   ❯ first question
 *   answer…
 *   ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
 *   ❯ second question
 *
 * Only between turns — the first exchange of a session starts right under the
 * startup hints, where a rule would separate nothing. `beginTurn()` counts the
 * turns, so the same rule appears on a replayed history (`session/load`): the
 * resumed conversation looks like the one that was left behind.
 *
 * The line is a `Component` rather than a `Text` because only `render(width)`
 * knows how wide the transcript is: the alternate screen and the inline
 * renderer have different widths, and the width changes on a terminal resize.
 */

import pc from "picocolors";
import type { Component } from "@earendil-works/pi-tui";

import type { ChatContext } from "./chat-context";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Box-drawing "light quadruple dash horizontal" — a dash, not a solid rule. */
const DASH = "┈";

/**
 * Left indent of the line — the column the transcript's blocks use, so the rule
 * starts where the `❯` marker does instead of touching the viewport edge.
 */
const INDENT = 1;

/**
 * Dim gray (256-colour 242), darker than the thought/tool text (248) but still
 * readable on a dark and a light background, so the rule reads as "half
 * transparent" and never competes with the conversation. Raw escape codes so it
 * still respects `NO_COLOR`/non-TTY output.
 */
const RULE_COLOR = pc.isColorSupported ? "\x1b[38;5;242m" : "";
const RESET = pc.isColorSupported ? "\x1b[0m" : "";

// ─── Component ───────────────────────────────────────────────────────────────

/** One dim dashed line, as wide as the transcript. */
export class TurnSeparator implements Component {
  render(width: number): string[] {
    // A viewport narrower than the indent gets an empty line: the alternate
    // screen clips an overlong line at the right edge, and a dash hanging over
    // the edge would eat the marker column instead.
    const inner = Math.max(0, width - INDENT);
    if (inner === 0) return [""];
    return [" ".repeat(INDENT) + `${RULE_COLOR}${DASH.repeat(inner)}${RESET}`];
  }

  /** Nothing to invalidate: the line has no state of its own. */
  invalidate(): void {}
}

/**
 * Open a new turn: draw the separator (except before the first one) and count
 * the turn. Returns the separator component so a caller — the replay path, which
 * may have to drop it again — can undo the insert.
 */
export function beginTurn(ctx: ChatContext): TurnSeparator | null {
  const separator = ctx.turnsStarted > 0 ? new TurnSeparator() : null;
  if (separator) ctx.transcript.addChild(separator);
  ctx.turnsStarted += 1;
  return separator;
}
