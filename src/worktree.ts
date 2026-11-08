/**
 * Git worktree management for rossii sessions
 *
 * Convention:
 *   Worktree path: <repo-root>/.worktree/<sanitized-session-name>
 *   Branch name:   <sanitized-session-name>
 *
 * Worktrees live inside the repo in .worktree/ which is gitignored.
 * This keeps everything self-contained and discoverable from the project root.
 *
 * Every git call goes through `execFile`-style argv (never a shell string), so
 * spaces, quotes and `$` in a repository path cannot break or hijack a command.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, dirname, basename, sep } from "node:path";
import pc from "picocolors";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Prefix for the .worktree directory name under repo root */
const WORKTREE_DIR = ".worktree";

// ─── Git helpers ─────────────────────────────────────────────────────────────

interface GitOptions {
  cwd?: string;
  timeout?: number;
}

/** Run git with an argv array (no shell) and return stdout. Throws on failure. */
function git(args: string[], opts: GitOptions = {}): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    cwd: opts.cwd,
    timeout: opts.timeout ?? 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run git and return stdout, or null when the command fails. */
function tryGit(args: string[], opts: GitOptions = {}): string | null {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

// ─── Git repo detection ───────────────────────────────────────────────────────

/** Check if CWD is inside a git repository */
export function isInsideGitRepo(): boolean {
  return tryGit(["rev-parse", "--git-dir"], { timeout: 3_000 }) !== null;
}

/**
 * Get the main repository root.
 *
 * Inside a rossii worktree `<repo>/.worktree/<name>` git reports the worktree
 * itself as `--show-toplevel`. Treating that as the repo root would nest the
 * next worktree at `<repo>/.worktree/<name>/.worktree/<name>` and make the
 * existing session worktree invisible — so the suffix is cut off here.
 */
export function getRepoRoot(): string | null {
  try {
    const top = git(["rev-parse", "--show-toplevel"], { timeout: 3_000 }).trim();
    if (!top) return null;
    return mainRepoRoot(top);
  } catch {
    return null;
  }
}

/** Strip a trailing `/.worktree/<name>` from a `--show-toplevel` result. */
function mainRepoRoot(toplevel: string): string {
  const root = resolve(toplevel);
  const marker = `${sep}${WORKTREE_DIR}${sep}`;
  const index = root.indexOf(marker);
  return index > 0 ? root.slice(0, index) : root;
}

// ─── Naming helpers ───────────────────────────────────────────────────────────

/** Sanitize session name for use as a directory/branch name */
function sanitize(sessionName: string): string {
  return sessionName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 80);
}

/**
 * Get the worktree path for a session.
 * Path: <repo-root>/.worktree/<sanitized-session-name>
 *
 * This keeps all worktrees inside the repo in a single hidden directory.
 * The .worktree/ directory should be in .gitignore (added automatically).
 */
export function getWorktreePath(repoRoot: string, sessionName: string): string {
  return join(repoRoot, WORKTREE_DIR, sanitize(sessionName));
}

/** Check if a path is inside the .worktree directory (i.e. rossii-managed) */
function isRossiiWorktree(repoRoot: string, path: string): boolean {
  const root = resolve(join(repoRoot, WORKTREE_DIR));
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(root + sep);
}

/** Get the git branch name for a session worktree */
export function getBranchName(sessionName: string): string {
  return sanitize(sessionName);
}

// ─── Worktree state ──────────────────────────────────────────────────────────

export interface WorktreeState {
  /** Absolute worktree path (whether or not it exists) */
  path: string;
  /** Branch checked out in the worktree, or null when there is none */
  branch: string | null;
  /** Directory exists on disk */
  exists: boolean;
  /** Uncommitted changes (tracked or untracked) in the worktree */
  dirty: boolean;
}

/** Is the worktree at `path` dirty? Returns false when it cannot be inspected. */
function isDirty(path: string): boolean {
  const status = tryGit(["status", "--porcelain"], { cwd: path, timeout: 3_000 });
  return status !== null && status.trim().length > 0;
}

/** Branch currently checked out at `path`, or null for a detached HEAD. */
function currentBranch(path: string): string | null {
  const branch = tryGit(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3_000 })?.trim();
  return branch && branch !== "HEAD" ? branch : null;
}

