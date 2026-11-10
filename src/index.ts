#!/usr/bin/env bun
/**
 * rossii — an ACP terminal UI for Goose
 *
 * CLI flags (single-letter, like tmux):
 *   e    Edit mode: choose a session → choose a user message → rollback
 *        (permanently delete messages from that point forward).
 *   m    No-worktree: run interactively without git worktree isolation
 *   w    Force worktree: enable git worktree isolation (overrides ROSSII_NO_WORKTREE=1)
 *   a    Auto-resume: quick resume to last session in this directory
 *   n    New session: skip pickers, start new with last provider/model
 *        (in chat mode a/n open the chat immediately — no summary, no confirm;
 *        classic mode keeps the "Launch Goose now?" prompt)
 *   s    Sessions only: picker only, then launch with last provider/model
 *   ma   Like a but without git worktree isolation (shortcut for m+a)
 *   ms   Like s but without git worktree isolation (shortcut for m+s)
 *   mn   Like n but without git worktree isolation (shortcut for m+n)
 *   wa   Like a but with worktree forced on (shortcut for w+a)
 *   ws   Like s but with worktree forced on (shortcut for w+s)
 *   wn   Like n but with worktree forced on (shortcut for w+n)
 *   me   Edit mode without git worktree isolation
 *   we   Edit mode with worktree forced on
 *
 * Chat (ACP) mode is the default: rossii renders the dialog itself on top of
 * `goose acp`. Set ROSSII_ACP_MODE=classic to hand the terminal to the classic
 * `goose session` TUI instead. The old chat letters (c, ac/ca, nc/cn, sc/cs,
 * mc, wc) are no longer flags; the pairs still work as aliases of a/n/s/m/w.
 *
 * Entry point. Imports all modules and runs the interactive TUI loop.
 */

import process from "node:process";
import { resolve } from "node:path";
import { intro, log } from "@clack/prompts";
import pc from "picocolors";

import pkg from "../package.json";
import { setEnv, getCurrentDirName } from "./utils";
import { readRossiiConfig } from "./rossii-config";
import { getConfigProviders, getDiscoveredCustomProviders, loadConfigEnvVars } from "./config";
import { detectOllama } from "./models";
import { runDoctor } from "./doctor";
import { runUpdate } from "./update";

import {
  LEGACY_CHAT_ALIASES, resolveChatMode,
  stepSession, stepSessionName, stepSet, stepProvider, stepModel,
  type Step, type WizardState,
} from "./wizard-steps";
import { resolveLaunchMode, stepLaunch } from "./wizard-launch";

// ─── Main TUI ────────────────────────────────────────────────────────────────

const HELP = `
rossii ${pkg.version} — an ACP terminal UI for Goose

Usage:
  rossii [flags]        open the wizard (chat mode by default)
  rossii doctor         print a diagnostic report
  rossii update         install the latest release (--check, --pre, --version)
  rossii --version      print the version
  rossii --help         print this help

Flags (single letters, tmux style; leading dashes optional):
  a   resume the last session in this directory
  n   new session (last provider/model, no wizard)
  s   pick a session, then launch with the last provider/model
  e   edit mode: choose a session → user message → roll back to it
  m   no git worktree isolation
  w   force git worktree isolation (overrides ROSSII_NO_WORKTREE=1)

  Pairs: ma ms mn (m + a/s/n), wa ws wn (w + a/s/n), me we.

Environment (the legacy CGOOSE_* spelling still works):
  ROSSII_ACP_MODE=classic       use goose's own TUI instead of the chat
  ROSSII_CHAT_MAIN_SCREEN=1     inline renderer instead of the alternate screen
  ROSSII_ACP_BLOCKS=closed      thought/tool blocks: live|open|done|closed
  ROSSII_ACP_STEER=0            disable steering during a turn
  ROSSII_ACP_IDLE_TIMEOUT_MS    cancel a turn after this much silence (0 = off)
  ROSSII_ACP_TOOL_TIMEOUT_MS    silence allowed while a tool call is running
  ROSSII_ACP_PROMPT_TIMEOUT_MS  absolute cap on a single turn (0 = off)
                                (the environment beats /timeout and the saved
                                 values, and applies to this run only)
  ROSSII_NO_WORKTREE=1          never create worktrees
  ROSSII_FORCE_WORKTREE=1       always create worktrees

Sessions live in goose's own DB; sets, config and per-project history live in
~/.config/rossii. Run \`rossii doctor\` when something does not work.
`;

function printHelp(): void {
  console.log(HELP.trimStart());
}

