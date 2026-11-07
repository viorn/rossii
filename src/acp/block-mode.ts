/**
 * How the collapsible thought and tool blocks behave.
 *
 * Both blocks stream their text into a bar, and until now the rule was fixed:
 * the block that is currently receiving chunks is expanded (so the reasoning
 * and the command output are visible live) and collapses to a one-line bar on
 * `setFinished()`. That is noisy for a long turn — every thought burst and
 * every tool call pushes the rest of the transcript up while it runs.
 *
 * `ROSSII_ACP_BLOCKS` makes the rule a setting, with the same four states the
 * user sees:
 *
 *  1. `live`   (default) — expanded while chunks arrive, collapses when done
 *  2. `open`             — always expanded, finished or not
 *  3. `done`             — collapsed while chunks arrive, expands when done
 *  4. `closed`           — always collapsed; only the bar is ever shown
 *
 * The numbers are accepted as values too (`ROSSII_ACP_BLOCKS=2`), so the mode
 * can be picked by the list above rather than by remembering a word. A manual
 * click or `/think` / `/tool` still wins over all four: the mode only decides
 * the *automatic* state.
 */

export type BlockMode = "live" | "open" | "done" | "closed";

export const BLOCK_MODE_ENV = "ROSSII_ACP_BLOCKS";

/** The behaviour rossii shipped before the setting existed. */
export const DEFAULT_BLOCK_MODE: BlockMode = "live";

/**
 * Accepted spellings. Words are matched case-insensitively; the digits are the
 * numbering of the modes in the docs (and in this file's header).
 */
const ALIASES: Record<string, BlockMode> = {
  "1": "live",
  live: "live",
  stream: "live",
  "2": "open",
  open: "open",
  expanded: "open",
  expand: "open",
  "3": "done",
  done: "done",
  finished: "done",
  finish: "done",
  after: "done",
  "4": "closed",
  closed: "closed",
  collapsed: "closed",
  collapse: "closed",
};

export interface ResolvedBlockMode {
  mode: BlockMode;
  /** Human-readable warning when the environment value was unusable, else null. */
  invalid: string | null;
}

/**
 * Read the mode from its raw setting, falling back to the default **with a
 * warning** — the chat prints it, exactly like the watchdog and steering
 * settings: a typo must not silently change how the transcript renders.
 */
export function parseBlockMode(raw: string | undefined): ResolvedBlockMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return { mode: DEFAULT_BLOCK_MODE, invalid: null };

  const mode = ALIASES[value];
  if (!mode) {
    return {
      mode: DEFAULT_BLOCK_MODE,
      invalid: `${BLOCK_MODE_ENV}="${raw}" is not live|open|done|closed (1–4) — using ${DEFAULT_BLOCK_MODE}`,
    };
  }
  return { mode, invalid: null };
}

/** Whether a block starts expanded — it is streaming until `setFinished()`. */
export function startsExpanded(mode: BlockMode): boolean {
  return mode === "live" || mode === "open";
}

/** Whether a block is expanded once its chunks stop arriving. */
export function endsExpanded(mode: BlockMode): boolean {
  return mode === "open" || mode === "done";
}
