/**
 * chat-config.ts — configuration menus and slash commands.
 *
 * Functions: showMenu, changeModel, changeProvider, currentProviderConfig,
 * fetchModelsForCurrentProvider, applyFetchedModel, showConfigMenu,
 * showProviderMenu, showModelMenu, showSetMenu, showSessionMenu,
 * submitGooseCommand, showCommandsHelp, handleCommand, and the `/timeout`
 * command (printTimeouts, changeTimeout, showTimeoutsMenu).
 */

import pc from "picocolors";
import { Text, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { listSessionSets, DEFAULT_PROFILE_SENTINEL } from "../rossii-config";
import { readProjectMeta } from "../project";
import { getAllSessions } from "../sessions";
import { isInsideGitRepo, getProjectSessionDirs } from "../worktree";
import { applySessionConfig, optionValue } from "./session-config";
import { changeSet, changeSession, newSession, forkCurrentSession, renameCurrentSession, promptRename } from "./chat-session";
import { toggleAllThoughts, toggleAllTools, renderHeader, renderStatus } from "./chat-stream";
import { persistSelection } from "./chat-extensions";
import { framed } from "./chat-handlers";
import { promptInEditor, queuePrompt, submitPrompt } from "./chat-io";
import { commandRewritesHistory, formatGooseCommandNames } from "./slash-commands";
import { currentTimeouts, resyncTimeouts } from "./timeout-state";
import { describeTimeout, formatDuration, parseTimeoutCommand, parseTimeoutSpec, type TimeoutKind } from "./timeouts";
import { writeProjectTimeouts } from "../project";
import { SearchableList } from "./overlay";
import { mergeModelOptions, orderByUsage, orderModelMenu } from "./model-options";
import { selectListTheme } from "./chat-context";
import {
  addModelToCustomProviderJson,
  getConfigProviders,
  getDiscoveredCustomProviders,
  getCustomProviderModels,
  isModelInCustomProviderJson,
  type ProviderInfo,
} from "../config";
import { fetchModels, type ApiModelInfo } from "../models";
import { formatNumber } from "../utils";
import type { ChatContext } from "./chat-context";

// ─── Menu helpers ────────────────────────────────────────────────────────────

export function showMenu(
  ctx: ChatContext,
  title: string,
  items: Array<{ value: string; label: string; description?: string }>,
  onSelect: (value: string) => void | Promise<void>,
  options: { layout?: SelectListLayoutOptions; width?: number } = {},
): void {
  if (ctx.activePermission || ctx.menuActive) return;
  ctx.menuActive = true;
  const entries = items.length > 0 ? items : [{ value: "cancel", label: "Cancel" }];
  // Every menu is searchable: typing narrows the list (substring match, so
  // `flash` finds `deepseek-v4-flash`) while arrows, Enter and Esc keep
  // behaving exactly as in a plain SelectList. Provider names, model ids, set
  // titles and session names are all lists one filters rather than scans.
  const list = new SearchableList(entries, selectListTheme, {
    maxVisible: 10,
    layout: options.layout,
    placeholder: "type to filter",
    searchStyle: pc.dim,
  });
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    ctx.menuActive = false;
    ctx.tui.hideOverlay();
    ctx.tui.setFocus(ctx.editor);
  };
  list.onSelect = (item: any) => {
    finish();
    if (item.value === "cancel") return;
    void onSelect(String(item.value));
  };
  list.onCancel = () => finish();
  ctx.tui.showOverlay(framed(list, `⚙ ${title}`), { width: options.width ?? 76 });
  ctx.tui.setFocus(list);
}

// ─── Model / Provider ────────────────────────────────────────────────────────

