import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "taskbrief.mjs");

// Creates a temporary commit. Do not run when session instructions forbid commits.
test("the CLI stores one private database in the git common directory, shared by worktrees", () => {
  const root = mkdtempSync(path.join(tmpdir(), "taskbrief-repo-"));
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "--detach", path.join(root, "wt"));
  const env = { ...process.env, TASKBRIEF_SESSION: "cli" };
  delete env.TASKBRIEF_DB;
  const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env });
  assert.equal(cli(root, "new", "Shared").status, 0);
  assert.match(cli(path.join(root, "wt"), "board").stdout, /#1 Shared/);
  assert.equal(statSync(path.join(root, ".git", "taskbrief.sqlite3")).mode & 0o777, 0o600);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout, "?? wt/\n");
  const outside = cli(tmpdir());
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /not inside a git repository/);
});
