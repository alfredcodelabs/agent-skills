# taskbrief

A small working memory that coding agents share across sessions in one repository. It records
which tasks are in progress, the exact step each one stopped at, the findings that still matter,
and which session holds which task.

It needs only Node.js 22.13+ (built-in `node:sqlite`) and git. Adapt script paths, session identity and task vocabulary to the target project and business context.

It complements [findbrief](../findbrief/), which answers what is in the repository and why. taskbrief
answers what we were doing and where we stopped.

## Why

Agent sessions end in the middle of work: token limits, compaction, a closed terminal, a detour
into a bug. Whatever the session learned dies with its context, and the next session starts blind.
taskbrief keeps that in the repository instead:

- **Ask where you stopped.** "Where were we?" lists the 2–3 tasks left around the same time. The
  user picks one, and that session takes it with its next step and live notes. Other sessions stop
  seeing it.
- **Take over abandoned work.** A task held by a session that died becomes `stale` after a 30-minute
  lease. Any agent can take it with its know-how intact.
- **Run sessions in parallel.** One session develops while another tests. The tester adds a `bug`
  note to the developer's task, and the developer sees it on its next `show`.
- **Keep context small.** Nothing loads at session start. Each answer is one line per task, notes
  can be deleted or hidden as they stop mattering, and only what is asked enters the context. That
  makes `/clear` cheap: save, clear, take the task again.

## Commands

```text
board                       open tasks, one line each
recent [-n N]               resumable tasks left around the same time (default 3)
new TITLE [-r RESUME]       create and take; -r is required when you already hold a task (detour)
new TITLE --park            backlog item, not taken
take ID                     claim a task and print its brief
show [ID] [--all] [--tree]  brief: next step, live notes, subtasks (--tree adds their notes, --all hidden ones)
next TEXT [-t ID]           set the exact next step
note TEXT [-k KIND] [-t ID] KIND: note found bug decided tried blocked research
rm NOTE..  /  hide NOTE..   delete a note, or hide a resolved one
pause [NEXT]                release the task for another session
done [TEXT]  /  drop [TEXT] close the task and print the one it returns to
```

Line format: `#id title [state owner age] ←#parent › next step`. Every command accepts `--json`.
Usage errors exit with status 2.

Example:

```text
$ node taskbrief.mjs recent
#12 EventBridge egress [stale 2h] › rerun blackbox case 3
#14 Firehose HTTP retries [paused 3h] › read fanout.rs retry loop
$ node taskbrief.mjs take 12
#12 EventBridge egress [active claude:5f1c09aa now]
next: rerun blackbox case 3
n31 decided: denied destinations are terminal (DLQ)
n35 bug: Retry-After HTTP dates are ignored
#13 Fix TTL clamp panic (done: clamped before Duration)
```

## Install

```sh
cp -r taskbrief <your-repo>/.agents/skills/taskbrief
```

`SKILL.md` refers to the CLI as `.agents/skills/taskbrief/scripts/taskbrief.mjs`; update that path
if your agent loads skills from somewhere else. Mention the skill in `AGENTS.md` so that every
agent finds it. `dev/` holds the tests. The full suite creates a commit in a temporary repository to verify
worktree sharing in `dev/worktrees.test.mjs`. It is separated from the seven core tests.
Do not run it or the whole directory when the session forbids commits. From this catalog root,
run the remaining cases with:

```sh
node skills/taskbrief/dev/taskbrief.test.mjs
```

There is no session-start hook on purpose: the user asks, and the agent answers.

## How it works

- **Storage.** One SQLite database at `<git common dir>/taskbrief.sqlite3`.
  - All worktrees of the repository share it, and git never versions it.
  - It uses WAL mode and file mode `0600`.
  - `TASKBRIEF_DB` overrides the path.
- **Sessions.** The session comes from `TASKBRIEF_SESSION` (first eight characters), then `CLAUDE_CODE_SESSION_ID`, then the
  agent's process ID (the parent of the shell that runs the command).
- **Claims.** Each command runs in one `BEGIN IMMEDIATE` transaction. `take` is a conditional
  update, so only one of several sessions racing for a task wins it.
  - Every write by a session renews the 30-minute lease on all of its active tasks.
  - An expired lease is read as `stale`; no background process cleans up.
- **Current task.** A session's current task is the latest active task it holds that has no
  active subtask. A detour is a subtask, and closing it returns to its parent.
- **Recent.** Paused or stale tasks, plus your own, by last activity: the most recent one and those
  left within 3 hours of it, at most `-n`.
- **Input.** Text is flattened to one line, with 200 characters for a title and 1,000 for other text.
  git runs without fsmonitor and without optional locks.

## Limitations

- **Agent discipline.** The memory is only as good as the `next` steps and notes the agent writes.
  `-r` is enforced for detours.
- **Sessions in one shell.** Agents without a session variable fall back to their process ID. Two
  agents that share one shell need distinct, stable `TASKBRIEF_SESSION` values whose first eight
  characters differ. A task claim does not lock files or authorize delegation.
- **No push notifications.** A session sees other sessions' notes only when it reads them.