export async function changeModel(ctx: ChatContext, newModel: string): Promise<void> {
  if (!ctx.sessionId) return;
  const outcome = await applySessionConfig(
    ctx.client,
    ctx.sessionId,
    { provider: ctx.currentProvider, model: newModel },
    { provider: ctx.currentProvider, model: ctx.currentModel },
  );
  if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
  if (outcome.warning) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
  } else {
    ctx.currentModel = outcome.model ?? newModel;
    ctx.transcript.addChild(new Text(pc.dim(`⚙ Model changed to ${ctx.currentModel}`), 1, 0));
    renderStatus(ctx);
    renderHeader(ctx);
    persistSelection(ctx);
  }
  ctx.tui.requestRender();
}

export async function changeProvider(ctx: ChatContext, newProvider: string): Promise<void> {
  if (!ctx.sessionId) return;
  const outcome = await applySessionConfig(
    ctx.client,
    ctx.sessionId,
    { provider: newProvider, model: ctx.currentModel },
    { provider: ctx.currentProvider, model: ctx.currentModel },
  );
  if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
  if (outcome.warning) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
  } else {
    ctx.currentProvider = outcome.provider ?? newProvider;
    ctx.currentModel = outcome.model ?? ctx.currentModel;
    ctx.transcript.addChild(new Text(pc.dim(`⚙ Provider changed to ${ctx.currentProvider}, model: ${ctx.currentModel}`), 1, 0));
    renderStatus(ctx);
    renderHeader(ctx);
    persistSelection(ctx);
  }
  ctx.tui.requestRender();
}

// ─── Thinking effort ─────────────────────────────────────────────────────────

/**
 * Change `thinking_effort` — how hard the model reasons (goose's fourth
 * `configOptions` entry, `select` with 5 values on goose 1.57). Unlike the
 * provider/model pair it is not part of the wizard or the project meta: goose
 * persists it into `sessions.db` itself, so the value travels with the
 * session and rossii only offers a switch here.
 */
export async function changeThinkingEffort(ctx: ChatContext, newEffort: string): Promise<void> {
  if (!ctx.sessionId) return;
  const current = optionValue(ctx.newSessionConfigOptions, "thinking_effort") ?? null;
  const outcome = await applySessionConfig(
    ctx.client,
    ctx.sessionId,
    { provider: ctx.currentProvider, model: ctx.currentModel, thinkingEffort: newEffort },
    { provider: ctx.currentProvider, model: ctx.currentModel, thinkingEffort: current },
  );
  if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
  if (outcome.warning) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
  } else {
    ctx.transcript.addChild(new Text(
      pc.dim(`⚙ Thinking effort changed to ${outcome.thinkingEffort ?? newEffort}`),
      1, 0,
    ));
  }
  ctx.tui.requestRender();
}

/** The `thinking_effort` select from goose's `configOptions` — absent when the
 *  agent is older than the option or the provider has nothing to choose. */
function effortOption(ctx: ChatContext) {
  return ctx.newSessionConfigOptions?.find((o) => o.id === "thinking_effort");
}