async function main() {
  // Plain-word commands and long flags are handled before the TUI starts, so
  // they work without a provider, a config or a terminal.
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0]?.replace(/^-+/, "").toLowerCase();
  if (command === "version" || command === "v") {
    console.log(pkg.version);
    return;
  }
  if (command === "help" || command === "h") {
    printHelp();
    return;
  }
  if (command === "doctor") {
    process.exit(runDoctor());
  }
  if (command === "update") {
    process.exit(await runUpdate(rawArgs.slice(1)));
  }

  console.clear();
  intro(`${pc.bgCyan(pc.black(" rossii "))} ${pc.dim("— an ACP terminal UI for Goose")}`);

  const projectName = getCurrentDirName();
  const sessionPrefix = projectName;
  loadConfigEnvVars();
  const configProviders = getConfigProviders();
  // Discover custom providers that have JSON files but aren't in config.yaml
  const discoveredProviders = getDiscoveredCustomProviders(configProviders);
  // All known providers = from config.yaml/enriched + discovered from JSON only
  const allProviders = [...configProviders, ...discoveredProviders];
  const ollamaModels = await detectOllama();

  const hasAnyProvider = allProviders.length > 0 || (ollamaModels !== null && ollamaModels.length > 0);

  if (!hasAnyProvider) {
    log.error(pc.red('\u2716 No enabled providers found in ' + resolve('.config/goose/config.yaml')));
    log.info(pc.dim("  Run 'goose configure' to set up a provider first, or install Ollama (ollama.com)."));
    process.exit(1);
  }

  // ─── CLI flags ───────────────────────────────────────────────────────────
  // Flags are single-letter, tmux-style: `rossii mn`, `rossii w`. Leading
  // dashes are stripped so `rossii -mn` works too. Legacy chat pairs collapse
  // to their base mode (mc→m, ac→a, …) — chat itself is the default now.
  const args = process.argv.slice(2)
    .map((a) => a.replace(/^-+/, ""))
    .map((a) => LEGACY_CHAT_ALIASES[a] ?? a)
    .filter(Boolean);

  // Detect worktree force flag (w, wa, ws, wn) — overrides ROSSII_NO_WORKTREE
  const forceWorktree = args.includes("w") || args.includes("wa") || args.includes("ws")
    || args.includes("wn");
  if (forceWorktree) {
    setEnv("FORCE_WORKTREE", "1");
    setEnv("NO_WORKTREE", undefined);
  }

  // Renderer: ACP chat by default, classic `goose session` TUI on demand.
  const isChatMode = resolveChatMode();

  // Detect "minimal" variants (ma, ms, mn, m) — no worktree, root-only sessions
  let noWorktree = !forceWorktree && (args.includes("m") || args.includes("ma") || args.includes("ms") || args.includes("mn"));
  if (noWorktree) {
    setEnv("NO_WORKTREE", "1");
  }

  // If no explicit CLI override, check rossii config for default mode
  if (!forceWorktree && !noWorktree) {
    const rossiiConfig = readRossiiConfig();
    if (rossiiConfig.default_mode === "no-worktree") {
      setEnv("NO_WORKTREE", "1");
      noWorktree = true;
    }
  }

  // ─── State shared across steps ───────────────────────────────────────────
  const state: WizardState = {
    mode: "full",
    noWorktree,
    isChatMode,
    sessionPrefix,
    allProviders,
    discoveredProviders,
    ollamaModels,
    sessionName: "",
    sessionDisplayName: "", // human-readable name (for worktree lookups)
    isNewSession: false,
    selectedProviderName: "",
    modelValue: "",
    selectedSet: "", // name of the selected session set ("" = none)
    lastAllSessions: [],
    quickLaunch: false,
  };

  // Resolve the CLI launch mode and fast-forward `a`/`n` runs from the meta;
  // `s` runs and the plain wizard start back at step 1.
  let step: Step = await resolveLaunchMode(args, state);

  // ═══════════════════════════════════════════════════════════════════════════
  // Navigation loop — each Esc/cancel goes back one step
  // ═══════════════════════════════════════════════════════════════════════════

  while (true) {
    switch (step) {
      case "session":
        step = await stepSession(state);
        break;
      case "session_name":
        step = await stepSessionName(state);
        break;
      case "set":
        step = await stepSet(state);
        break;
      case "provider":
        step = await stepProvider(state);
        break;
      case "model":
        step = await stepModel(state);
        break;
      case "launch": {
        const next = await stepLaunch(state);
        if (next === null) return;
        step = next;
        break;
      }
    }
  }
}

main().catch((err) => {
  console.error(pc.red("\n✖ Fatal error:"), err);
  process.exit(1);
});

