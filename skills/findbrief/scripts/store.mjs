import { createHash } from "node:crypto";
import path from "node:path";
import {
  byKey,
  commits,
  environment as environmentNames,
  FindbriefError,
  files as fileClasses,
  git as gitFormat,
  graph as graphSettings,
  ignoreGrammar,
  languages,
  limits,
  lookupTable,
  messages,
  nonEmptyOrNull,
  round,
  search,
  storage,
  words,
} from "./config.mjs";
import { symbols } from "./symbols.mjs";

export const CODE_SYMBOL = `kind NOT LIKE '${languages.headingKindPrefix}%'`;

const sha = (value) => createHash("sha256").update(value).digest("hex");
const metaKeys = storage.meta;
const keyValueKeys = storage.keyValue;
const edgeListKey = (kind) => `${keyValueKeys.edgeListPrefix}${kind}`;

export function runGit(ports, cwd, args, input) {
  const result = ports.git(cwd, args, input);
  if (result.error) {
    const unavailable = messages.gitUnavailable[result.error.code];
    throw new FindbriefError(unavailable === undefined ? messages.gitNotRun(args[0], result.error) : unavailable(args[0]));
  }
  if (result.status !== 0) {
    throw new FindbriefError(messages.gitFailed(args[0], result.stderr.trim()));
  }
  return result.stdout;
}

export function repositoryFilterOverrides(listing) {
  const { untrustedScopes, filterSection, filterOverrides, configFromEnvironment } = gitFormat.safety;
  const fields = listing.split(gitFormat.fieldSeparator);
  const drivers = new Set();
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const key = fields[at + 1];
    if (untrustedScopes.has(fields[at]) && key.startsWith(filterSection) && key.lastIndexOf(".") > filterSection.length) {
      drivers.add(key.slice(filterSection.length, key.lastIndexOf(".")));
    }
  }
  return [...drivers].flatMap((driver) => filterOverrides.map(([setting, variable]) => configFromEnvironment(`${filterSection}${driver}.${setting}`, variable)));
}

function bigIntResults(db, sql) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

function metaTable(db) {
  const read = db.prepare("SELECT v FROM meta WHERE k=?");
  const write = db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)");
  return {
    get: (key) => read.get(key)?.v,
    put: (key, value) => write.run(key, value),
  };
}

function keyValueTable(db) {
  const read = db.prepare("SELECT v FROM csr WHERE k=?");
  const write = db.prepare("INSERT OR REPLACE INTO csr(k, v) VALUES (?, ?)");
  return {
    get: (key) => read.get(key)?.v,
    put: (key, value) => write.run(key, value),
  };
}

function identifiers(text) {
  const seen = new Set();
  for (const [name] of text.matchAll(search.identifierPattern)) {
    seen.add(name);
  }
  return [...seen].slice(0, limits.identifiersPerFile).sort();
}

const STAR = Object.freeze({ star: true });
const GLOBSTAR = Object.freeze({ globstar: true });
const ANY_SEGMENT = Object.freeze([STAR]);
const matching = (matches) => ({ star: false, matches });
const equalTo = (character) => (candidate) => candidate === character;
const literalToken = (character) => matching(equalTo(character));
const anyToken = matching(() => true);

function trimTrailingSpace(line) {
  let end = line.length;
  while (end > 0 && ignoreGrammar.trailingSpace.test(line[end - 1])) {
    end--;
  }
  return end < line.length && line[end - 1] === ignoreGrammar.escape ? line.slice(0, end + 1) : line.slice(0, end);
}

function escapedAt(text, j) {
  if (text[j] !== ignoreGrammar.escape) {
    return { character: text[j], end: j };
  }
  return j + 1 < text.length ? { character: text[j + 1], end: j + 1 } : null;
}

function nextIndexOf(text, wanted) {
  let found = -1;
  return (from) => (found >= from ? found : (found = text.indexOf(wanted, from)));
}

function namedClassAt(text, j, nextClose) {
  const { close, namedOpen, namedClose, named } = ignoreGrammar.classes;
  if (!text.startsWith(namedOpen, j)) {
    return null;
  }
  const end = nextClose(j + namedOpen.length);
  if (end === -1) {
    return { invalid: true };
  }
  const nameEnd = end + close.length - namedClose.length;
  if (nameEnd < j + namedOpen.length || !text.startsWith(namedClose, nameEnd)) {
    return { low: text[j], high: text[j], end: j + 1 };
  }
  const test = named[text.slice(j + namedOpen.length, nameEnd)];
  return test === undefined ? { invalid: true } : { test, end: end + close.length };
}

function mergedRanges(ranges) {
  const merged = [];
  for (const range of ranges.filter((candidate) => candidate.low <= candidate.high).sort((a, b) => byKey(a.low, b.low))) {
    const last = merged.at(-1);
    if (last !== undefined && range.low <= last.high) {
      last.high = range.high > last.high ? range.high : last.high;
    } else {
      merged.push({ low: range.low, high: range.high });
    }
  }
  return merged;
}

