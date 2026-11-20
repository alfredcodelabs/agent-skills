import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FindbriefError } from "../scripts/config.mjs";
import { createPorts } from "../scripts/findbrief.mjs";
import { refreshIndex } from "../scripts/store.mjs";

function committedRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "store-repo-")),
    home = mkdtempSync(path.join(tmpdir(), "store-home-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(root, "queue.rs"), "pub struct InjectedQueue;\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "feat: add queue");
  writeFileSync(path.join(root, "draft.rs"), "pub struct UntrackedDraft;\n");
  return { root, home, cleanup: () => [root, home].forEach((dir) => rmSync(dir, { recursive: true, force: true })) };
}

test("the index reads git, the clock and the environment only through injected ports", () => {
  const repository = committedRepository();
  try {
    const real = createPorts({ environment: { FINDBRIEF_HOME: repository.home } });
    const subcommands = [];
    let clockReads = 0;
    const recording = {
      ...real,
      git: (cwd, args, input) => {
        subcommands.push(args[0]);
        return real.git(cwd, args, input);
      },
      now: () => {
        clockReads += 1;
        return Number.MAX_SAFE_INTEGER;
      },
    };
    const { db, head } = refreshIndex(recording, repository.root);
    assert.match(head, /^[0-9a-f]{40,64}$/);
    assert.deepEqual(
      db
        .prepare("SELECT path FROM stamp")
        .all()
        .map((row) => row.path),
      ["draft.rs"],
    );
    assert.equal(db.prepare("SELECT count(*) n FROM sym WHERE name='InjectedQueue'").get().n, 1);
    db.close();
    assert.deepEqual(subcommands, ["ls-files", "status", "hash-object", "log", "log"]);
    assert.ok(clockReads > 0);
    const failing = {
      ...recording,
      git: (cwd, args) =>
        args[0] === "status" ? { status: 128, stdout: "", stderr: "fatal: injected\n" } : real.git(cwd, args),
    };
    assert.throws(
      () => refreshIndex(failing, repository.root),
      (error) => error instanceof FindbriefError && error.message === "git status: fatal: injected",
    );
  } finally {
    repository.cleanup();
  }
});
