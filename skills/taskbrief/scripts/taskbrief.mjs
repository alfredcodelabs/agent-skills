#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cli, closing, environment, git, limits, lookupTable, messages, noteKinds, schema, status, TaskbriefError } from "./config.mjs";

async function importSqliteQuietly() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => (/SQLite/.test(String(warning)) ? undefined : emitWarning.call(process, warning, ...rest));
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

const { DatabaseSync } = await importSqliteQuietly();

export function clean(text, maximum = limits.textChars) {
  const flat = String(text ?? "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > maximum ? flat.slice(0, maximum - 1) + limits.ellipsis : flat;
}

function fail(message) {
  throw new TaskbriefError(message);
}

function agentPid(pid) {
  try {
    const stat = readFileSync(environment.procStat(pid), "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || pid;
  } catch {
    return pid;
  }
}

export function sessionOf(env, parentPid) {
  for (const [variable, label] of environment.sessions) {
    const value = clean(env[variable], 64);
    if (value) {
      return `${label}:${value.slice(0, environment.ownerChars)}`;
    }
  }
  return `pid:${agentPid(parentPid)}`;
}

function databasePath(env, cwd) {
  if (env[environment.database]) {
    return path.resolve(cwd, env[environment.database]);
  }
  const result = spawnSync("git", [...git.safety, ...git.commonDirectory], { cwd, encoding: "utf8", env: { ...env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.error || result.status !== 0) {
    fail(result.status === 128 ? messages.notInRepository : messages.gitFailed(result.stderr || String(result.error)));
  }
  return path.join(realpathSync(result.stdout.trim()), environment.databaseFile);
}

function openDatabase(file) {
  const db = new DatabaseSync(file, { timeout: limits.busyTimeoutMs });
  db.exec(schema);
  chmodSync(file, environment.fileMode);
  return db;
}

function parseId(value) {
  const match = cli.idPattern.exec(String(value ?? ""));
  if (!match || Number(match[1]) < 1) {
    fail(messages.notAnId(value));
  }
  return Number(match[1]);
}

const optionValues = lookupTable({
  flag: () => true,
  text: (option, value) => (value === undefined ? fail(messages.optionNeedsValue(option)) : value),
  id: (option, value) => parseId(optionValues.text(option, value)),
});

function parseArguments(argv) {
  const options = {};
  const words = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = cli.aliases[argv[at]] ?? argv[at];
    if (!arg.startsWith(cli.optionPrefix) || arg === cli.optionPrefix) {
      words.push(arg);
      continue;
    }
    const option = cli.options[arg] ?? fail(messages.unknownOption(arg));
    options[option.name] = optionValues[option.value](arg, argv[at + 1]);
    at += option.value === "flag" ? 0 : 1;
  }
  const [command = cli.defaultCommand, ...rest] = words;
  return { command, rest, options };
}

function requiredText(command, words, maximum) {
  return clean(words.join(" "), maximum) || fail(messages.needsText(command));
}

function createStore(db, session, now) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const withState = (task) => task && { ...task, state: task.status === status.active && task.lease < now ? status.stale : task.status };
  const isClosed = (task) => task.status === status.done || task.status === status.dropped;
  const store = {
    now,
    task: (id) => withState(one("SELECT * FROM tasks WHERE id = ?", id)) ?? fail(messages.unknownTask(id)),
    openTask: (id) => {
      const task = store.task(id);
      return isClosed(task) ? fail(messages.closedTask(task)) : task;
    },
    current: () =>
      withState(
        one(
          `SELECT * FROM tasks t WHERE owner = ? AND status = 'active'
           AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent = t.id AND c.owner = t.owner AND c.status = 'active')
           ORDER BY updated DESC, id DESC LIMIT 1`,
          session,
        ),
      ),
    target: (id) => (id ? store.openTask(id) : store.current() ?? fail(messages.noCurrent)),
    heartbeat: () => run("UPDATE tasks SET lease = ? WHERE owner = ? AND status = 'active'", now + limits.leaseSeconds, session),
    create: (title, parent, active) =>
      Number(
        run(
          "INSERT INTO tasks (parent, title, status, owner, lease, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
          parent,
          title,
          active ? status.active : status.open,
          active ? session : null,
          active ? now + limits.leaseSeconds : 0,
          now,
          now,
        ).lastInsertRowid,
      ),
    claim: (id) =>
      run(
        `UPDATE tasks SET status = 'active', owner = ?, lease = ?, updated = ?
         WHERE id = ? AND status NOT IN ('done', 'dropped') AND (status != 'active' OR owner = ? OR lease < ?)`,
        session,
        now + limits.leaseSeconds,
        now,
        id,
        session,
        now,
      ).changes === 1,
    setNext: (id, text) => run("UPDATE tasks SET next = ?, updated = ? WHERE id = ?", text, now, id),
    addNote: (id, kind, text) => {
      run("INSERT INTO notes (task, kind, text, author, at) VALUES (?, ?, ?, ?, ?)", id, kind, text, session, now);
      run("UPDATE tasks SET updated = ? WHERE id = ?", now, id);
    },
    notes: (id, everything) => all(`SELECT * FROM notes WHERE task = ? ${everything ? "" : "AND live = 1"} ORDER BY id`, id),
    children: (id) => all("SELECT * FROM tasks WHERE parent = ? ORDER BY id", id),
    editNotes: (ids, sql) => {
      for (const id of ids) {
        if (run(sql, id).changes !== 1) {
          fail(messages.unknownNote(id));
        }
      }
    },
    release: (id, next) => run("UPDATE tasks SET status = 'paused', owner = NULL, lease = 0, next = COALESCE(?, next), updated = ? WHERE id = ?", next, now, id),
    close: (id, outcome, result) => run("UPDATE tasks SET status = ?, result = ?, owner = NULL, lease = 0, updated = ? WHERE id = ?", outcome, result, now, id),
    board: () => all("SELECT * FROM tasks WHERE status NOT IN ('done', 'dropped') ORDER BY updated DESC, id DESC LIMIT ?", limits.listMaximum).map(withState),
    resumable: () =>
      all(
        `SELECT * FROM tasks WHERE status = 'paused' OR (status = 'active' AND (lease < ? OR owner = ?))
         ORDER BY updated DESC, id DESC LIMIT ?`,
        now,
        session,
        limits.listMaximum,
      ).map(withState),
  };
  return store;
}

function brief(store, id, everything, tree = false) {
  const task = store.task(id);
  const notes = store.notes(id, everything);
  const children = store
    .children(id)
    .filter((child) => everything || child.status !== status.dropped)
    .map((child) => (tree ? { ...child, notes: store.notes(child.id, everything) } : child));
  const text = [
    messages.taskLine(task, store.now, false),
    task.next ? messages.next(task.next) : null,
    ...notes.map((note) => messages.note(note)),
    ...children.flatMap((child) => [messages.child(child), ...(child.notes ?? []).map((note) => messages.note(note, "  "))]),
  ];
  return { data: { ...task, notes, children }, text: text.filter(Boolean).join("\n") };
}

const taskList = (tasks, now, empty) => ({ data: tasks, text: tasks.length ? tasks.map((task) => messages.taskLine(task, now)).join("\n") : empty });
const single = (store, id) => ({ data: store.task(id), text: messages.taskLine(store.task(id), store.now) });
const ok = (data) => ({ data, text: messages.ok });

function closeTask(store, outcome, words, options) {
  const task = store.target(options.task);
  store.close(task.id, outcome, clean(words.join(" ")) || null);
  const closed = store.task(task.id);
  const back = store.current();
  if (!back) {
    return { data: { closed }, text: messages.closed(closed) };
  }
  const resumed = brief(store, back.id, false);
  return { data: { closed, resumed: resumed.data }, text: messages.closed(closed) + "\n" + resumed.text };
}

const commands = lookupTable({
  board: (store) => taskList(store.board(), store.now, messages.nothing),
  recent: (store, _, options) => {
    const candidates = store.resumable();
    const latest = candidates[0]?.updated ?? 0;
    const near = candidates.filter((task) => latest - task.updated <= limits.recentWindowSeconds);
    return taskList(near.slice(0, options.limit ?? limits.recentDefault), store.now, messages.nothingRecent);
  },
  new: (store, words, options) => {
    const title = requiredText("new", words, limits.titleChars);
    const parent = store.current();
    if (options.park) {
      return single(store, store.create(title, parent?.id ?? null, false));
    }
    const resume = clean(options.resume ?? "");
    if (parent) {
      store.setNext(parent.id, resume || fail(messages.resumeRequired(parent)));
    }
    return single(store, store.create(title, parent?.id ?? null, true));
  },
  take: (store, words) => {
    const task = store.openTask(parseId(words[0]));
    if (!store.claim(task.id)) {
      fail(messages.heldBy(task, store.now));
    }
    return brief(store, task.id, false);
  },
  show: (store, words, options) => brief(store, words[0] ? parseId(words[0]) : store.target(options.task).id, options.all === true, options.tree === true),
  next: (store, words, options) => {
    const task = store.target(options.task);
    store.setNext(task.id, requiredText("next", words));
    return ok(store.task(task.id));
  },
  note: (store, words, options) => {
    const kind = options.kind ?? "note";
    if (!noteKinds.has(kind)) {
      fail(messages.unknownKind(kind));
    }
    const task = store.target(options.task);
    store.addNote(task.id, kind, requiredText("note", words));
    return ok(store.notes(task.id, false).at(-1));
  },
  rm: (store, words) => {
    store.editNotes(words.map(parseId), "DELETE FROM notes WHERE id = ?");
    return ok(null);
  },
  hide: (store, words) => {
    store.editNotes(words.map(parseId), "UPDATE notes SET live = 0 WHERE id = ?");
    return ok(null);
  },
  pause: (store, words, options) => {
    const task = store.target(options.task);
    store.release(task.id, clean(words.join(" ")) || null);
    return single(store, task.id);
  },
  done: (store, words, options) => closeTask(store, closing.done, words, options),
  drop: (store, words, options) => closeTask(store, closing.drop, words, options),
});

const writes = new Set(["new", "take", "next", "note", "rm", "hide", "pause", "done", "drop"]);

export function main(argv, { cwd, env, parentPid, now }) {
  const { command, rest, options } = parseArguments(argv);
  const run = commands[command] ?? fail(messages.usage);
  const db = openDatabase(databasePath(env, cwd));
  try {
    const store = createStore(db, sessionOf(env, parentPid), now);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run(store, rest, options);
      if (writes.has(command)) {
        store.heartbeat();
      }
      db.exec("COMMIT");
      return options.json ? JSON.stringify(result.data) + "\n" : result.text + "\n";
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(main(process.argv.slice(2), { cwd: process.cwd(), env: process.env, parentPid: process.ppid, now: Math.floor(Date.now() / 1000) }));
  } catch (error) {
    if (!(error instanceof TaskbriefError)) {
      throw error;
    }
    process.stderr.write(`${messages.program}: ${error.message}\n`);
    process.exit(cli.errorExitStatus);
  }
}
