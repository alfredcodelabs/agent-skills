---
name: taskbrief
description: Share repository working memory across sessions and agents, including tasks, exact next steps, current findings, and ownership. Use when the user asks where work stopped or what another session is doing, when recording or resuming a specific task, before a detour, when finding something costly to rediscover, or before the session ends or compacts.
---

# Working memory

`T=.agents/skills/taskbrief/scripts/taskbrief.mjs`; `node "$T" <command>`.
Adjust `T` to the installation location; use an absolute path if the skill is outside the repository.
Output is compact: one line per task, `#id title [state owner age] ←#parent › next step`.
Do not query it automatically at startup: read it when the user asks or when recording something.

## Adapt to the project

Adapt the script path, session identity, and task vocabulary to the project and its business context.
Requires Node.js 22.13+ with `node:sqlite` and Git to locate the default database.
In a workspace with multiple repositories, each repository has its own database; worktrees of
one repository share it. `TASKBRIEF_DB` selects a different local location.

Set `TASKBRIEF_SESSION` to a stable, distinct identifier per session; the program uses its first
eight characters. It also recognizes `CLAUDE_CODE_SESSION_ID`. Without either variable, it uses
a PID whose stability depends on the environment. A task claim is neither a file lock nor
authorization to start other sessions or delegate work.

## Resume

- “Where were we?” → `recent`: tasks left around the same time (up to three by default). Show
  them and let the user choose; then `take ID` marks the task `active` under your identity and
  returns its context. Other sessions will no longer see it in `recent`. Continue from `next:`
  without reconstructing everything else.
- “What is the other session doing?” → `board`.
- `stale` means the owning session stopped updating for more than 30 minutes and the task can
  be claimed. If `take` reports another owner, do not force it; ask the user.

## While working

- New task: `new "<goal>"`. Every write renews your claim.
- After each step: `next "<exact step>"` with a file, command, or case; never just “continue.”
- Record only what would be costly to rediscover:
  `note -k found|bug|decided|tried|blocked|research "<text>"`.
  Do not repeat what the diff, code, or Git already records.
- Prune: `rm nID` deletes discarded or incorrect notes; `hide nID` removes resolved notes from summaries.
- Detour: `new "<detour>" -r "<exact return step>"` (`-r` is required with an active task).
  `done "<result>"` closes it and returns to the previous task and its `next` step.
- Noncritical finding: `new "<finding>" --park`, then continue.
- Consolidation: `show ID --tree` includes current notes from each subtask.
- Another task or session: use `-t ID` with `note`/`next`/`show`, for example to report a test
  finding to the implementation task.

## Close

- Completed: `done "<result>"`; abandoned: `drop "<reason>"`.
- When the session ends or the user asks: `pause "<exact step>"` releases the task for another
  session. If the environment supports clearing context, explain that notes and the next step
  have been saved.

## Rules

- Keep secrets, tokens, and personal data out of titles and notes.
- Usage errors return exit code 2 with a reason. Use `--json` for full output.
- The database lives in the Git common directory (`.git/taskbrief.sqlite3`), is shared across
  worktrees, and is never versioned. `TASKBRIEF_DB` overrides the location.

From this catalog root, `node skills/taskbrief/dev/taskbrief.test.mjs` runs the seven cases that
do not create commits. `dev/worktrees.test.mjs` separately contains a test that creates a temporary
commit. Do not run it or the full `node --test skills/taskbrief/dev/` suite when session instructions
forbid commits. Adjust paths if the skill is installed elsewhere.
