/**
 * Watchdog configuration for a chat turn.
 *
 * A `session/prompt` has no natural deadline — the agent may legitimately work
 * for a long time — so the chat runs two independent guards instead of one
 * wall-clock timer on the whole request:
 *
 *  - **idle** (`ROSSII_ACP_IDLE_TIMEOUT_MS`, default 5 min): no `session/update`
 *    from the agent for this long → the turn is cancelled with `session/cancel`.
 *  - **tool** (`ROSSII_ACP_TOOL_TIMEOUT_MS`, default 30 min): the same, but
 *    while a tool call is still running. A shell command that prints nothing
 *    for ten minutes is *not* a hung agent — goose's own shell even accepts
 *    `timeout_secs` for exactly that — so the idle guard must not read that
 *    silence as a dead turn. `0` falls back to the hard cap below.
 *  - **hard** (`ROSSII_ACP_PROMPT_TIMEOUT_MS`, default 4 h): absolute cap on a
 *    single turn — the last resort against an agent that keeps streaming
 *    updates forever without finishing. Passing it to `AcpClient.prompt` also
 *    makes the client send `session/cancel` on timeout.
 *
 * For the first two, an explicit `0` disables the guard. A malformed value
 * (e.g. a typo like `ROSSII_ACP_IDLE_TIMEOUT_MS=5m`) falls back to the next
 * layer **and returns a warning** — the chat shows it, instead of silently
 * disabling the guard.
 *
 * Where a value comes from (strongest first): the environment, the value saved
 * for this project (`~/.config/rossii/projects/<dir>-<hash>.json`, written by
 * `/timeout`), the session set's own default, then the built-in constant. The
 * environment wins on purpose — `ROSSII_ACP_IDLE_TIMEOUT_MS=0 rossii` is the
 * "just this run" switch and must not be overridden by a saved value — and the
 * chat says out loud when it does.
 *
 * The module is pure (no TUI, no fs) so the parsing, the precedence and the
 * guard decision are unit-tested in `scripts/acp-timeouts-test.ts`; the layer
 * wiring lives in `./timeout-state.ts`.
 */

export const IDLE_TIMEOUT_ENV = "ROSSII_ACP_IDLE_TIMEOUT_MS";
export const TURN_TIMEOUT_ENV = "ROSSII_ACP_PROMPT_TIMEOUT_MS";
export const TOOL_TIMEOUT_ENV = "ROSSII_ACP_TOOL_TIMEOUT_MS";

/** Silence from the agent after which the current turn is cancelled. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Absolute cap on a single turn (does not reset on activity). */
export const DEFAULT_TURN_TIMEOUT_MS = 4 * 60 * 60_000;
/** Silence allowed while a tool call is still running. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60_000;

/** Where an effective value came from. */
export type TimeoutSource = "env" | "project" | "set" | "default";

export interface ResolvedTimeout {
  /** Milliseconds; `0` means "no limit". */
  ms: number;
  /** Human-readable warning when an environment value was unusable, else null. */
  invalid: string | null;
  source: TimeoutSource;
  /** The variable that supplied the value (`source === "env"`). */
  env?: string;
  /** A saved value the environment is shadowing, when one is configured. */
  overridden?: { ms: number; source: "project" | "set" };
}

export interface TimeoutLayers {
  /** Raw environment value: plain milliseconds (undefined/"" = not set). */
  env?: string;
  /** Variable name for messages (`ROSSII_…` or the legacy `CGOOSE_…`). */
  envName: string;
  /** Value saved for this project, from `/timeout`. */
  project?: number;
  /** Value the session set declares. */
  set?: number;
  fallbackMs: number;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

function savedLayer(layers: TimeoutLayers): { ms: number; source: "project" | "set" } | null {
  if (typeof layers.project === "number") return { ms: layers.project, source: "project" };
  if (typeof layers.set === "number") return { ms: layers.set, source: "set" };
  return null;
}

/**
 * Pick the effective value from the four layers.
 *
 * The environment wins when it parses; a *malformed* environment value never
 * wins — it is reported in `invalid` and the saved layers (or the default) apply
 * instead, so one typo cannot pin the guard to the built-in value forever.
 */
export function resolveTimeout(layers: TimeoutLayers): ResolvedTimeout {
  const raw = layers.env?.trim();
  const saved = savedLayer(layers);
  const fallback: ResolvedTimeout = saved
    ? { ms: saved.ms, invalid: null, source: saved.source }
    : { ms: layers.fallbackMs, invalid: null, source: "default" };

  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      ...fallback,
      invalid: `${layers.envName}="${layers.env}" is not a non-negative number — ignored, using ${formatDuration(fallback.ms)}`,
    };
  }
  return {
    ms: parsed,
    invalid: null,
    source: "env",
    env: layers.envName,
    ...(saved ? { overridden: saved } : {}),
  };
}

/**
 * Single-layer resolve (environment or default) — kept for callers that only
 * have an environment value, and for the offline transport test.
 */