export function showEffortMenu(ctx: ChatContext): void {
  const option = effortOption(ctx);
  const items: Array<{ value: string; label: string; description?: string }> = (option?.options ?? [])
    .map((o) => ({
      value: o.value,
      label: o.name ?? o.value,
      ...(o.value === option?.currentValue ? { description: "current" } : {}),
    }));
  if (items.length === 0) {
    ctx.transcript.addChild(new Text(
      pc.yellow("⚠ goose did not report a thinking_effort option for this session — it is not offered here."),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  items.push({ value: "cancel", label: "Cancel" });
  showMenu(ctx, "Select Thinking Effort", items, (value) => {
    if (value !== "cancel") void changeThinkingEffort(ctx, value);
  });
}

// ─── Config menu ─────────────────────────────────────────────────────────────
export function showConfigMenu(ctx: ChatContext): void {
  showMenu(ctx, "Configuration", [
    { value: "provider", label: "Change Provider" },
    { value: "model", label: "Change Model" },
    { value: "effort", label: "Change Thinking Effort" },
    { value: "timeouts", label: "Change Timeouts" },
    { value: "set", label: "Change Set" },
    { value: "session", label: "Change Session" },
  ], (value) => {
    switch (value) {
      case "provider": showProviderMenu(ctx); break;
      case "model": showModelMenu(ctx); break;
      case "effort": showEffortMenu(ctx); break;
      case "timeouts": showTimeoutsMenu(ctx); break;
      case "set": showSetMenu(ctx); break;
      case "session": showSessionMenu(ctx); break;
    }
  });
}

export function showProviderMenu(ctx: ChatContext): void {
  const options = ctx.newSessionConfigOptions?.find((o) => o.id === "provider")?.options ?? [];
  if (options.length === 0) {
    ctx.transcript.addChild(new Text(
      pc.yellow("⚠ No provider list available (config options missing). Use /provider <name> or restart."),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  // Same order as the wizard's provider step: this project's providers by last
  // use (`providerHistory[0]` = the one the session runs on), then whatever
  // order goose reports the rest in. `persistSelection` keeps that history
  // current after every `/provider` and `/model`, so the two UIs agree.
  const history = readProjectMeta()?.providerHistory ?? [];
  const items = orderByUsage(
    options.map((o) => ({ value: o.value, label: o.name ?? o.value })),
    history,
  ).map((item) => item.value === ctx.currentProvider
    ? { ...item, description: "current" }
    : item);
  items.push({ value: "cancel", label: "Cancel" });
  showMenu(ctx, "Select Provider", items, (value) => {
    if (value !== "cancel") void changeProvider(ctx, value);
  });
}

// ─── Model fetch from the provider's own API ─────────────────────────────────

/** The provider entry from config.yaml / custom_providers/*.json, which is
 *  what the HTTP model fetch needs (base_url + api key). */
export function currentProviderConfig(ctx: ChatContext): ProviderInfo | undefined {
  const yamlProviders = getConfigProviders();
  return [...yamlProviders, ...getDiscoveredCustomProviders(yamlProviders)].find(
    (entry) => entry.name === ctx.currentProvider,
  );
}

export async function applyFetchedModel(ctx: ChatContext, model: ApiModelInfo, provider: ProviderInfo): Promise<void> {
  await changeModel(ctx, model.id);
  // A model the provider JSON does not list has no context limit, and the
  // wizard would not offer it either — record it (the API's own limit when it
  // reports one) so both UIs see the same list.
  if (provider.name.startsWith("custom_") && !isModelInCustomProviderJson(provider.name, model.id)) {
    const contextLimit = model.contextLimit ?? 128_000;
    if (addModelToCustomProviderJson(provider.name, model.id, contextLimit)) {
      ctx.transcript.addChild(new Text(
        pc.dim(`⚙ Added "${model.id}" to ${provider.name} (context_limit: ${formatNumber(contextLimit)})`),
        1, 0,
      ));
    }
  }
  ctx.tui.requestRender();
}

/** Ask the provider's own /v1/models endpoint for its current model list — the
 *  list goose may not know until the model is added to the provider JSON. */
export async function fetchModelsForCurrentProvider(ctx: ChatContext): Promise<void> {
  const provider = currentProviderConfig(ctx);
  if (!provider || !provider.baseUrl) {
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ "${ctx.currentProvider}" is not an HTTP provider with a base_url — cannot fetch models. Use /model <name>.`),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  if (!provider.authToken) {
    const envHint = provider.apiKeyEnv || `${provider.name.replace(/^custom_/, "").toUpperCase()}_API_KEY`;
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ No API key for "${provider.name}" — set $${envHint} and retry.`),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  ctx.transcript.addChild(new Text(pc.dim(`🔄 Fetching models from ${provider.baseUrl}…`), 1, 0));
  ctx.tui.requestRender();
  try {
    const models = await fetchModels(provider);
    if (models.length === 0) {
      ctx.transcript.addChild(new Text(pc.yellow("⚠ The API returned no models."), 1, 0));
      ctx.tui.requestRender();
      return;
    }
    ctx.transcript.addChild(new Text(pc.dim(`Found ${models.length} model(s) at ${provider.name}.`), 1, 0));
    // Model ids are long (`~anthropic/claude-sonnet-latest`) and the context
    // limit needs its own room, so the list is wider than the other menus.
    // Reordered by use like the main model menu, but never extended from the
    // history: this list is what the API serves right now.
    const ordered = orderByUsage(
      models.map((model) => ({
        value: model.id,
        label: model.id,
        description: model.contextLimit
          ? `context: ${formatNumber(model.contextLimit)}`
          : "context: 128k default",
      })),
      readProjectMeta()?.modelHistory?.[ctx.currentProvider] ?? [],
    );
    showMenu(ctx, `Models from ${provider.name}`, ordered, (value) => {
      const picked = models.find((model) => model.id === value);
      if (picked) void applyFetchedModel(ctx, picked, provider);
    }, { width: 88, layout: { maxPrimaryColumnWidth: 52 } });
  } catch (error) {
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ Failed to fetch models: ${String((error as Error)?.message ?? error)}`),
      1, 0,
    ));
  }
  ctx.tui.requestRender();
}

export function showModelMenu(ctx: ChatContext): void {
  const gooseOptions = ctx.newSessionConfigOptions?.find((o) => o.id === "model")?.options ?? [];
  // Same gate as the wizard: only `custom_*` providers keep a JSON file.
  const customModels = ctx.currentProvider.startsWith("custom_")
    ? getCustomProviderModels(ctx.currentProvider)
    : [];
  // The wizard's model step order, so a model picked last week is still on top:
  // this project's history for THIS provider, then goose's list, then the
  // provider JSON's extras. A model only the history knows survives as a
  // `history` entry instead of vanishing from the menu.
  const history = readProjectMeta()?.modelHistory?.[ctx.currentProvider] ?? [];
  const items = orderModelMenu(mergeModelOptions(gooseOptions, customModels), history)
    .map((item) => item.value === ctx.currentModel
      ? { ...item, label: `✦ ${item.label}`, description: item.description ?? "current" }
      : item);
  if (items.length === 0) {
    // No list from goose, nothing in the custom provider and no history either.
    ctx.transcript.addChild(new Text(
      pc.dim("goose reported no model list for this session — fetch it from the provider, or use /model <name>."),
      1, 0,
    ));
  }
  items.push({
    value: "!fetch",
    label: "🔄 Fetch models from API",
    description: ctx.currentProvider,
  });
  items.push({ value: "cancel", label: "Cancel" });
  // The same room for the ids as the fetched list: the names goose reports are
  // just as long, and typing filters them down the same way.
  showMenu(ctx, "Select Model", items, (value) => {
    if (value === "!fetch") void fetchModelsForCurrentProvider(ctx);
    else if (value !== "cancel") void changeModel(ctx, value);
  }, { width: 88, layout: { maxPrimaryColumnWidth: 52 } });
}

/** Project-meta set key (`""` = None, the `__default__` sentinel = goose's own
 *  profile, else a set's name) → the value this menu uses for the same choice. */
function toMenuSetValue(key: string): string {
  if (key === DEFAULT_PROFILE_SENTINEL) return "default";
  return key === "" ? "none" : key;
}

export function showSetMenu(ctx: ChatContext): void {
  const sets = listSessionSets();
  // `setHistory` stores keys ("" = None, the `__default__` sentinel = goose's
  // own profile, else the set's name) while this menu has its own values for
  // the two special entries — translated before ordering so the menu matches
  // the wizard's set step.
  const history = (readProjectMeta()?.setHistory ?? []).map(toMenuSetValue);
  const items = orderByUsage([
    ...Object.values(sets).map((s) => ({ value: s.name, label: s.title })),
    { value: "default", label: "Default (goose config.yaml)" },
    { value: "none", label: "None" },
  ], history).map((item) => item.value === toMenuSetValue(ctx.currentSetKey)
    ? { ...item, description: "current" }
    : item);
  items.push({ value: "cancel", label: "Cancel" });
  showMenu(ctx, "Select Set", items, (value) => {
    if (value !== "cancel") void changeSet(ctx, value);
  });
}

export function showSessionMenu(ctx: ChatContext): void {
  // Same project filter as the wizard: the whole sessions.db holds every
  // project the user ever ran, and switching into someone else's working
  // directory would put the agent in the wrong place.
  const dirs = new Set([ctx.cwd]);
  if (isInsideGitRepo()) for (const dir of getProjectSessionDirs(ctx.cwd)) dirs.add(dir);
  const sessions = getAllSessions().filter((s) => s.working_dir && dirs.has(s.working_dir));
  const items: Array<{ value: string; label: string; description?: string }> = sessions
    .filter((s) => s.id !== ctx.sessionId)
    .map((s) => ({
      value: s.id,
      label: s.name || s.id,
      description: `${s.message_count} msg · ${s.session_type ?? "user"}`,
    }));
  items.unshift(
    { value: "!rename", label: "✎ Rename current session" },
    { value: "!fork", label: "⑂ Fork current session" },
  );
  items.push({ value: "new", label: "＋ New Session" });
  items.push({ value: "cancel", label: "Cancel" });
  // Free-form titles, usually longer than the default 32-column primary
  // column — the filter makes a long list usable either way.
  showMenu(ctx, "Select Session", items, (value) => {
    if (value === "new") {
      void newSession(ctx);
    } else if (value === "!rename") {
      promptRename(ctx);
    } else if (value === "!fork") {
      void forkCurrentSession(ctx);
    } else if (value !== "cancel") {
      void changeSession(ctx, value);
    }
  }, { width: 88, layout: { maxPrimaryColumnWidth: 52 } });
}

// ─── Slash command handler ───────────────────────────────────────────────────

/**
 * Run a `/…` that rossii does not implement — it is goose's. The agent's
 * `execute_command()` is the only thing that can run them (they rewrite the
 * conversation goose stores or report on it) and it looks at the *prompt* of a
 * turn, so the text goes out as an ordinary prompt, verbatim; the answer
 * ("Compaction complete", the status report…) streams back normally.
 *
 * Nothing is validated against goose's announced list: goose's own TUI does not
 * either (an unknown `/…` is submitted as a message), and refusing what the chat
 * cannot know about is what made `/compact` unreachable in the first place.
 */
export function submitGooseCommand(ctx: ChatContext, text: string): void {
  if (commandRewritesHistory(text)) {
    // goose replaces its stored conversation and the ACP server drops
    // `AgentEvent::HistoryReplaced`, so nothing tells the client to redraw: this
    // transcript stays the pre-command view. Say so rather than pretend the
    // history refreshed — including when the command only runs after this turn.
    ctx.transcript.addChild(new Text(
      pc.dim(`🪿 ${text.trim()} runs on goose's side — the agent's conversation is rewritten, this transcript is not.`),
      1, 0,
    ));
    ctx.tui.requestRender();
  }
  if (ctx.busy) {
    // Queued, never steered: goose only looks for a command in a turn's prompt,
    // so a `/compact` steered into the running turn would just be text the model
    // reads mid-turn.
    queuePrompt(ctx, text);
    return;
  }
  void submitPrompt(ctx, text);
}

// ─── Timeouts ────────────────────────────────────────────────────────────────

const TIMEOUT_PRESETS = ["30s", "5m", "15m", "30m", "1h", "2h", "off"] as const;

/** `/timeout` and the `/config` menu entry. */
async function runTimeoutCommand(ctx: ChatContext, args: readonly string[]): Promise<void> {
  const parsed = parseTimeoutCommand(args);
  if ("error" in parsed) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${parsed.error}`), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  if (parsed.action === "show") {
    printTimeouts(ctx);
    return;
  }
  if (parsed.action === "reset") {
    if (parsed.kind !== "tool") await changeTimeout(ctx, "idle", null);
    if (parsed.kind !== "idle") await changeTimeout(ctx, "tool", null);
    return;
  }
  await changeTimeout(ctx, parsed.kind === "tool" ? "tool" : "idle", parsed.ms ?? 0);
}

/** `idle 5m (env …)` / `tool 30m (project)` / `hard cap 4h (default)`. */
export function printTimeouts(ctx: ChatContext): void {
  const state = currentTimeouts(ctx);
  for (const [label, resolved] of [
    ["idle", state.idle],
    ["tool", state.tool],
    ["hard cap", state.turn],
  ] as const) {
    ctx.transcript.addChild(new Text(pc.dim(`${label.padEnd(8)} ${describeTimeout(resolved)}`), 1, 0));
  }
  ctx.transcript.addChild(new Text(
    pc.dim("/timeout 30m · /timeout tool 1h · /timeout reset [idle|tool] — `off` disables"),
    1, 0,
  ));
  ctx.tui.requestRender();
}

/**
 * Apply a new watchdog value from the chat.
 *
 * The value is always saved for the project — that is what makes `/timeout`
 * worth typing — but when the environment sets the same watchdog the
 * environment still wins, and the chat says so instead of pretending the value
 * took effect (the saved one applies as soon as the variable is unset).
 */
export async function changeTimeout(ctx: ChatContext, kind: TimeoutKind, ms: number | null): Promise<void> {
  try {
    writeProjectTimeouts(kind === "idle" ? { idleMs: ms } : { toolMs: ms });
  } catch (error) {
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ Could not save the timeout for this project: ${String((error as Error)?.message ?? error)}`),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }

  const state = resyncTimeouts(ctx);
  const resolved = kind === "idle" ? state.idle : state.tool;
  const cleared = ms === null ? "project value cleared" : `saved ${formatDuration(ms)} for this project`;

  if (resolved.source === "env") {
    ctx.transcript.addChild(new Text(
      pc.yellow(
        `⚠ ${kind} timeout stays ${formatDuration(resolved.ms)} — ${resolved.env} overrides /timeout (${cleared}; it applies once the variable is unset)`,
      ),
      1, 0,
    ));
  } else {
    const origin =
      resolved.source === "set" ? "from the set" :
      resolved.source === "project" ? "saved for this project" :
      "default";
    ctx.transcript.addChild(new Text(
      pc.dim(`⚙ ${kind} timeout → ${formatDuration(resolved.ms)} (${origin})${ms === null ? ` — ${cleared}` : ""}`),
      1, 0,
    ));
  }
  ctx.tui.requestRender();
}

export function showTimeoutsMenu(ctx: ChatContext): void {
  const state = currentTimeouts(ctx);
  showMenu(ctx, "Timeouts", [
    { value: "idle", label: `Idle timeout — ${describeTimeout(state.idle)}` },
    { value: "tool", label: `Tool timeout — ${describeTimeout(state.tool)}` },
    { value: "hard", label: `Hard cap — ${describeTimeout(state.turn)}` },
  ], (value) => {
    if (value === "idle" || value === "tool") showTimeoutPresets(ctx, value);
  });
}

function showTimeoutPresets(ctx: ChatContext, kind: TimeoutKind): void {
  const items = [
    ...TIMEOUT_PRESETS.map((value) => ({ value, label: value })),
    { value: "reset", label: "Reset (back to the set / default)" },
    { value: "cancel", label: "Cancel" },
  ];
  showMenu(ctx, kind === "idle" ? "Idle timeout" : "Tool timeout", items, async (value) => {
    if (value === "cancel") return;
    if (value === "reset") {
      await changeTimeout(ctx, kind, null);
      return;
    }
    const parsed = parseTimeoutSpec(value);
    if ("error" in parsed) {
      ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${parsed.error}`), 1, 0));
      ctx.tui.requestRender();
      return;
    }
    await changeTimeout(ctx, kind, parsed.ms);
  });
}

/**
 * `/help` — the same two lists the composer's completion menu offers
 * (./command-complete.ts), printed for reading.
 */
export function showCommandsHelp(ctx: ChatContext): void {
  ctx.transcript.addChild(new Text(
    pc.dim("The chat: ") + "/config /model /provider /set /session /rename /fork /think /tool /timeout /edit /fetch /help",
    1, 0,
  ));
  ctx.transcript.addChild(new Text(
    ctx.gooseCommands.length > 0
      ? pc.dim("goose:    ") + formatGooseCommandNames(ctx.gooseCommands) +
        pc.dim("  (any other /command goes to the agent too)")
      : pc.dim("goose also has its own commands (/compact, /clear, /status…) — its list is not here yet, try /help again."),
    1, 0,
  ));
  ctx.transcript.addChild(new Text(
    pc.dim("Tab (or just `/`) opens the same list in the composer · ↑/↓ pick · Enter applies · Esc closes"),
    1, 0,
  ));
  ctx.tui.requestRender();
}

export async function handleCommand(ctx: ChatContext, text: string): Promise<void> {
  const [cmd, ...args] = text.slice(1).split(/\s+/);
  switch (cmd) {
    case "config":
    case "settings":
    case "setting":
      showConfigMenu(ctx);
      return;
    case "edit":
      await promptInEditor(ctx);
      return;
    case "fetch":
      await fetchModelsForCurrentProvider(ctx);
      return;
    case "model":
      if (args.length === 0) {
        showModelMenu(ctx);
      } else if (args[0] === "fetch") {
        await fetchModelsForCurrentProvider(ctx);
      } else {
        await changeModel(ctx, args.join(" "));
      }
      return;
    case "provider":
      if (args.length > 0) {
        await changeProvider(ctx, args.join(" "));
      } else {
        showProviderMenu(ctx);
      }
      return;
    case "effort":
    case "thinking":
      if (args.length > 0) {
        await changeThinkingEffort(ctx, args.join(" "));
      } else {
        showEffortMenu(ctx);
      }
      return;
    case "set":
      if (args.length > 0) {
        await changeSet(ctx, args.join(" "));
      } else {
        showSetMenu(ctx);
      }
      return;
    case "session":
      if (args.length > 0) {
        switch (args[0]) {
          case "new":
            await newSession(ctx);
            break;
          case "rename":
            if (args.length > 1) await renameCurrentSession(ctx, args.slice(1).join(" "));
            else promptRename(ctx);
            break;
          case "fork":
            await forkCurrentSession(ctx);
            break;
          default:
            await changeSession(ctx, args.join(" "));
        }
      } else {
        showSessionMenu(ctx);
      }
      return;
    case "rename":
      if (args.length > 0) await renameCurrentSession(ctx, args.join(" "));
      else promptRename(ctx);
      return;
    case "fork":
      await forkCurrentSession(ctx);
      return;
    case "think":
      toggleAllThoughts(ctx, args);
      return;
    case "timeout":
      await runTimeoutCommand(ctx, args);
      return;
    case "tool":
      toggleAllTools(ctx, args);
      return;
    case "help":
      showCommandsHelp(ctx);
      return;
    default:
      // Not a command rossii implements → goose's (see ./slash-commands.ts):
      // `/compact`, `/clear`, `/status`, `/doctor`, `/goal`, …, a recipe or a
      // skill, or simply a typo goose will treat as text.
      submitGooseCommand(ctx, text);
      return;
  }
}