/**
 * Inspect a session's worktree without touching it — used by the delete dialog
 * to warn before uncommitted work is thrown away. Returns null outside a repo.
 */
export function getWorktreeState(sessionName: string): WorktreeState | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;

  const path = getWorktreePath(repoRoot, sessionName);
  const exists = existsSync(path);
  return {
    path,
    branch: exists ? currentBranch(path) ?? getBranchName(sessionName) : null,
    exists,
    dirty: exists && isDirty(path),
  };
}

// ─── Worktree CRUD ───────────────────────────────────────────────────────────

/**
 * Check if a worktree path already exists in git's worktree registry.
 * Also checks if the directory exists on disk.
 */
function worktreeExists(path: string): boolean {
  const output = tryGit(["worktree", "list", "--porcelain"]);
  if (output === null) return false;

  // Entries are separated by a blank line; the first field is `worktree <path>`.
  const inRegistry = output.split(/\n\n+/).some((entry) =>
    entry.split("\n").some((line) =>
      line.startsWith("worktree ") && resolve(line.slice(9).trim()) === resolve(path),
    ),
  );
  return inRegistry && existsSync(path);
}

/**
 * Create a git worktree for a session.
 * Returns the worktree path on success, null on failure.
 */
export function createWorktree(sessionName: string): string | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;

  const path = getWorktreePath(repoRoot, sessionName);
  const branch = getBranchName(sessionName);

  // Already exists — just return the path
  if (worktreeExists(path)) return path;

  // Check for uncommitted changes in the main worktree
  const status = tryGit(["status", "--porcelain"], { cwd: repoRoot, timeout: 3_000 });
  if (status !== null && status.trim().length > 0) {
    console.log(pc.yellow("⚠ uncommitted changes detected — creating worktree from current HEAD"));
  }

  // Ensure parent dir exists — git worktree add won't create it
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // Create worktree with a new branch from HEAD
  try {
    git(["worktree", "add", "-b", branch, path], { cwd: repoRoot, timeout: 15_000 });
    return path;
  } catch (err) {
    // Stale registration — worktree missing from disk but git still knows it.
    // Prune it and try again.
    if (String(err).includes("missing but already registered")) {
      tryGit(["worktree", "prune"], { cwd: repoRoot });
      console.log(pc.dim(`  🧹 Pruned stale worktree registration`));
      try {
        git(["worktree", "add", "-b", branch, path], { cwd: repoRoot, timeout: 15_000 });
        return path;
      } catch (e) {
        console.log(pc.red(`✗ Failed to create worktree: ${e}`));
        return null;
      }
    }

    // Branch may already exist — try attaching to existing branch
    try {
      git(["worktree", "add", path, branch], { cwd: repoRoot, timeout: 15_000 });
      return path;
    } catch (e2) {
      console.log(pc.red(`✗ Failed to create worktree: ${e2}`));
      return null;
    }
  }
}

/** Result of removing a session worktree. */
export type WorktreeRemoval =
  /** Worktree (and optionally its branch) is gone */
  | "removed"
  /** Uncommitted changes found and `force` was not set — nothing was deleted */
  | "dirty"
  /** Nothing to remove, or git refused */
  | "failed";

export interface RemoveWorktreeOptions {
  /** Remove even with uncommitted changes (they are lost). Default false. */
  force?: boolean;
  /**
   * Delete the session branch once the worktree is gone. Default true, but a
   * branch with commits that are not reachable from HEAD is always kept (and
   * reported) so deleting a session cannot discard work that was never merged.
   */
  pruneBranch?: boolean;
}

/**
 * Remove a git worktree for a session.
 *
 * Refuses to delete a dirty worktree unless `force` is set, so a mis-click in
 * the session picker cannot throw away uncommitted work. Removal is limited to
 * paths under `<repo>/.worktree/`; any other path is never touched.
 */