export function resolveTimeoutMs(
  raw: string | undefined,
  fallbackMs: number,
  envName: string,
): ResolvedTimeout {
  return resolveTimeout({ env: raw, envName, fallbackMs });
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** `0` → "off", `300000` → "5m", `5400000` → "1h 30m", `45000` → "45s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "off";
  if (ms >= 3_600_000) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.round((ms % 3_600_000) / 60_000);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms)}ms`;
}

/** One line about an effective value and its origin, for `/timeout` and `doctor`. */
export function describeTimeout(resolved: ResolvedTimeout): string {
  const value = formatDuration(resolved.ms);
  if (resolved.source === "env") {
    const ignored =
      resolved.overridden && resolved.overridden.ms !== resolved.ms
        ? `; ${resolved.overridden.source} ${formatDuration(resolved.overridden.ms)} is ignored`
        : "";
    return `${value} (env ${resolved.env}${ignored})`;
  }
  return `${value} (${resolved.source})`;
}

// ─── `/timeout` parsing ──────────────────────────────────────────────────────

/**
 * Parse one timeout value: `off`, `90s`, `30m`, `2h`, `600000` (plain
 * milliseconds). Units are required for anything but milliseconds so `600`
 * cannot quietly mean ten minutes.
 */
export function parseTimeoutSpec(raw: string): { ms: number } | { error: string } {
  const text = raw.trim().toLowerCase();
  if (!text) {
    return { error: "expected a value: 90s, 30m, 2h, 600000 (milliseconds) or off" };
  }
  if (["off", "none", "no", "never"].includes(text)) return { ms: 0 };

  const withUnit = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
  if (withUnit) {
    const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
    const unit = withUnit[2] as keyof typeof factors;
    return { ms: Math.round(Number(withUnit[1]) * factors[unit]) };
  }
  if (/^\d+$/.test(text)) return { ms: Number(text) };

  return { error: `"${raw.trim()}" is not a timeout — use 90s, 30m, 2h, 600000 (ms), off or reset` };
}

export type TimeoutKind = "idle" | "tool";

export interface TimeoutCommand {
  /** Which guard the command targets; `both` for the bare `/timeout` / `reset`. */
  kind: TimeoutKind | "both";
  action: "show" | "set" | "reset";
  /** New value in milliseconds (`action === "set"`). */
  ms?: number;
}

/**
 * Parse `/timeout` arguments.
 *
 *   []                  → show both
 *   `30m`               → idle = 30m (the idle guard is what people mean)
 *   `tool 30m`          → tool = 30m
 *   `reset` / `reset tool` → forget the saved value
 */
export function parseTimeoutCommand(
  args: readonly string[],
): TimeoutCommand | { error: string } {
  if (args.length === 0) return { kind: "both", action: "show" };

  const head = args[0].toLowerCase();

  if (head === "reset") {
    const target = args[1]?.toLowerCase();
    if (target === undefined) return { kind: "both", action: "reset" };
    if (target === "idle" || target === "tool") return { kind: target, action: "reset" };
    return { error: `/timeout reset takes "idle" or "tool", not "${args[1]}"` };
  }

  if (head === "idle" || head === "tool") {
    if (args.length < 2) return { error: `/timeout ${head} needs a value (90s, 30m, 2h, 600000, off)` };
    const parsed = parseTimeoutSpec(args.slice(1).join(" "));
    if ("error" in parsed) return { error: parsed.error };
    return { kind: head, action: "set", ms: parsed.ms };
  }

  const parsed = parseTimeoutSpec(args.join(" "));
  if ("error" in parsed) return { error: parsed.error };
  return { kind: "idle", action: "set", ms: parsed.ms };
}

// ─── Idle guard decision ─────────────────────────────────────────────────────

export interface IdleGuardInput {
  now: number;
  lastActivity: number;
  busy: boolean;
  hasSession: boolean;
  exiting: boolean;
  agentDead: boolean;
  cancelRequested: boolean;
  /**
   * The user owes us an answer: a permission prompt is on screen (or queued), or
   * a menu is open. Waiting for a human is never "the agent went silent".
   */
  awaitingUser: boolean;
  /** Name of a tool call that has not finished yet, else null. */
  runningTool: string | null;
  idleMs: number;
  toolMs: number;
}

export type IdleGuardDecision = { kind: "wait" } | { kind: "cancel"; reason: string };

/**
 * Decide what the idle watchdog does on one tick.
 *
 * A tool call is "running" while its block is not finished — goose reports the
 * initial `tool_call` with status `pending` (`acp/server/tool_calls/conversion.rs`)
 * and only sends `in_progress` when something live happens, so a `sleep 600`
 * stays `pending` for its whole run and a status test would never match.
 */
export function planIdleAction(input: IdleGuardInput): IdleGuardDecision {
  if (!input.busy || !input.hasSession) return { kind: "wait" };
  if (input.exiting || input.agentDead || input.cancelRequested) return { kind: "wait" };
  if (input.awaitingUser) return { kind: "wait" };

  const silentMs = Math.max(0, input.now - input.lastActivity);

  if (input.runningTool) {
    if (input.toolMs <= 0 || silentMs < input.toolMs) return { kind: "wait" };
    return {
      kind: "cancel",
      reason: `tool "${input.runningTool}" produced no output for ${formatDuration(silentMs)} — cancelling the turn`,
    };
  }

  if (input.idleMs <= 0 || silentMs < input.idleMs) return { kind: "wait" };
  return {
    kind: "cancel",
    reason: `no agent activity for ${formatDuration(silentMs)} — cancelling the turn`,
  };
}
