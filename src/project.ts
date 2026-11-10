/**
 * Per-project meta — remembers last used provider/model
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { env } from "./utils";

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * Same rule as the sets/config directory (see rossii-config.ts): the old
 * `~/.config/cgoose/projects` is used only while the new one does not exist.
 */
const ROSSII_PROJECTS_DIR = (() => {
  const override = env("PROJECTS_DIR");
  if (override) return override;
  const current = join(homedir(), ".config", "rossii", "projects");
  const legacy = join(homedir(), ".config", "cgoose", "projects");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
})();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectMeta {
  /** History of models used per provider (first = last used) */
  modelHistory: Record<string, string[]>;
  /** History of providers used in this project (first = last used) */
  providerHistory: string[];
  /** History of recipes used in this project (first = last used; "" = no recipe) */
  recipeHistory: string[];
  /** History of session sets used in this project (first = last used; "" = none) */
  setHistory: string[];
  /** Maps session name → worktree path (created via rossii git worktree integration) */
  worktrees?: Record<string, string>;
  /** Watchdog values set with `/timeout` in this directory; absent = inherit. */
  timeouts?: ProjectTimeouts;
}

/**
 * Chat watchdogs saved for this directory. Both are optional and independent:
 * a missing key means "not set here", so the set's default (or the built-in
 * one) applies — and `ROSSII_ACP_*_TIMEOUT_MS` above them all.
 */
export interface ProjectTimeouts {
  idleMs?: number;
  toolMs?: number;
}

// ─── Project key ─────────────────────────────────────────────────────────────