export function removeWorktree(
  sessionName: string,
  opts: RemoveWorktreeOptions = {},
): WorktreeRemoval {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return "failed";

  const path = getWorktreePath(repoRoot, sessionName);
  if (!isRossiiWorktree(repoRoot, path)) return "failed";

  const exists = existsSync(path);
  const registered = worktreeExists(path);

  // Nothing to remove
  if (!exists && !registered) {
    if (opts.pruneBranch !== false) pruneUnmergedBranch(repoRoot, getBranchName(sessionName));
    return "removed";
  }

  if (exists && !opts.force && isDirty(path)) return "dirty";

  const branch = exists ? currentBranch(path) : null;

  try {
    git(["worktree", "remove", ...(opts.force ? ["--force"] : []), path], {
      cwd: repoRoot,
      timeout: 10_000,
    });
  } catch {
    // The directory may be stale (not a registered worktree) or git refused.
    // Drop the registration first, then the directory — but only inside
    // .worktree/, which the guard above already proved.
    tryGit(["worktree", "prune"], { cwd: repoRoot });
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        return "failed";
      }
    }
  }

  if (existsSync(path)) return "failed";

  if (opts.pruneBranch !== false) {
    pruneUnmergedBranch(repoRoot, branch ?? getBranchName(sessionName));
  }
  return "removed";
}

/** Is every commit of `branch` already reachable from the repo's HEAD? */
function branchFullyMerged(repoRoot: string, branch: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", branch, "HEAD"], { cwd: repoRoot, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Does a local branch with this name exist? */
function localBranchExists(repoRoot: string, branch: string): boolean {
  return tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot }) !== null;
}

/**
 * Delete the session branch, but only when all of its commits are already in
 * HEAD. An unmerged branch is kept (and its name printed) — a deleted session
 * must not be the reason a piece of work disappears.
 */
function pruneUnmergedBranch(repoRoot: string, branch: string): void {
  if (!branch || !localBranchExists(repoRoot, branch)) return;

  if (!branchFullyMerged(repoRoot, branch)) {
    console.log(pc.dim(`  🌿 kept branch ${pc.green(branch)} (has commits not in HEAD)`));
    return;
  }

  // Fails harmlessly when the branch is checked out in another worktree.
  tryGit(["branch", "-D", branch], { cwd: repoRoot, timeout: 5_000 });
}

/**
 * Get all rossii-managed worktree paths for the current repo.
 * Returns empty array if not in a git repo.
 *
 * Parses `git worktree list --porcelain` format:
 *   worktree <path>
 *   HEAD <sha1>
 *   branch <ref>       (absent for detached HEAD)
 *   (empty line separates entries)
 */
export function getRepoWorktreePaths(): string[] {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return [];

  const output = tryGit(["worktree", "list", "--porcelain"]);
  if (output === null) return [];

  const worktrees: string[] = [];
  for (const entry of output.split(/\n\n+/)) {
    if (!entry.trim()) continue;
    let path = "";
    for (const line of entry.split("\n")) {
      if (line.startsWith("worktree ")) path = resolve(line.slice(9).trim());
    }
    if (path && isRossiiWorktree(repoRoot, path)) worktrees.push(path);
  }
  return worktrees;
}

/**
 * Get all directory paths that are part of this project:
 * - The repo root (if in a git repo)
 * - All rossii-managed worktree paths
 * Falls back to [cwd] if not in a git repo.
 *
 * Used for session listing: sessions in worktrees have a different
 * working_dir but belong to the same project.
 */
export function getProjectSessionDirs(cwd: string): string[] {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return [cwd];
  return [repoRoot, ...getRepoWorktreePaths()];
}

/**
 * Check if a session has an associated worktree.
 * Returns the worktree path if it exists, null otherwise.
 */
export function getSessionWorktreePath(sessionName: string): string | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;

  const path = getWorktreePath(repoRoot, sessionName);
  return worktreeExists(path) ? path : null;
}

/**
 * Get all session names that have rossii-managed worktrees in this repo.
 * Useful for session listing: sessions in worktrees should show up
 * even though their working_dir differs from the main repo CWD.
 *
 * Extracts the session name from the directory name inside .worktree/.
 */
export function getWorktreeSessionNames(): string[] {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return [];

  const output = tryGit(["worktree", "list", "--porcelain"]);
  if (output === null) return [];

  const names: string[] = [];
  for (const entry of output.split(/\n\n+/)) {
    if (!entry.trim()) continue;
    let path = "";
    for (const line of entry.split("\n")) {
      if (line.startsWith("worktree ")) path = resolve(line.slice(9).trim());
    }
    if (path && isRossiiWorktree(repoRoot, path)) {
      const name = basename(path);
      if (name) names.push(name);
    }
  }
  return names;
}
