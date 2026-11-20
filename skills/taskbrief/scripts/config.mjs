function deepFreeze(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

export class TaskbriefError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskbriefError";
  }
}

export const lookupTable = (entries) => Object.assign(Object.create(null), entries);

export const limits = deepFreeze({
  titleChars: 200,
  textChars: 1000,
  leaseSeconds: 30 * 60,
  recentWindowSeconds: 3 * 60 * 60,
  recentDefault: 3,
  listMaximum: 100,
  busyTimeoutMs: 5000,
  ellipsis: "…",
});

export const environment = deepFreeze({
  database: "TASKBRIEF_DB",
  sessions: [
    ["TASKBRIEF_SESSION", "session"],
    ["CLAUDE_CODE_SESSION_ID", "claude"],
  ],
  databaseFile: "taskbrief.sqlite3",
  fileMode: 0o600,
  procStat: (pid) => `/proc/${pid}/stat`,
  ownerChars: 8,
});

export const git = deepFreeze({
  safety: ["-c", "core.fsmonitor=false", "--no-optional-locks"],
  commonDirectory: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
});

export const status = deepFreeze({ open: "open", active: "active", paused: "paused", done: "done", dropped: "dropped", stale: "stale" });
export const closing = deepFreeze(lookupTable({ done: status.done, drop: status.dropped }));
export const noteKinds = deepFreeze(new Set(["note", "found", "bug", "decided", "tried", "blocked", "research"]));

export const schema = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  parent INTEGER REFERENCES tasks(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  next TEXT,
  result TEXT,
  owner TEXT,
  lease INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  task INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 1,
  author TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(status, updated);
CREATE INDEX IF NOT EXISTS notes_by_task ON notes(task, live);
`;

const usage =
  "usage: tb [board] | recent [-n N] | new TITLE [-r RESUME] [--park] | take ID | show [ID] [--all] [--tree] | next TEXT [-t ID] | note TEXT [-k KIND] [-t ID] | rm NOTE.. | hide NOTE.. | pause [NEXT] | done [TEXT] | drop [TEXT]  [--json]";

export const cli = deepFreeze({
  aliases: lookupTable({ "-r": "--resume", "-k": "--kind", "-t": "--task", "-n": "--limit" }),
  options: lookupTable({
    "--resume": { name: "resume", value: "text" },
    "--kind": { name: "kind", value: "text" },
    "--task": { name: "task", value: "id" },
    "--limit": { name: "limit", value: "id" },
    "--park": { name: "park", value: "flag" },
    "--all": { name: "all", value: "flag" },
    "--tree": { name: "tree", value: "flag" },
    "--json": { name: "json", value: "flag" },
  }),
  optionPrefix: "-",
  defaultCommand: "board",
  errorExitStatus: 2,
  idPattern: /^[#nN]?(\d{1,9})$/,
});

const ago = (seconds) =>
  seconds < 60 ? "now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;

export const messages = deepFreeze({
  program: "taskbrief",
  usage,
  unknownOption: (option) => `${option}? ${usage}`,
  optionNeedsValue: (option) => `${option} needs a value`,
  notAnId: (value) => `not an id: ${value}`,
  needsText: (command) => `${command} needs text`,
  unknownKind: (kind) => `kind: ${[...noteKinds].join("|")}, not ${kind}`,
  noCurrent: "no task of yours is active; take ID or new TITLE",
  resumeRequired: (task) => `#${task.id} is active: add -r "<exact next step in #${task.id}>"`,
  unknownTask: (id) => `no task #${id}`,
  unknownNote: (id) => `no note n${id}`,
  closedTask: (task) => `#${task.id} is ${task.status}`,
  heldBy: (task, now) => `#${task.id} is held by ${task.owner} (${ago(now - task.updated)} ago); wait for its lease or ask the user`,
  notInRepository: "not inside a git repository",
  gitFailed: (stderr) => `git: ${stderr.trim()}`,
  nothing: "nothing open",
  nothingRecent: "nothing to resume",
  taskLine: (task, now, withNext = true) =>
    `#${task.id} ${task.title} [${task.state}${task.owner && task.state === status.active ? ` ${task.owner}` : ""} ${ago(now - task.updated)}]` +
    (task.parent ? ` ←#${task.parent}` : "") +
    (withNext && task.next ? ` › ${task.next}` : ""),
  next: (text) => `next: ${text}`,
  note: (note, indent = "") => `${indent}n${note.id} ${note.kind === "note" ? "" : note.kind + ": "}${note.text}${note.live ? "" : " (hidden)"}`,
  child: (task) => `#${task.id} ${task.title} (${task.status}${task.result ? `: ${task.result}` : ""})`,
  closed: (task) => `#${task.id} ${task.status}${task.result ? `: ${task.result}` : ""}`,
  ok: "ok",
});

export { ago };
