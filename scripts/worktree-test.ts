#!/usr/bin/env bun
/**
 * Integration tests for the git layer (src/worktree.ts).
 *
 * The unit suites cover parsing and planning; this one runs real git in a
 * throwaway repository — including a path with spaces, which a shell-string
 * `execSync("git worktree add \"${path}\"")` mangled.
 *
 * Pins:
 *   - a worktree is created, found and listed
 *   - a dirty worktree is NOT removed without `force`
 *   - a merged session branch is deleted, an unmerged one is kept
 *   - running inside a worktree resolves the main repo root (no nesting)
 *
 * Usage: bun scripts/worktree-test.ts   (or `bun run test`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWorktree,
  getRepoRoot,
  getRepoWorktreePaths,
  getSessionWorktreePath,
  getWorktreeState,
  isInsideGitRepo,
  removeWorktree,
} from "../src/worktree.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── Fixture ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "rossii-worktree-"));
// A space in the repo path is the point: argv-based git calls must survive it.
const repo = join(root, "repo with spaces");
const ORIGINAL_CWD = process.cwd();

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function branchExists(name: string): boolean {
  return git(["branch", "--list", name]).length > 0;
}

function setUpRepo(): void {
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "rossii test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  // rossii adds this to .gitignore in real repos; the fixture does the same
  // so `git status` stays clean after .worktree/ appears.
  writeFileSync(join(repo, ".gitignore"), ".worktree/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-qm", "gitignore"]);
}

// ─── Checks ──────────────────────────────────────────────────────────────────

type Check = [name: string, run: () => void];
const checks: Check[] = [];

checks.push(["a path with spaces does not break git calls", () => {
  assert.ok(repo.includes(" "), "fixture must exercise a path with a space");
  assert.equal(getRepoRoot(), resolve(repo));
  assert.equal(isInsideGitRepo(), true);
}]);

checks.push(["createWorktree creates the directory, branch and registry entry", () => {
  const path = createWorktree("session one");
  assert.equal(path, join(resolve(repo), ".worktree", "session_one"));
  assert.ok(existsSync(path!), "worktree directory must exist");
  assert.equal(branchExists("session_one"), true, "branch must be created");
  assert.equal(getSessionWorktreePath("session one"), path, "resume must find it");
  assert.deepEqual(getRepoWorktreePaths(), [path!]);
}]);

checks.push(["getWorktreeState reports branch, existence and dirtiness", () => {
  const state = getWorktreeState("session one");
  assert.ok(state);
  assert.equal(state.exists, true);
  assert.equal(state.dirty, false);
  assert.equal(state.branch, "session_one");
  assert.equal(state.path, join(resolve(repo), ".worktree", "session_one"));
}]);

checks.push(["a dirty worktree is refused unless force is set", () => {
  const path = getSessionWorktreePath("session one")!;
  writeFileSync(join(path, "uncommitted.txt"), "work in progress\n");
  assert.equal(getWorktreeState("session one")?.dirty, true);

  assert.equal(removeWorktree("session one"), "dirty", "must not delete uncommitted work");
  assert.ok(existsSync(path), "the worktree must still be there");
  assert.ok(branchExists("session_one"));

  assert.equal(removeWorktree("session one", { force: true }), "removed");
  assert.equal(existsSync(path), false, "forced removal deletes the directory");
  assert.equal(branchExists("session_one"), false, "a merged branch is cleaned up");
}]);

checks.push(["an unmerged session branch is kept after the worktree is gone", () => {
  const path = createWorktree("session two")!;
  writeFileSync(join(path, "feature.txt"), "real work\n");
  git(["add", "."], path);
  git(["commit", "-qm", "unmerged work"], path);

  assert.equal(removeWorktree("session two", { force: true }), "removed");
  assert.equal(existsSync(path), false);
  assert.equal(branchExists("session_two"), true, "unmerged commits must not disappear");
}]);

checks.push(["a session with no worktree is reported, not removed", () => {
  assert.equal(getWorktreeState("never existed")?.exists, false);
  assert.equal(getSessionWorktreePath("never existed"), null);
  assert.equal(removeWorktree("never existed"), "removed", "nothing to remove is a success");
}]);

checks.push(["running inside a worktree resolves the main repo root", () => {
  const path = createWorktree("session three")!;
  process.chdir(path);
  try {
    assert.notEqual(resolve(process.cwd()), resolve(repo), "must really be inside the worktree");
    assert.equal(getRepoRoot(), resolve(repo), "the main root, not the worktree");
    assert.equal(getSessionWorktreePath("session three"), path,
      "the existing worktree must stay visible — no nested .worktree/.worktree");
  } finally {
    process.chdir(repo);
  }
  assert.equal(removeWorktree("session three", { force: true }), "removed");
}]);

// ─── Runner ──────────────────────────────────────────────────────────────────

let failed = 0;
try {
  setUpRepo();
  process.chdir(repo);

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
} finally {
  process.chdir(ORIGINAL_CWD);
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n❌ ${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ ${checks.length} checks passed`);
