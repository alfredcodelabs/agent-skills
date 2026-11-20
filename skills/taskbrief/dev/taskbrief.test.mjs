import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clean, main, sessionOf } from "../scripts/taskbrief.mjs";

const HOUR = 3600;

function world() {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "taskbrief-")), "tb.sqlite3");
  let now = 1_800_000_000;
  const as = (session) => (...argv) => main(argv, { cwd: tmpdir(), env: { TASKBRIEF_DB: db, TASKBRIEF_SESSION: session }, parentPid: 1, now }).trimEnd();
  const fails = (session, ...argv) => assert.throws(() => as(session)(...argv), { name: "TaskbriefError" });
  return { db, as, fails, advance: (seconds) => (now += seconds) };
}

test("a detour requires the resume step and returns to the parent with its live notes", () => {
  const w = world();
  const a = w.as("a");
  assert.equal(a(), "nothing open");
  assert.match(a("new", "Implement egress"), /^#1 Implement egress \[active session:a now\]$/);
  a("note", "-k", "decided", "denial is terminal");
  w.fails("a", "new", "Fix TTL panic");
  assert.match(a("new", "Fix TTL panic", "-r", "rerun case 3"), /^#2 Fix TTL panic \[active session:a now\] ←#1$/);
  a("note", "-k", "bug", "from_secs_f64 panics on inf");
  assert.equal(
    a("done", "clamped"),
    ["#2 done: clamped", "#1 Implement egress [active session:a now]", "next: rerun case 3", "n1 decided: denial is terminal", "#2 Fix TTL panic (done: clamped)"].join("\n"),
  );
});

test("notes are pruned: rm deletes, hide keeps them only for --all", () => {
  const w = world();
  const a = w.as("a");
  a("new", "Research");
  a("note", "-k", "research", "option A");
  a("note", "-k", "tried", "option B failed");
  a("note", "keep this");
  a("rm", "n1");
  a("hide", "2");
  assert.doesNotMatch(a("show"), /option/);
  assert.match(a("show", "--all"), /n2 tried: option B failed \(hidden\)/);
  assert.doesNotMatch(a("show", "--all"), /option A/);
  w.fails("a", "rm", "n1");
});

test("recent offers the tasks left around the same time, and a taken one disappears for other sessions", () => {
  const w = world();
  const a = w.as("a");
  a("new", "Old task");
  a("pause", "old step");
  w.advance(48 * HOUR);
  a("new", "Task one");
  a("pause");
  w.advance(HOUR);
  a("new", "Task two");
  a("next", "exact step two");
  w.advance(10 * 60);
  const b = w.as("b");
  const c = w.as("c");
  assert.equal(b("recent"), "#2 Task one [paused 1h]");
  w.advance(HOUR);
  const offered = c("recent");
  assert.equal(offered, "#3 Task two [stale 1h] › exact step two\n#2 Task one [paused 2h]");
  assert.doesNotMatch(offered, /Old task/);
  assert.match(b("take", "3"), /^#3 Task two \[active session:b now\]/);
  assert.doesNotMatch(c("recent"), /Task two/);
  w.fails("c", "take", "3");
  assert.match(c("board"), /#3 Task two \[active session:b now\]/);
});

test("an abandoned task keeps its know-how and another session can take it after the lease", () => {
  const w = world();
  const a = w.as("a");
  a("new", "Long work");
  a("next", "run step 4");
  a("note", "-k", "found", "root cause in ttl.rs");
  w.advance(10 * 60);
  w.fails("b", "take", "1");
  w.advance(HOUR);
  const taken = w.as("b")("take", "#1");
  assert.match(taken, /next: run step 4/);
  assert.match(taken, /found: root cause in ttl.rs/);
  w.fails("a", "next", "x");
});

test("sessions share notes on any open task, e.g. a tester reporting to a developer", () => {
  const w = world();
  const dev = w.as("dev");
  const tester = w.as("tester");
  dev("new", "Egress");
  dev("new", "Test egress", "--park");
  assert.match(tester("take", "2"), /#2 Test egress \[active session:tester now\] ←#1/);
  tester("note", "-t", "1", "-k", "bug", "case 3 returns 500");
  assert.match(dev("show"), /n1 bug: case 3 returns 500/);
  assert.match(dev("show"), /#2 Test egress \(active\)/);
  tester("note", "-k", "blocked", "needs real AWS");
  assert.doesNotMatch(dev("show"), /needs real AWS/);
  assert.match(dev("show", "--tree"), /#2 Test egress \(active\)\n  n2 blocked: needs real AWS/);
});

test("ownership, closed tasks and usage errors fail with a TaskbriefError", () => {
  const w = world();
  for (const argv of [["bogus"], ["next", "x"], ["new"], ["take", "x"], ["take", "9"], ["show", "-z"], ["note", "-k", "rumor", "x"], ["new", "x", "-r"]]) {
    w.fails("a", ...argv);
  }
  const a = w.as("a");
  a("new", "Finish");
  a("done");
  w.fails("a", "take", "1");
  assert.match(a("show", "1"), /#1 Finish \[done/);
  assert.equal(JSON.parse(a("board", "--json")).length, 0);
});

test("input is flattened and bounded; sessions come from the agent environment", () => {
  assert.equal(clean("a\nb\u0007\tc d"), "a b c d");
  assert.equal(clean("x".repeat(20), 5), "xxxx…");
  assert.equal(sessionOf({ CLAUDE_CODE_SESSION_ID: "0123456789abcdef" }, 1), "claude:01234567");
  assert.equal(sessionOf({ TASKBRIEF_SESSION: "tester", CLAUDE_CODE_SESSION_ID: "x" }, 1), "session:tester");
  assert.match(sessionOf({}, process.pid), /^pid:\d+$/);
});