function inRanges(ranges, character) {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (character < ranges[middle].low) {
      high = middle - 1;
    } else if (character > ranges[middle].high) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function classMember(text, j) {
  const { close, range } = ignoreGrammar.classes;
  const low = escapedAt(text, j);
  if (low === null) {
    return null;
  }
  if (text[low.end + 1] !== range || low.end + 2 >= text.length || text[low.end + 2] === close) {
    return { low: low.character, high: low.character, end: low.end + 1 };
  }
  const high = escapedAt(text, low.end + 2);
  if (high === null) {
    return null;
  }
  return { low: low.character, high: high.character, end: high.end + 1 };
}

function characterClass(text, i, segment) {
  const { close, negations } = ignoreGrammar.classes;
  let j = i + 1;
  const negated = negations.has(text[j]);
  j += negated ? 1 : 0;
  const ranges = [], named = new Set(), nextClose = nextIndexOf(text, close);
  for (let first = true; text[j] !== close || first; first = false) {
    if (j >= text.length) {
      return -1;
    }
    const member = namedClassAt(text, j, nextClose) ?? classMember(text, j);
    if (member === null || member.invalid) {
      return -1;
    }
    if (member.test === undefined) {
      ranges.push(member);
    } else {
      named.add(member.test);
    }
    j = member.end;
  }
  const merged = mergedRanges(ranges), tests = [...named];
  segment.push(matching((candidate) => (inRanges(merged, candidate) || tests.some((test) => test(candidate))) !== negated));
  return j + 1;
}

function isWholeSegmentGlobstar(text, i) {
  const { globstar, separator } = ignoreGrammar;
  return text.startsWith(globstar, i) && (i === 0 || text[i - 1] === separator) && (i + globstar.length === text.length || text[i + globstar.length] === separator);
}

const globTokens = lookupTable({
  escape: (text, i, segments) => {
    const escaped = escapedAt(text, i);
    segments.at(-1).push(literalToken(escaped === null ? text[i] : escaped.character));
    return escaped === null ? i + 1 : escaped.end + 1;
  },
  star: (text, i, segments) => {
    if (segments.at(-1).length === 0 && isWholeSegmentGlobstar(text, i)) {
      segments[segments.length - 1] = GLOBSTAR;
      return i + ignoreGrammar.globstar.length;
    }
    segments.at(-1).push(STAR);
    return i + 1;
  },
  any: (text, i, segments) => {
    segments.at(-1).push(anyToken);
    return i + 1;
  },
  class: (text, i, segments) => characterClass(text, i, segments.at(-1)),
  separator: (text, i, segments) => {
    segments.push([]);
    return i + 1;
  },
});
const literalGlobToken = (text, i, segments) => {
  segments.at(-1).push(literalToken(text[i]));
  return i + 1;
};

function compileGlob(text) {
  const segments = [[]];
  for (let i = 0; i < text.length; ) {
    const kind = ignoreGrammar.tokens[text[i]];
    i = (kind === undefined ? literalGlobToken : globTokens[kind])(text, i, segments);
    if (i === -1) {
      return null;
    }
  }
  if (segments.at(-1) === GLOBSTAR) {
    segments.push(ANY_SEGMENT);
  }
  return segments;
}

function segmentMatches(tokens, text) {
  let t = 0, p = 0, starAt = -1, resumeAt = 0;
  while (t < text.length) {
    const token = tokens[p];
    if (token !== undefined && token.star) {
      starAt = ++p;
      resumeAt = t;
      continue;
    }
    if (token !== undefined && token.matches(text[t])) {
      p++;
      t++;
      continue;
    }
    if (starAt === -1) {
      return false;
    }
    p = starAt;
    t = ++resumeAt;
  }
  while (p < tokens.length && tokens[p].star) {
    p++;
  }
  return p === tokens.length;
}

function segmentsMatch(pattern, parts, from, to) {
  let s = from, p = 0, starAt = -1, resumeAt = 0;
  while (s < to) {
    const piece = pattern[p];
    if (piece === GLOBSTAR) {
      starAt = ++p;
      resumeAt = s;
      continue;
    }
    if (piece !== undefined && segmentMatches(piece, parts[s])) {
      p++;
      s++;
      continue;
    }
    if (starAt === -1) {
      return false;
    }
    p = starAt;
    s = ++resumeAt;
  }
  while (pattern[p] === GLOBSTAR) {
    p++;
  }
  return p === pattern.length;
}

function includedPrefix(text) {
  const literal = text.slice(0, text.search(ignoreGrammar.wildcardOrEnd));
  const prefix = literal.slice(0, literal.lastIndexOf(ignoreGrammar.separator) + 1).replace(ignoreGrammar.escapedCharacter, "$1");
  return gitFormat.outsideRepository.test(prefix) ? null : prefix;
}

function ignoreRule(line) {
  const { comment, negation, separator } = ignoreGrammar;
  let text = trimTrailingSpace(line);
  if (!text || text.startsWith(comment)) {
    return null;
  }
  const include = text.startsWith(negation);
  text = include ? text.slice(negation.length) : text;
  const directory = text.endsWith(separator);
  text = directory ? text.slice(0, -separator.length) : text;
  const anchored = text.includes(separator);
  text = text.startsWith(separator) ? text.slice(separator.length) : text;
  const segments = text ? compileGlob(text) : null;
  if (segments === null) {
    return null;
  }
  return { include, directory, anchored, prefix: anchored ? includedPrefix(text) : null, segments };
}
export const ignoreRules = (text) => text.split(ignoreGrammar.lineBreak).map(ignoreRule).filter(Boolean);

const ruleMatches = (rule, parts, count) => segmentsMatch(rule.segments, parts, rule.anchored ? 0 : count - 1, count);

function lastMatchingVerdict(rules, parts, count, isDirectory) {
  let verdict = null;
  for (const rule of rules) {
    if ((!rule.directory || isDirectory) && ruleMatches(rule, parts, count)) {
      verdict = rule.include ? "include" : "exclude";
    }
  }
  return verdict;
}
export function ignoreVerdict(rules, file) {
  if (!rules.length) {
    return null;
  }
  const parts = file.split(ignoreGrammar.separator);
  for (let i = 1; i < parts.length; i++) {
    if (lastMatchingVerdict(rules, parts, i, true) === "exclude") {
      return "exclude";
    }
  }
  return lastMatchingVerdict(rules, parts, parts.length, false);
}

function cacheDirectory({ environment, homeDirectory }) {
  const configured = nonEmptyOrNull(environment[environmentNames.xdgCacheHome]);
  return configured !== null && path.isAbsolute(configured) ? configured : path.join(homeDirectory, environmentNames.homeCacheDirectory);
}
function indexDirectory(ports) {
  return nonEmptyOrNull(ports.environment[environmentNames.indexHome]) ?? path.join(cacheDirectory(ports), environmentNames.indexDirectoryName);
}

const SCHEMA_DEFINITION = `DROP TABLE IF EXISTS file; DROP TABLE IF EXISTS sym; DROP TABLE IF EXISTS doc; DROP TABLE IF EXISTS revision;
      DROP TABLE IF EXISTS rfts; DROP TABLE IF EXISTS touch; DROP TABLE IF EXISTS edge; DROP TABLE IF EXISTS csr; DROP TABLE IF EXISTS stamp; DELETE FROM meta;
      CREATE TABLE file(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, oid TEXT NOT NULL, extra INTEGER NOT NULL, idents BLOB NOT NULL);
      CREATE TABLE sym(file INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, owner TEXT);
      CREATE INDEX sym_name ON sym(name); CREATE INDEX sym_file ON sym(file);
      CREATE VIRTUAL TABLE doc USING fts5(path, symbols, body, tokenize='porter unicode61', content='', contentless_delete=1);
      CREATE TABLE revision(id INTEGER PRIMARY KEY, sha TEXT UNIQUE NOT NULL, time INTEGER NOT NULL, type TEXT, scope TEXT, subject TEXT NOT NULL, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE rfts USING fts5(subject, body, tokenize='porter unicode61', content='', contentless_delete=1);
      CREATE TABLE touch(revision INTEGER NOT NULL, path TEXT NOT NULL); CREATE INDEX touch_path ON touch(path); CREATE INDEX touch_revision ON touch(revision);
      CREATE TABLE edge(src INTEGER NOT NULL, dst INTEGER NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL, detail TEXT); CREATE INDEX edge_src ON edge(src); CREATE INDEX edge_dst ON edge(dst);
      CREATE TABLE csr(k TEXT PRIMARY KEY, v BLOB NOT NULL);
      CREATE TABLE stamp(path TEXT PRIMARY KEY, size INTEGER NOT NULL, stat TEXT NOT NULL, oid TEXT NOT NULL);`;

function ensureSchema(db) {
  db.exec(
    `PRAGMA busy_timeout=${limits.busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`,
  );
  const schemaVersion = String(limits.schemaVersion);
  const meta = metaTable(db);
  if (meta.get(metaKeys.schema) === schemaVersion) {
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  if (meta.get(metaKeys.schema) === schemaVersion) {
    db.exec("COMMIT");
    return;
  }
  db.exec(`${SCHEMA_DEFINITION}
      INSERT INTO meta VALUES ('${metaKeys.schema}', '${schemaVersion}'); COMMIT;`);
}

function closingOnFailure(db, job) {
  try {
    return job();
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openIndex(ports, root) {
  const base = indexDirectory(ports);
  ports.makeDirectory(base, { recursive: true, mode: storage.indexDirectoryMode });
  const db = ports.openDatabase(
    path.join(base, `${path.basename(root)}-${sha(root).slice(0, limits.indexNameHashLength)}.sqlite`),
  );
  closingOnFailure(db, () => ensureSchema(db));
  return db;
}

function statOrNull(ports, root, file) {
  try {
    return ports.lstat(path.join(root, file));
  } catch {
    return null;
  }
}
export function readText(ports, root, file) {
  try {
    const stats = statOrNull(ports, root, file);
    if (!stats?.isFile() || stats.size > limits.maxFileBytes) {
      return null;
    }
    const buffer = ports.readFile(path.join(root, file));
    return buffer.subarray(0, limits.binarySniffBytes).includes(0)
      ? null
      : buffer.toString("utf8");
  } catch {
    return null;
  }
}

function trackedFiles(git) {
  const files = new Map();
  for (const entry of git(gitFormat.commands.trackedFiles).split(gitFormat.fieldSeparator)) {
    const mode = gitFormat.regularFileModes.find((regularMode) => entry.startsWith(regularMode));
    if (mode !== undefined) {
      files.set(entry.slice(entry.indexOf("\t") + 1), entry.slice(mode.length, entry.indexOf(" ", mode.length)));
    }
  }
  return files;
}

function unchangedPreviousWalk(keyValues, lstat, settledLongAgo) {
  const stored = keyValues.get(keyValueKeys.directories);
  if (!stored) {
    return null;
  }
  const walk = JSON.parse(Buffer.from(stored).toString("utf8"));
  const unchanged = walk.dirs.every(([directory, mtime]) => {
    const stats = lstat(directory);
    return stats?.isDirectory() && stats.mtimeMs === mtime && settledLongAgo(mtime);
  });
  return unchanged ? walk : null;
}

const porcelain = gitFormat.porcelain;

function trackedChange(status, entry, pathField) {
  const fields = entry.split(" ");
  const file = fields.slice(pathField).join(" ");
  if (fields[1].includes(porcelain.deletedStatus)) {
    status.deleted.push(file);
  } else {
    status.dirty.push(file);
  }
}
const statusEntry = lookupTable({
  header: (status, entry) => {
    if (entry.startsWith(porcelain.branchOidHeader)) {
      status.head = entry.slice(porcelain.branchOidHeader.length);
    }
  },
  ordinary: (status, entry) => trackedChange(status, entry, porcelain.pathField.ordinary),
  unmerged: (status, entry) => trackedChange(status, entry, porcelain.pathField.unmerged),
  untracked: (status, entry) => {
    const file = entry.slice(porcelain.untrackedPathOffset);
    status.dirty.push(file);
    status.untracked.push(file);
  },
});

function workingTreeStatus(git, listUntracked) {
  const status = { head: null, deleted: [], dirty: [], untracked: [] };
  const output = git(gitFormat.commands.status(listUntracked));
  for (const entry of output.split(gitFormat.fieldSeparator).filter(Boolean)) {
    const record = porcelain.records[entry[0]];
    if (record !== undefined) {
      statusEntry[record](status, entry);
    }
  }
  return status;
}

function directorySnapshot(files, untracked, lstat) {
  const seen = new Set(["."]);
  for (const file of [...files.keys(), ...untracked]) {
    for (let directory = path.dirname(file); directory !== "." && !seen.has(directory); directory = path.dirname(directory)) {
      seen.add(directory);
    }
  }
  const dirs = [...seen].sort().map((directory) => [directory, lstat(directory)?.mtimeMs ?? -1]);
  return Buffer.from(JSON.stringify({ dirs, untracked }));
}

function ignoredButIncluded(git, rules) {
  const prefixes = [...new Set(rules.filter((rule) => rule.include && rule.prefix).map((rule) => rule.prefix))].sort();
  if (!prefixes.length) {
    return new Set();
  }
  return new Set(
    git(gitFormat.commands.ignoredUnder(prefixes.map((prefix) => gitFormat.literalPathspec + prefix)))
      .split(gitFormat.fieldSeparator)
      .filter((file) => file && ignoreVerdict(rules, file) === "include"),
  );
}

const statKey = (stats) => `${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;

function resolveDirtyObjects(db, git, lstat, settledLongAgo, files, candidates) {
  const known = new Map(db.prepare("SELECT path, size, stat, oid FROM stamp").all().map((row) => [row.path, row]));
  const unhashed = [];
  for (const file of candidates) {
    const stats = lstat(file);
    const stamp = known.get(file);
    if (!stats?.isFile()) {
      files.delete(file);
    } else if (stamp && stamp.size === stats.size && stamp.stat === statKey(stats)) {
      files.set(file, stamp.oid);
    } else {
      unhashed.push({ file, stats });
    }
  }
  const stamps = [];
  const oids = objectIds(git, unhashed.map((entry) => entry.file));
  unhashed.forEach(({ file, stats }) => {
    files.set(file, oids.get(file));
    if (settledLongAgo(Math.max(stats.mtimeMs, stats.ctimeMs))) {
      stamps.push([file, stats.size, statKey(stats), oids.get(file)]);
    }
  });
  return stamps;
}

function objectIds(git, paths) {
  const listed = paths.filter((file) => !gitFormat.stdinPathUnsafe.test(file));
  const oids = new Map();
  if (listed.length) {
    const output = git(gitFormat.commands.hashPaths, listed.join("\n") + "\n").split("\n");
    listed.forEach((file, i) => oids.set(file, output[i]));
  }
  for (const file of paths.filter((candidate) => gitFormat.stdinPathUnsafe.test(candidate))) {
    oids.set(file, git(gitFormat.commands.hashPath(file)).trim());
  }
  return oids;
}

const indexable = (file, extra, rules) => !fileClasses.skipped.test(file) && (extra.has(file) || ignoreVerdict(rules, file) !== "exclude");

function indexableFiles(files, extra, rules) {
  const indexed = new Map();
  for (const [file, oid] of files) {
    if (indexable(file, extra, rules)) {
      indexed.set(file, { oid, extra: extra.has(file) ? 1 : 0 });
    }
  }
  return indexed;
}

function inventory(ports, root, db) {
  const git = (args, input) => runGit(ports, root, args, input);
  const lstat = (file) => statOrNull(ports, root, file);
  const settledLongAgo = (mtime) => ports.now() - mtime > limits.racyModificationMs;
  const files = trackedFiles(git);
  const previousWalk = unchangedPreviousWalk(keyValueTable(db), lstat, settledLongAgo);
  const status = workingTreeStatus(git, previousWalk === null);
  for (const file of status.deleted) {
    files.delete(file);
  }
  const dirty = [...(previousWalk?.untracked ?? []), ...status.dirty];
  const directories = previousWalk === null ? directorySnapshot(files, status.untracked, lstat) : null;
  const rules = ignoreRules(readText(ports, root, fileClasses.ignoreFile) ?? "");
  const extra = ignoredButIncluded(git, rules);
  const candidates = [...dirty, ...extra].filter((file) => indexable(file, extra, rules));
  const stamps = resolveDirtyObjects(db, git, lstat, settledLongAgo, files, candidates);
  return { indexed: indexableFiles(files, extra, rules), stamps, head: status.head, directories };
}

function inventoryWriter(db) {
  return {
    addStamp: db.prepare("INSERT OR REPLACE INTO stamp(path, size, stat, oid) VALUES (?, ?, ?, ?)"),
    meta: metaTable(db),
    keyValues: keyValueTable(db),
  };
}

function indexWriter(db) {
  return {
    ...inventoryWriter(db),
    deleteSymbols: bigIntResults(db, "DELETE FROM sym WHERE file=?"),
    deleteDocument: bigIntResults(db, "DELETE FROM doc WHERE rowid=?"),
    deleteFile: bigIntResults(db, "DELETE FROM file WHERE id=?"),
    addFile: db.prepare("INSERT INTO file(path, oid, extra, idents) VALUES (?, ?, ?, ?)"),
    updateFile: bigIntResults(db, "UPDATE file SET oid=?, extra=?, idents=? WHERE id=?"),
    addSymbol: db.prepare("INSERT INTO sym(file, name, kind, line, owner) VALUES (?, ?, ?, ?, ?)"),
    addDocument: db.prepare("INSERT INTO doc(rowid, path, symbols, body) VALUES (?, ?, ?, ?)"),
    addEdge: db.prepare("INSERT INTO edge(src, dst, kind, weight, detail) VALUES (?, ?, ?, ?, ?)"),
  };
}

function forgetFileContents(writer, id) {
  writer.deleteSymbols.run(id);
  writer.deleteDocument.run(id);
}

function revisionInsertion(db) {
  return {
    addRevision: db.prepare("INSERT INTO revision(sha, time, type, scope, subject, body) VALUES (?, ?, ?, ?, ?, ?)"),
    addFts: db.prepare("INSERT INTO rfts(rowid, subject, body) VALUES (?, ?, ?)"),
    addTouch: db.prepare("INSERT INTO touch(revision, path) VALUES (?, ?)"),
  };
}

function* commitRecords(log) {
  const fields = log.split(gitFormat.fieldSeparator);
  const isCommitStart = (at) => fields[at].startsWith(gitFormat.commitMarker);
  for (let at = 0; at < fields.length; ) {
    if (!isCommitStart(at)) {
      at++;
      continue;
    }
    const [marked, time, subject, body] = fields.slice(at, at + gitFormat.commitFieldCount);
    const hash = marked.slice(gitFormat.commitMarker.length);
    at += gitFormat.commitFieldCount;
    const names = [];
    for (; at < fields.length && !isCommitStart(at); at++) {
      names.push(names.length === 0 && fields[at].startsWith(gitFormat.namesSeparator) ? fields[at].slice(gitFormat.namesSeparator.length) : fields[at]);
    }
    if (gitFormat.commitSha.test(hash) && gitFormat.commitTime.test(time ?? "") && body !== undefined) {
      yield { hash, time, subject, body, names: names.filter(Boolean) };
    }
  }
}

function insertRevision(insertion, { hash, time, subject, body, names }) {
  const conventional = commits.conventionalSubject.exec(subject);
  const id = insertion.addRevision.run(
    hash,
    Number(time),
    conventional ? conventional[1].toLowerCase() : null,
    nonEmptyOrNull(conventional?.[2]),
    subject,
    body.trim(),
  ).lastInsertRowid;
  insertion.addFts.run(id, words(subject), words(body));
  for (const file of names) {
    insertion.addTouch.run(id, file);
  }
}

function indexCommits(ports, db, writer, root, head) {
  const last = writer.meta.get(metaKeys.head);
  if (last === head) {
    return false;
  }
  const ancestor =
    last &&
    ports.git(root, gitFormat.commands.isAncestor(last, head)).status === 0;
  if (!ancestor) {
    db.exec("DELETE FROM revision; DELETE FROM rfts; DELETE FROM touch");
  }
  const log = runGit(ports, root, gitFormat.commands.commitLog(ancestor ? gitFormat.commands.commitRange(last, head) : head));
  const insertion = revisionInsertion(db);
  for (const record of commitRecords(log)) {
    insertRevision(insertion, record);
  }
  writer.meta.put(metaKeys.head, head);
  return true;
}

function lexicon(keyValues) {
  const stored = keyValues.get(keyValueKeys.words);
  const text = stored ? Buffer.from(stored).toString("utf8").split("\n") : [""];
  const ids = new Map(text.map((word, id) => [word, id]));
  let added = false;
  const intern = (list) =>
    Int32Array.from(list, (word) => {
      if (!ids.has(word)) {
        ids.set(word, text.length);
        text.push(word);
        added = true;
      }
      return ids.get(word);
    });
  const save = () => {
    if (added) {
      keyValues.put(keyValueKeys.words, Buffer.from(text.join("\n")));
    }
  };
  return { text, ids, intern, save };
}
const decodeWordIds = (blob) => new Int32Array(new Uint8Array(blob).buffer);

function wordId(keyValues, word) {
  const stored = keyValues.get(keyValueKeys.words);
  if (!stored || word.includes("\n")) {
    return undefined;
  }
  const text = Buffer.from(stored);
  const at = Buffer.concat([Buffer.from("\n"), text, Buffer.from("\n")]).indexOf(`\n${word}\n`);
  if (at === -1) {
    return undefined;
  }
  let id = 0;
  for (let next = text.indexOf(10); next !== -1 && next < at; next = text.indexOf(10, next + 1)) {
    id++;
  }
  return id;
}

function definingFilesByWord(db, ids) {
  const owners = [];
  for (const { name, file } of db.prepare(`SELECT name, file FROM sym WHERE ${CODE_SYMBOL}`).all()) {
    const word = ids.get(name);
    if (word !== undefined) {
      (owners[word] ??= new Set()).add(file);
    }
  }
  return owners;
}

function definedWordUsage(files, owners, wordCount) {
  const usage = new Int32Array(wordCount + 1);
  for (const file of files) {
    for (const word of file.words) {
      usage[word] += owners[word] ? 1 : 0;
    }
  }
  return usage;
}

function usedNamesByOwner(file, owners, usage, text) {
  const references = new Map();
  for (const word of file.words) {
    const owned = owners[word];
    if (!owned || owned.size > graphSettings.maxDefiningFilesPerUse || owned.has(file.id) || usage[word] > graphSettings.commonIdentifierFileCount) {
      continue;
    }
    for (const owner of owned) {
      const names = references.get(owner) ?? [];
      names.push(text[word]);
      references.set(owner, names);
    }
  }
  return [...references].sort((a, b) => a[0] - b[0]);
}

const { edgeKinds } = graphSettings;

function forgetEdges(db, kind) {
  bigIntResults(db, "DELETE FROM edge WHERE kind=?").run(kind);
}

function usesEdges(db, writer, { text, ids }) {
  forgetEdges(db, edgeKinds.uses);
  const owners = definingFilesByWord(db, ids);
  const files = db
    .prepare("SELECT id, idents FROM file ORDER BY id")
    .all()
    .map((row) => ({ id: row.id, words: decodeWordIds(row.idents) }));
  const usage = definedWordUsage(files, owners, text.length);
  const list = [];
  for (const file of files) {
    for (const [owner, names] of usedNamesByOwner(file, owners, usage, text)) {
      const weight = round(Math.log2(graphSettings.usesWeightOffset + names.length));
      writer.addEdge.run(file.id, owner, edgeKinds.uses, weight, names.slice(0, graphSettings.usedNamesShownPerEdge).join(","));
      list.push(file.id, owner, weight);
    }
  }
  storeEdgeList(writer.keyValues, edgeKinds.uses, list);
}

function storeEdgeList(keyValues, kind, list) {
  keyValues.put(edgeListKey(kind), Buffer.from(Float64Array.from(list).buffer));
}

function* commitsWithPaths(db) {
  let commit = null;
  for (const row of db
    .prepare(
      "SELECT r.id, r.time, t.path FROM touch t JOIN revision r ON r.id = t.revision ORDER BY r.time, r.sha, t.path",
    )
    .iterate()) {
    if (commit === null || row.id !== commit.id) {
      if (commit !== null) {
        yield commit;
      }
      commit = { id: row.id, time: row.time, paths: [] };
    }
    commit.paths.push(row.path);
  }
  if (commit !== null) {
    yield commit;
  }
}

function accumulateCochange(pairs, commit, idOf, headTime) {
  const { bulkCommitFileCount, cochangeHalfLifeDays, cochangeDecayBase, secondsPerDay, pairKeyBase } = graphSettings;
  const ids = [
    ...new Set(commit.paths.map((file) => idOf.get(file)).filter(Boolean)),
  ].sort((a, b) => a - b);
  if (ids.length < 2 || commit.paths.length > bulkCommitFileCount) {
    return;
  }
  const weight =
    Math.pow(cochangeDecayBase, Math.max(0, headTime - commit.time) / secondsPerDay / cochangeHalfLifeDays) /
    (ids.length - 1);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = ids[i] * pairKeyBase + ids[j];
      const pair = pairs.get(key) ?? { weight: 0, commits: 0 };
      pair.weight += weight;
      pair.commits += 1;
      pairs.set(key, pair);
    }
  }
}

function cochangeEdges(db, writer, headTime) {
  const { pairKeyBase } = graphSettings;
  forgetEdges(db, edgeKinds.cochange);
  const idOf = new Map(db.prepare("SELECT id, path FROM file ORDER BY id").all().map((row) => [row.path, row.id]));
  const pairs = new Map();
  for (const commit of commitsWithPaths(db)) {
    accumulateCochange(pairs, commit, idOf, headTime);
  }
  const list = [];
  for (const [key, pair] of [...pairs].sort((a, b) => a[0] - b[0])) {
    const [src, dst, weight] = [Math.floor(key / pairKeyBase), key % pairKeyBase, round(pair.weight)];
    writer.addEdge.run(src, dst, edgeKinds.cochange, weight, String(pair.commits));
    list.push(src, dst, weight);
  }
  storeEdgeList(writer.keyValues, edgeKinds.cochange, list);
}

function storedEdgeList(keyValues, kind) {
  const stored = keyValues.get(edgeListKey(kind));
  return stored ? new Float64Array(new Uint8Array(stored).buffer) : new Float64Array(0);
}

function compress(db, kinds) {
  const keyValues = keyValueTable(db);
  const ids = Int32Array.from(db.prepare("SELECT id FROM file ORDER BY path").all(), (row) => row.id);
  const nodeOf = new Map(Array.from(ids, (id, node) => [id, node]));
  const rows = Array.from({ length: ids.length }, () => new Map());
  const link = (from, to, weight) => {
    if (from !== undefined && to !== undefined) {
      rows[from].set(to, (rows[from].get(to) ?? 0) + weight);
    }
  };
  for (const kind of kinds) {
    const list = storedEdgeList(keyValues, kind);
    for (const [source, target] of graphSettings.edgeDirections) {
      for (let e = 0; e < list.length; e += 3) {
        link(nodeOf.get(list[e + source]), nodeOf.get(list[e + target]), list[e + 2]);
      }
    }
  }
  const offsets = new Int32Array(ids.length + 1), size = rows.reduce((total, row) => total + row.size, 0);
  const targets = new Int32Array(size), weights = new Float64Array(size);
  let at = 0;
  for (let node = 0; node < ids.length; node++) {
    offsets[node] = at;
    for (const [target, weight] of [...rows[node]].sort((a, b) => a[0] - b[0])) {
      targets[at] = target;
      weights[at++] = weight;
    }
  }
  offsets[ids.length] = at;
  return { ids, offsets, targets, weights };
}
function storeCompressedGraph(db, keyValues) {
  const compressed = compress(db, graphSettings.storedEdgeKinds);
  for (const part of graphSettings.storedParts) {
    keyValues.put(part, Buffer.from(compressed[part].buffer));
  }
}

export function filesMentioning(db, name) {
  if (search.wholeIdentifier.test(name)) {
    const id = wordId(keyValueTable(db), name);
    return id === undefined
      ? []
      : db
          .prepare("SELECT id, path, idents FROM file ORDER BY extra, path")
          .all()
          .filter((row) => decodeWordIds(row.idents).includes(id))
          .map((row) => row.path);
  }
  const phrase = words(name).match(search.termPattern)?.join(" ");
  return phrase
    ? db.prepare("SELECT f.path FROM doc d JOIN file f ON f.id = d.rowid WHERE doc MATCH ? ORDER BY f.extra, f.path").all(`body : "${phrase}"`).map((row) => row.path)
    : [];
}

export function mentionCounts(db, names) {
  const keyValues = keyValueTable(db);
  const wanted = new Map(names.map((name) => [wordId(keyValues, name), name]).filter(([id]) => id !== undefined));
  const counts = new Map();
  if (!wanted.size) {
    return counts;
  }
  for (const row of db.prepare("SELECT path, idents FROM file ORDER BY path").all()) {
    const found = [...decodeWordIds(row.idents)].filter((id) => wanted.has(id)).map((id) => wanted.get(id));
    if (found.length) {
      counts.set(row.path, found.sort());
    }
  }
  return counts;
}

export function indexCounts(db) {
  return {
    files: db.prepare("SELECT count(*) total FROM file").get().total,
    symbols: db.prepare("SELECT count(*) total FROM sym").get().total,
    commits: db.prepare("SELECT count(*) total FROM revision").get().total,
    edges: db.prepare("SELECT count(*) total FROM edge").get().total,
  };
}

function inTransaction(db, job) {
  db.exec("BEGIN IMMEDIATE");
  try {
    job();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const inventoryFingerprint = ({ head, indexed }) =>
  sha(head + "\n" + [...indexed].map(([file, entry]) => `${file}\0${entry.oid}\0${entry.extra}`).join("\n"));

function settleInventory(writer, snapshot, fingerprint) {
  for (const stamp of snapshot.stamps) {
    writer.addStamp.run(...stamp);
  }
  if (snapshot.directories) {
    writer.keyValues.put(keyValueKeys.directories, snapshot.directories);
  }
  writer.meta.put(metaKeys.inventory, fingerprint);
}

function pendingChanges(db, current, head) {
  const known = new Map(
    db
      .prepare("SELECT path, oid, extra, id FROM file")
      .all()
      .map((row) => [row.path, row]),
  );
  const stale = (row) => {
    const entry = current.get(row.path);
    return entry.oid !== row.oid || entry.extra !== row.extra;
  };
  return {
    removed: [...known.values()].filter((row) => !current.has(row.path)),
    changed: [...known.values()].filter((row) => current.has(row.path) && stale(row)).sort((a, b) => byKey(a.path, b.path)),
    added: [...current].filter(([file]) => !known.has(file)).sort((a, b) => byKey(a[0], b[0])),
    moved: metaTable(db).get(metaKeys.head) !== head,
  };
}
const isIdle = (pending) => !pending.removed.length && !pending.changed.length && !pending.added.length && !pending.moved;

function indexFile(ports, root, writer, vocabulary, { file, entry: { oid, extra }, knownId }) {
  const text = readText(ports, root, file) ?? "";
  const definitions = text ? symbols(file, text) : [];
  const idents = vocabulary.intern(text ? identifiers(text) : []);
  let id = knownId;
  if (knownId === null) {
    id = writer.addFile.run(file, oid, extra, idents).lastInsertRowid;
  } else {
    forgetFileContents(writer, knownId);
    writer.updateFile.run(oid, extra, idents, knownId);
  }
  for (const definition of definitions) {
    writer.addSymbol.run(id, definition.name, definition.kind, definition.line, definition.owner);
  }
  writer.addDocument.run(
    id,
    words(file.replace(search.pathSeparators, " ")),
    words(definitions.map((definition) => definition.name).join(" ")),
    words(text),
  );
}

function rebuildDerivedData(ports, root, db, writer, { removed, changed, added, vocabulary, historyChanged, head }) {
  const filesChanged = removed.length + changed.length + added.length > 0;
  if (filesChanged) {
    vocabulary.save();
    usesEdges(db, writer, vocabulary);
  }
  if (historyChanged || removed.length || added.length) {
    cochangeEdges(db, writer, Number(runGit(ports, root, gitFormat.commands.commitTime(head)).trim()));
  }
  if (filesChanged || historyChanged) {
    storeCompressedGraph(db, writer.keyValues);
  }
  if (filesChanged) {
  }
}

function applyChanges(ports, root, db, snapshot, fingerprint) {
  const { indexed: current, head } = snapshot;
  const { removed, changed, added } = pendingChanges(db, current, head);
  const writer = indexWriter(db);
  for (const row of removed) {
    forgetFileContents(writer, row.id);
    writer.deleteFile.run(row.id);
  }
  const vocabulary = lexicon(writer.keyValues);
  const work = [
    ...changed.map((row) => ({ file: row.path, entry: current.get(row.path), knownId: row.id })),
    ...added.map(([file, entry]) => ({ file, entry, knownId: null })),
  ];
  for (const job of work) {
    indexFile(ports, root, writer, vocabulary, job);
  }
  const historyChanged = indexCommits(ports, db, writer, root, head);
  rebuildDerivedData(ports, root, db, writer, { removed, changed, added, vocabulary, historyChanged, head });
  settleInventory(writer, snapshot, fingerprint);
}

function synchronizeIndex(ports, root, db) {
  const snapshot = inventory(ports, root, db);
  if (!gitFormat.commitSha.test(snapshot.head ?? "")) {
    throw new FindbriefError(messages.noCommits);
  }
  const fingerprint = inventoryFingerprint(snapshot);
  const settleOnly = () => settleInventory(inventoryWriter(db), snapshot, fingerprint);
  if (metaTable(db).get(metaKeys.inventory) === fingerprint) {
    if (snapshot.stamps.length || snapshot.directories) {
      inTransaction(db, settleOnly);
    }
    return snapshot.head;
  }
  if (isIdle(pendingChanges(db, snapshot.indexed, snapshot.head))) {
    inTransaction(db, settleOnly);
    return snapshot.head;
  }
  inTransaction(db, () => applyChanges(ports, root, db, snapshot, fingerprint));
  return snapshot.head;
}

export function refreshIndex(ports, root) {
  const db = openIndex(ports, root);
  const head = closingOnFailure(db, () => synchronizeIndex(ports, root, db));
  return { db, head };
}

function storedGraphParts(db) {
  if (!db.prepare("SELECT 1 FROM csr LIMIT 1").get()) {
    return null;
  }
  const { storedParts } = graphSettings;
  const parts = new Map(
    db
      .prepare(`SELECT k, v FROM csr WHERE k IN (${storedParts.map(() => "?").join(", ")})`)
      .all(...storedParts)
      .map((row) => [row.k, new Uint8Array(row.v).buffer]),
  );
  return {
    ids: new Int32Array(parts.get("ids")),
    offsets: new Int32Array(parts.get("offsets")),
    targets: new Int32Array(parts.get("targets")),
    weights: new Float64Array(parts.get("weights")),
  };
}

function rankingGraph({ ids, offsets, targets, weights }) {
  const size = ids.length;
  const nodeOf = new Map(Array.from(ids, (id, node) => [id, node]));
  const strength = new Float64Array(size);
  for (let node = 0; node < size; node++) {
    for (let e = offsets[node]; e < offsets[node + 1]; e++) {
      strength[node] += weights[e];
    }
  }
  const degree = (node) => offsets[node + 1] - offsets[node];
  return Object.freeze({ ids, size, nodeOf, offsets, targets, weights, strength, degree });
}

export function readGraph(db, environment) {
  const edgeKindsOverride = nonEmptyOrNull(environment[environmentNames.edgeKindsOverride]);
  if (edgeKindsOverride !== null) {
    return rankingGraph(compress(db, edgeKindsOverride.split(environmentNames.edgeKindsSeparator)));
  }
  return rankingGraph(storedGraphParts(db) ?? compress(db, graphSettings.storedEdgeKinds));
}
