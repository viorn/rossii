/**
 * Effective watchdog values for a chat: which layer won, and what to say about
 * it (`/timeout`, the start-up banner, `rossii doctor`).
 *
 * `./timeouts.ts` is the pure part (parsing, precedence, the guard decision);
 * this module is the only place that knows the *sources* — the environment, the
 * per-project file written by `/timeout` (`../project.ts`) and the session set
 * (`../rossii-config.ts`). Keeping it out of `chat-context.ts` means the doctor
 * can print exactly what the chat would do without booting a TUI.
 */

import { env, envVarName } from "../utils";
import { readProjectTimeouts, type ProjectTimeouts } from "../project";
import type { SessionSet } from "../rossii-config";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  IDLE_TIMEOUT_ENV,
  TOOL_TIMEOUT_ENV,
  TURN_TIMEOUT_ENV,
  formatDuration,
  resolveTimeout,
  type ResolvedTimeout,
} from "./timeouts";
import type { ChatContext } from "./chat-context";

export interface TimeoutsState {
  idle: ResolvedTimeout;
  tool: ResolvedTimeout;
  turn: ResolvedTimeout;
}

/** The project's saved values; an unreadable file just means "nothing saved". */
function readSaved(): ProjectTimeouts {
  try {
    return readProjectTimeouts();
  } catch {
    return {};
  }
}

/** The variable spelling actually present, falling back to the canonical one. */
function envName(name: string, fallback: string): string {
  return envVarName(name) ?? fallback;
}

/**
 * Resolve the three values: environment > project file > set > default.
 *
 * `saved` is a parameter so the test can pin the precedence without touching
 * `~/.config/rossii`.
 */
export function buildTimeouts(set?: SessionSet, saved: ProjectTimeouts = readSaved()): TimeoutsState {
  return {
    idle: resolveTimeout({
      env: env("ACP_IDLE_TIMEOUT_MS"),
      envName: envName("ACP_IDLE_TIMEOUT_MS", IDLE_TIMEOUT_ENV),
      project: saved.idleMs,
      set: set?.idleTimeoutMs,
      fallbackMs: DEFAULT_IDLE_TIMEOUT_MS,
    }),
    tool: resolveTimeout({
      env: env("ACP_TOOL_TIMEOUT_MS"),
      envName: envName("ACP_TOOL_TIMEOUT_MS", TOOL_TIMEOUT_ENV),
      project: saved.toolMs,
      set: set?.toolMs,
      fallbackMs: DEFAULT_TOOL_TIMEOUT_MS,
    }),
    turn: resolveTimeout({
      env: env("ACP_PROMPT_TIMEOUT_MS"),
      envName: envName("ACP_PROMPT_TIMEOUT_MS", TURN_TIMEOUT_ENV),
      fallbackMs: DEFAULT_TURN_TIMEOUT_MS,
    }),
  };
}

/** Read the values already on the context (no re-resolution). */
export function currentTimeouts(ctx: ChatContext): TimeoutsState {
  return { idle: ctx.idleTimeout, tool: ctx.toolTimeout, turn: ctx.turnTimeout };
}

/**
 * Re-resolve the context after something changed a layer: `/timeout` saved a
 * value, or `/set` brought another set's default. No re-arming is needed — the
 * watchdog compares the context's current thresholds on every tick.
 */
export function resyncTimeouts(ctx: ChatContext): TimeoutsState {
  const next = buildTimeouts(ctx.currentSet);
  ctx.idleTimeout = next.idle;
  ctx.toolTimeout = next.tool;
  ctx.turnTimeout = next.turn;
  return next;
}

/** An environment value that wins over what the user (or the set) saved. */
function envNote(label: string, resolved: ResolvedTimeout): string | null {
  if (resolved.source !== "env" || !resolved.env) return null;
  const ignored =
    resolved.overridden && resolved.overridden.ms !== resolved.ms
      ? ` (the ${resolved.overridden.source}'s ${formatDuration(resolved.overridden.ms)} is ignored)`
      : "";
  return `${label} timeout ${formatDuration(resolved.ms)} comes from ${resolved.env} and overrides /timeout${ignored}`;
}

/**
 * Everything the chat and `rossii doctor` say about the watchdog settings: a
 * typo in one of the variables, and a variable that shadows a saved value.
 */
export function timeoutWarnings(state: TimeoutsState): string[] {
  const warnings: string[] = [];
  for (const resolved of [state.idle, state.tool, state.turn]) {
    if (resolved.invalid) warnings.push(resolved.invalid);
  }
  const idle = envNote("idle", state.idle);
  if (idle) warnings.push(idle);
  const tool = envNote("tool", state.tool);
  if (tool) warnings.push(tool);
  return warnings;
}