/** Get a stable project key: dirname + short hash of the full path */
function getProjectKey(): string {
  const dir = resolve(".");
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${basename(dir)}-${hash}`;
}

function getProjectMetaPath(): string {
  return join(ROSSII_PROJECTS_DIR, `${getProjectKey()}.json`);
}

// ─── Read / Write ────────────────────────────────────────────────────────────

export function readProjectMeta(): ProjectMeta | null {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Migrate old format: { provider, model } → { provider, modelHistory }
    // Also handles the case where `model` is "" but modelHistory exists
    if (!raw.modelHistory) {
      raw.modelHistory = raw.model ? { [raw.provider ?? ""]: [raw.model] } : {};
    }
    // Migrate: ensure providerHistory exists (clean empty strings)
    if (!raw.providerHistory) {
      raw.providerHistory = raw.provider ? [raw.provider] : [];
    }
    // Migrate: ensure recipe history exists (clean empty strings)
    // "" (no recipe) is a valid recipeHistory entry, preserve it
    if (!raw.recipeHistory) {
      raw.recipeHistory = (raw.recipe !== undefined && raw.recipe !== null)
        ? [raw.recipe]
        : [];
    }
// Migrate: ensure setHistory exists
    if (!raw.setHistory) {
      raw.setHistory = [];
    }
    // Sanitize: remove empty strings from providerHistory
    raw.providerHistory = raw.providerHistory.filter(Boolean);
    return raw as ProjectMeta;
  } catch { return null; }
}

/**
 * Save provider + model + set selection to project meta.
 * Memory is per-project, not per-session.
 * recipe history is kept in ProjectMeta for backwards compatibility with
 * existing project files but is no longer actively tracked.
 */
export function writeProjectMeta(provider: string, model: string, sessionSet?: string): void {
  const dir = ROSSII_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  // Merge with existing meta to preserve history
  const existing = existsSync(path)
    ? (() => { try { return JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta; } catch { return null; } })()
    : null;

  const modelHistory: Record<string, string[]> = existing?.modelHistory ?? {};
  const prevList = (modelHistory[provider] ?? []).filter((m) => m !== model);
  modelHistory[provider] = [model, ...prevList].slice(0, 10); // keep max 10 per provider

  // Track provider history (most recent first, max 10)
  // Filter out empty strings to prevent corrupted entries
  const providerHistory = (existing?.providerHistory ?? []).filter(Boolean);
  const filteredProvHistory = providerHistory.filter((p) => p !== provider);
  const newProviderHistory = [provider, ...filteredProvHistory].slice(0, 10);

  // Track session set history (most recent first, max 10).
  // "" (none) is a legitimate choice.
  const effectiveSet = sessionSet !== undefined ? sessionSet : (existing?.setHistory?.[0] ?? "");
  const setHistory = existing?.setHistory ?? [];
  const filteredSetHistory = setHistory.filter((s) => s !== effectiveSet);
  const newSetHistory = [effectiveSet, ...filteredSetHistory].slice(0, 10);

  // Preserve existing worktree mappings when merging
  const worktrees = existing?.worktrees ?? {};

  writeFileSync(path, JSON.stringify({
    modelHistory,
    providerHistory: newProviderHistory,
    setHistory: newSetHistory,
    worktrees,
    // `/timeout` writes its own key; rewriting the file without it would make
    // the setting vanish on the next wizard run.
    ...(existing?.timeouts ? { timeouts: existing.timeouts } : {}),
  }, null, 2) + "\n");
}

// ─── Timeouts (set from the chat with `/timeout`) ────────────────────────────

/** Watchdog values saved for this directory (empty object when none are). */
export function readProjectTimeouts(): ProjectTimeouts {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return {};
  try {
    const meta = JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta;
    const saved = meta.timeouts;
    if (!saved || typeof saved !== "object") return {};
    const out: ProjectTimeouts = {};
    if (typeof saved.idleMs === "number" && Number.isFinite(saved.idleMs) && saved.idleMs >= 0) {
      out.idleMs = saved.idleMs;
    }
    if (typeof saved.toolMs === "number" && Number.isFinite(saved.toolMs) && saved.toolMs >= 0) {
      out.toolMs = saved.toolMs;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Save (or forget, with `null`) one watchdog value for this directory.
 *
 * Merges into the existing file like `saveWorktreeMapping` — `writeProjectMeta`
 * rewrites it wholesale and would drop other keys — and removes the `timeouts`
 * object entirely once nothing is saved, so the file does not accumulate
 * empty shells.
 */
export function writeProjectTimeouts(patch: { idleMs?: number | null; toolMs?: number | null }): void {
  const dir = ROSSII_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  let meta: Record<string, any> = {};
  if (existsSync(path)) {
    try {
      meta = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      meta = {};
    }
  }

  const current: ProjectTimeouts =
    meta.timeouts && typeof meta.timeouts === "object" ? { ...meta.timeouts } : {};

  for (const [key, value] of Object.entries(patch) as Array<["idleMs" | "toolMs", number | null | undefined]>) {
    if (value === undefined) continue;
    if (value === null) delete current[key];
    else current[key] = value;
  }

  if (Object.keys(current).length > 0) meta.timeouts = current;
  else delete meta.timeouts;

  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
}

// ─── Worktree mapping ─────────────────────────────────────────────────────────

/** Save a session-to-worktree mapping in the project meta */
export function saveWorktreeMapping(sessionName: string, worktreePath: string): void {
  const dir = ROSSII_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  let meta: Record<string, any> = {};
  if (existsSync(path)) {
    try { meta = JSON.parse(readFileSync(path, "utf-8")); } catch { meta = {}; }
  }

  if (!meta.worktrees) meta.worktrees = {};
  meta.worktrees[sessionName] = worktreePath;

  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
}

/** Remove a session-to-worktree mapping from the project meta */
export function removeWorktreeMapping(sessionName: string): void {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return;

  try {
    const meta = JSON.parse(readFileSync(path, "utf-8"));
    if (meta.worktrees?.[sessionName]) {
      delete meta.worktrees[sessionName];
      writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
    }
  } catch { /* ignore */ }
}

/** Get all worktree mappings for this project: { sessionName → worktreePath } */
export function getWorktreeMappings(): Record<string, string> {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return {};
  try {
    const meta = JSON.parse(readFileSync(path, "utf-8"));
    return meta.worktrees ?? {};
  } catch { return {}; }
}