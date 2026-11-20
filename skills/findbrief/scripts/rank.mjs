import path from "node:path";
import {
  brief as briefSettings,
  byKey,
  FindbriefError,
  files as fileClasses,
  git as gitFormat,
  graph as graphSettings,
  impact as impactSettings,
  isoDay,
  messages,
  nonZeroOr,
  ranking,
  refs as refsSettings,
  round,
  search,
  when as whenSettings,
  why as whySettings,
  words,
} from "./config.mjs";
import { CODE_SYMBOL, filesMentioning, mentionCounts, runGit } from "./store.mjs";

const { basename, dirname } = path.posix;
const LANE = ranking.lanes;
const NO_LANE = 0;
const shortSha = messages.shortSha;
const rawless = (name) => name.replace(search.rawIdentifierPrefix, "$1");

export function terms(query) {
  const all = [...new Set(words(query).match(search.termPattern) ?? [])].filter(
    (term) => term.length >= search.minimumTermLength,
  );
  const kept = all.filter((term) => !search.stopWords.has(term));
  return kept.length ? kept : all;
}
const stem = (term) =>
  term.length >= search.stemming.minimumLength
    ? search.stemming.suffixRules.reduce((word, [suffix, replacement]) => word.replace(suffix, replacement), term)
    : term;
const ftsQuery = (list) =>
  list.length ? list.map((term) => `"${term}"`).join(" OR ") : null;

export function exactTokens(query) {
  const { leadingPunctuation, trailingPeriod, currentDirectoryPrefix, allowedCharacters, codeShape } = search.exactToken;
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replace(leadingPunctuation, "").replace(trailingPeriod, "").replace(currentDirectoryPrefix, ""))
    .map(rawless)
    .filter((token) => allowedCharacters.test(token));
  return [
    ...new Set(
      tokens.length === 1
        ? tokens
        : tokens.filter((token) => codeShape.test(token)),
    ),
  ];
}

function definitions(statement, target) {
  const [name, owner] = rawless(target).split(search.ownerSeparator).reverse();
  const all = statement.all(name);
  return owner ? { found: all.filter((definition) => definition.owner === owner), others: all } : { found: all, others: [] };
}

const qualifiedName = (definition) => (definition.owner ? `${definition.owner}${search.ownerSeparator}${definition.name}` : definition.name);

function restartNodes({ nodeOf }, restart) {
  const seeds = [];
  for (const [id, weight] of restart) {
    const node = nodeOf.get(id);
    if (node !== undefined) {
      seeds.push([node, weight]);
    }
  }
  seeds.sort((a, b) => a[0] - b[0]);
  const total = nonZeroOr(seeds.reduce((sum, [, weight]) => sum + weight, 0), 1);
  return seeds.map(([node, weight]) => [node, weight / total]);
}

export function pagerank(rankingGraph, restart, alpha) {
  const { size, offsets, targets, weights, strength } = rankingGraph;
  const teleport = new Float64Array(size);
  for (const [node, weight] of restartNodes(rankingGraph, restart)) {
    teleport[node] = weight;
  }
  let rank = Float64Array.from(teleport), next = new Float64Array(size);
  for (let iteration = 0; iteration < ranking.pagerankIterations; iteration++) {
    next.fill(0);
    let dangling = 0;
    for (let node = 0; node < size; node++) {
      if (!rank[node]) {
        continue;
      }
      if (!strength[node]) {
        dangling += rank[node];
        continue;
      }
      const share = ((1 - alpha) * rank[node]) / strength[node];
      for (let e = offsets[node]; e < offsets[node + 1]; e++) {
        next[targets[e]] += share * weights[e];
      }
    }
    for (let node = 0; node < size; node++) {
      next[node] += (alpha + (1 - alpha) * dangling) * teleport[node];
    }
    [rank, next] = [next, rank];
  }
  return rank;
}

function findStatements(db) {
  const symbolsOf = db.prepare(`SELECT name, line FROM sym WHERE file=? AND ${CODE_SYMBOL} ORDER BY line, name`);
  const cachedSymbols = new Map();
  return {
    symbolsOf: (id) => {
      if (!cachedSymbols.has(id)) {
        cachedSymbols.set(id, symbolsOf.all(id));
      }
      return cachedSymbols.get(id);
    },
    defines: db.prepare(
      `SELECT s.file id, s.name, s.line, s.owner FROM sym s JOIN file f ON f.id = s.file WHERE s.name=? AND s.${CODE_SYMBOL} ORDER BY f.path, s.line`,
    ),
    atPath: db.prepare("SELECT id, path FROM file WHERE path=? OR path LIKE ? ESCAPE '\\' ORDER BY path"),
    pathIs: db.prepare("SELECT id FROM file WHERE path=?"),
  };
}

function exactLanes() {
  const lanes = new Map();
  const mark = (id, tier, reason) => {
    if ((lanes.get(id)?.tier ?? NO_LANE) < tier) {
      lanes.set(id, { tier, reason });
    }
  };
  return { lanes, mark };
}

function markDefinitionsAndPaths(statements, mark, token, defined) {
  for (const definition of defined.found) {
    const qualified = qualifiedName(definition);
    const shown = definition.owner && token.endsWith(qualified) ? qualified : definition.name;
    mark(definition.id, LANE.exact, messages.reasons.defines(shown, definition.line));
  }
  if (!defined.found.length) {
    for (const definition of defined.others) {
      mark(definition.id, LANE.typo, messages.reasons.near(messages.reasons.defines(qualifiedName(definition), definition.line), messages.reasons.closestTo(token)));
    }
  }
  if (search.pathLike.test(token)) {
    for (const file of statements.atPath.all(token, "%/" + token.replace(/[\\%_]/g, "\\$&"))) {
      mark(file.id, file.path === token ? LANE.path : LANE.exact, messages.reasons.pathMatches);
    }
  }
}

function exactMatches(statements, query, exactWanted) {
  const { lanes, mark } = exactLanes();
  const definedByToken = new Map(exactWanted.map((token) => [token, definitions(statements.defines, token)]));
  for (const token of exactWanted) {
    markDefinitionsAndPaths(statements, mark, token, definedByToken.get(token));
  }
  const whole = query.trim();
  if (whole.split(/\s+/).length > 1) {
    const file = statements.pathIs.get(whole);
    if (file !== undefined) {
      mark(file.id, LANE.path, messages.reasons.pathMatches);
    }
  }
  return lanes;
}

function candidates(db, match, columns) {
  const rows = db
    .prepare(
      `SELECT d.rowid id, bm25(doc, ${columns.join(", ")}) score FROM doc d JOIN file f ON f.id = d.rowid
      WHERE doc MATCH ? ORDER BY score, f.path`,
    )
    .all(match);
  const cut = rows[ranking.textCandidates - 1]?.score;
  return cut === undefined ? rows : rows.filter((row, i) => i < ranking.textCandidates || row.score === cut);
}

function coverageOf(stems) {
  const denominator = nonZeroOr(stems.length, 1);
  return (text) => {
    const lower = text.toLowerCase();
    return stems.filter((term) => lower.includes(term)).length / denominator;
  };
}

function intentWeight(weights, file, isExtra) {
  return (isExtra ? weights.spec : 1) * (fileClasses.test.test(file) ? weights.test : 1) * (fileClasses.history.test(file) ? weights.history : 1);
}

function seedScores({ statements, files, hits, exact, weights, coverage }) {
  const best = hits.length ? nonZeroOr(-hits[0].score, 1) : 1;
  const text = new Map(hits.map((hit) => [hit.id, -hit.score / best]));
  return new Map(
    [...new Set([...text.keys(), ...exact.keys()])].map((id) => {
      const symbolCover = Math.max(0, ...statements.symbolsOf(id).map((symbol) => coverage(symbol.name)));
      const file = files.paths.get(id);
      const textScore = text.get(id) ?? 0;
      return [
        id,
        round(
          intentWeight(weights, file, files.extra.has(id)) *
            (weights.text * textScore + weights.path * coverage(file) + weights.symbol * symbolCover),
        ),
      ];
    }),
  );
}

function rankedFiles({ seeds, exact, files, limit }) {
  const tierOf = (id) => exact.get(id)?.tier ?? NO_LANE;
  return [...seeds]
    .filter(([id, score]) => score > 0 || exact.has(id))
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => tierOf(b.id) - tierOf(a.id) || b.score - a.score || byKey(files.paths.get(a.id), files.paths.get(b.id)))
    .slice(0, limit);
}

function seedReason(statements, id, named) {
  const defined = statements
    .symbolsOf(id)
    .filter((symbol) =>
      words(symbol.name)
        .split(/\s+/)
        .some((term) => named.has(term)),
    )
    .slice(0, ranking.maxDefinedSymbolsShown);
  return defined.length
    ? messages.reasons.definesList(defined.map((symbol) => `${symbol.name}:${symbol.line}`).join(", "))
    : messages.reasons.matchesText;
}

function reasonFor({ statements, exact, named }, id) {
  return exact.get(id)?.reason ?? seedReason(statements, id, named);
}

function fileTable(db, ids) {
  const rows = db.prepare("SELECT id, path, extra FROM file WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids));
  return {
    paths: new Map(rows.map((row) => [row.id, row.path])),
    extra: new Set(rows.filter((row) => row.extra).map((row) => row.id)),
  };
}

export function find(db, query, limit, weights) {
  const wanted = terms(query);
  const match = ftsQuery(wanted);
  const exactWanted = exactTokens(query);
  if (!match && !exactWanted.length) {
    throw new FindbriefError(messages.findNeedsWords);
  }
  const statements = findStatements(db);
  const exact = exactMatches(statements, query, exactWanted);
  const hits = match ? candidates(db, match, weights.bm25) : [];
  if (!hits.length && !exact.size) {
    return [];
  }
  const files = fileTable(db, [...new Set([...hits.map((hit) => hit.id), ...exact.keys()])]);
  const coverage = coverageOf(wanted.map(stem));
  const seeds = seedScores({ statements, files, hits, exact, weights, coverage });
  const ranked = rankedFiles({ seeds, exact, files, limit });
  const explanation = { statements, exact, named: new Set(wanted) };
  return ranked.map(({ id, score }) => ({ file: files.paths.get(id), score, reason: reasonFor(explanation, id) }));
}

const fileCommits = (db, target, limit) =>
  db
    .prepare(
      "SELECT r.sha, r.time, r.subject, r.body FROM touch t JOIN revision r ON r.id=t.revision WHERE t.path=? ORDER BY r.time DESC, r.id DESC LIMIT ?",
    )
    .all(target, limit);

function fileHistory(db, file, target, limit) {
  const commits = fileCommits(db, target, limit);
  const cochanged = file
    ? db
        .prepare(
          `SELECT f.path, e.detail n FROM edge e JOIN file f ON f.id = CASE WHEN e.src=? THEN e.dst ELSE e.src END
        WHERE e.kind=? AND (e.src=? OR e.dst=?) ORDER BY e.weight DESC, f.path LIMIT ${whySettings.cochangedShown}`,
        )
        .all(file.id, graphSettings.edgeKinds.cochange, file.id, file.id)
    : [];
  return { target, definitions: [], commits, cochanged };
}

function lineHistory(ports, root, definition, limit) {
  const end = definition.next ? definition.next - 1 : definition.line + whySettings.spanWithoutNextSymbol;
  const { lineHistory: history, lineSpan } = gitFormat.commands;
  return runGit(ports, root, history(lineSpan(definition.line, end, definition.path), limit))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, time, subject] = line.split(gitFormat.fieldSeparator);
      return { sha, time: Number(time), subject };
    });
}

function headObjects(ports, root) {
  const objects = new Map();
  for (const entry of runGit(ports, root, gitFormat.commands.headTree).split(gitFormat.fieldSeparator)) {
    const object = gitFormat.treeEntry.exec(entry);
    if (object !== null) {
      objects.set(entry.slice(entry.indexOf("\t") + 1), object[1]);
    }
  }
  return objects;
}

function definitionHistory(db, ports, root, definition, limit) {
  try {
    return { commits: lineHistory(ports, root, definition, limit) };
  } catch (error) {
    if (!(error instanceof FindbriefError)) {
      throw error;
    }
    return fileFallback(db, definition, limit);
  }
}

const fileFallback = (db, definition, limit) => ({
  commits: fileCommits(db, definition.path, limit).map(({ sha, time, subject }) => ({ sha, time, subject })),
  note: messages.fileHistoryFallback,
});

function nextOutside(followers, definition) {
  const nested = new Set([definition.name]);
  for (const follower of followers.all(definition.file, definition.line)) {
    if (!nested.has(follower.owner)) {
      return follower.line;
    }
    nested.add(follower.name);
  }
  return null;
}

function symbolHistory(db, ports, root, target, limit) {
  const { found: all, others } = definitions(
    db.prepare(
      `SELECT s.file, f.path, f.oid, s.name, s.line, s.kind, s.owner
      FROM sym s JOIN file f ON f.id=s.file WHERE s.name=? ORDER BY f.path, s.line`,
    ),
    target,
  );
  if (!all.length) {
    throw new FindbriefError(others.length ? messages.unknownOwner(target, [...new Set(others.map(qualifiedName))].sort(byKey).join(", ")) : messages.unknownTarget(target));
  }
  const followers = db.prepare("SELECT name, owner, line FROM sym WHERE file=? AND line>? ORDER BY line, name");
  const found = all.slice(0, whySettings.definitionsShown).map((definition) => ({ ...definition, next: nextOutside(followers, definition) }));
  const committed = headObjects(ports, root);
  return {
    target,
    definitions: found.map((definition) => ({
      name: qualifiedName(definition),
      file: definition.path,
      line: definition.line,
      kind: definition.kind,
      ...(committed.get(definition.path) === definition.oid ? definitionHistory(db, ports, root, definition, limit) : fileFallback(db, definition, limit)),
    })),
    commits: [],
    cochanged: [],
  };
}

export function why(db, ports, root, target, limit) {
  const file = db.prepare("SELECT id, path FROM file WHERE path=?").get(target);
  if (file || db.prepare("SELECT 1 FROM touch WHERE path=? LIMIT 1").get(target)) {
    return fileHistory(db, file, target, limit);
  }
  return symbolHistory(db, ports, root, target, limit);
}

function mentionPattern(name) {
  const boundary = refsSettings.nameBoundary;
  return new RegExp(`(?<!${boundary})${name.replace(refsSettings.regexSpecials, "\\$&")}(?!${boundary})`, "u");
}

function mentionLines(text, pattern) {
  const lines = [];
  text.split("\n").forEach((line, i) => {
    if (pattern.test(line)) {
      lines.push(i + 1);
    }
  });
  return lines;
}

const insideScope = (file, scope) => scope === null || file === scope || file.startsWith(scope.endsWith("/") ? scope : `${scope}/`);

export function refs(db, target, { limit, scope, textOf }) {
  const name = rawless(target).split(search.ownerSeparator).at(-1);
  const { found, others } = definitions(
    db.prepare(`SELECT f.path, s.name, s.owner, s.kind, s.line FROM sym s JOIN file f ON f.id=s.file WHERE s.name=? AND s.${CODE_SYMBOL} ORDER BY f.path, s.line`),
    target,
  );
  if (!found.length && others.length) {
    throw new FindbriefError(messages.unknownOwner(target, [...new Set(others.map(qualifiedName))].sort(byKey).join(", ")));
  }
  const defined = found.filter((definition) => insideScope(definition.path, scope));
  const definingFiles = [...new Set(defined.map((definition) => definition.path))];
  const mentioning = filesMentioning(db, name).filter((file) => insideScope(file, scope) && !definingFiles.includes(file));
  const candidates = [...definingFiles, ...mentioning];
  const pattern = mentionPattern(name), files = [];
  let read = 0;
  for (; read < candidates.length && files.length < limit; read++) {
    const lines = mentionLines(textOf(candidates[read]) ?? "", pattern);
    if (lines.length) {
      files.push({ file: candidates[read], lines: lines.slice(0, refsSettings.linesShownPerFile), more: Math.max(0, lines.length - refsSettings.linesShownPerFile) });
    }
  }
  return {
    target,
    definitions: defined.map((definition) => ({ name: qualifiedName(definition), kind: definition.kind, file: definition.path, line: definition.line })),
    files,
    moreFiles: candidates.length - read,
  };
}

function bestTextLine(text, stems) {
  let best = 0, bestCount = 0;
  text.split("\n").forEach((line, i) => {
    const lower = words(line);
    const count = stems.filter((stemmed) => lower.includes(stemmed)).length;
    if (count > bestCount) {
      [best, bestCount] = [i + 1, count];
    }
  });
  return best;
}

export function withTextLines(results, query, textOf) {
  const stems = terms(query).map(stem);
  return results.map((result) => {
    if (result.reason !== messages.reasons.matchesText) {
      return result;
    }
    const line = bestTextLine(textOf(result.file) ?? "", stems);
    return line ? { ...result, reason: messages.reasons.matchesTextAt(line) } : result;
  });
}

function changedRanges(ports, root, files) {
  const ranges = new Map();
  let current = null;
  for (const line of runGit(ports, root, gitFormat.commands.changedLines(files)).split("\n")) {
    if (line.startsWith(impactSettings.newFileHeader)) {
      current = line.slice(impactSettings.newFileHeader.length);
      ranges.set(current, ranges.get(current) ?? []);
      continue;
    }
    const hunk = impactSettings.hunkHeader.exec(line);
    if (hunk !== null && current !== null) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      ranges.get(current).push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return ranges;
}

function withExtents(declared) {
  return declared.map((symbol, i) => {
    const nested = new Set([symbol.name]);
    let end = Infinity;
    for (const follower of declared.slice(i + 1)) {
      if (follower.line > symbol.line && !nested.has(follower.owner)) {
        end = follower.line - 1;
        break;
      }
      nested.add(follower.name);
    }
    return { ...symbol, end };
  });
}

function changedSeeds(db, ports, root) {
  const committed = headObjects(ports, root);
  const changed = db.prepare("SELECT id, path, oid FROM file WHERE extra=0 ORDER BY path").all().filter((row) => committed.get(row.path) !== row.oid);
  const tracked = changed.filter((row) => committed.has(row.path));
  const ranges = tracked.length ? changedRanges(ports, root, tracked.map((row) => row.path)) : new Map();
  return changed.map((row) => ({ id: row.id, path: row.path, ranges: committed.has(row.path) ? ranges.get(row.path) ?? null : null }));
}

function targetSeeds(db, target) {
  const file = db.prepare("SELECT id, path FROM file WHERE path=?").get(target);
  if (file) {
    return [{ id: file.id, path: file.path, ranges: null }];
  }
  const { found, others } = definitions(
    db.prepare(`SELECT s.file id, f.path, s.name, s.owner, s.line FROM sym s JOIN file f ON f.id=s.file WHERE s.name=? AND s.${CODE_SYMBOL} ORDER BY f.path, s.line`),
    target,
  );
  if (!found.length) {
    throw new FindbriefError(others.length ? messages.unknownOwner(target, [...new Set(others.map(qualifiedName))].sort(byKey).join(", ")) : messages.unknownTarget(target));
  }
  return [...new Map(found.map((definition) => [definition.id, { id: definition.id, path: definition.path, ranges: null, only: definition.name }])).values()];
}

function changedNames(db, seed, settings) {
  const declared = withExtents(db.prepare(`SELECT name, owner, line FROM sym WHERE file=? AND ${CODE_SYMBOL} ORDER BY line, name`).all(seed.id));
  const touched = declared.filter(
    (symbol) => (seed.only === undefined || symbol.name === seed.only) && (seed.ranges === null || seed.ranges.some(([start, end]) => start <= symbol.end && end >= symbol.line)),
  );
  const declaringFiles = db.prepare(`SELECT count(DISTINCT file) n FROM sym WHERE name=? AND ${CODE_SYMBOL}`);
  return [...new Set(touched.map((symbol) => symbol.name))].filter(
    (name) => search.wholeIdentifier.test(name) && declaringFiles.get(name).n <= settings.maxDeclaringFiles,
  );
}

function cochangePartners(db, seeds) {
  const partners = new Map();
  const statement = db.prepare(
    "SELECT CASE WHEN src=? THEN dst ELSE src END other, detail FROM edge WHERE kind=? AND (src=? OR dst=?)",
  );
  for (const seed of seeds) {
    for (const { other, detail } of statement.all(seed.id, graphSettings.edgeKinds.cochange, seed.id, seed.id)) {
      const commits = Number(detail), entry = partners.get(other) ?? { commits: 0, best: null };
      entry.commits += commits;
      if (entry.best === null || commits > entry.best.commits) {
        entry.best = { file: seed.path, commits };
      }
      partners.set(other, entry);
    }
  }
  return partners;
}

function specificMentions(db, names, settings) {
  const mentions = mentionCounts(db, names), spread = new Map();
  for (const found of mentions.values()) {
    for (const name of found) {
      spread.set(name, (spread.get(name) ?? 0) + 1);
    }
  }
  const specific = new Map();
  for (const [file, found] of mentions) {
    const kept = found.filter((name) => spread.get(name) <= settings.maxMentioningFiles);
    if (kept.length) {
      specific.set(file, kept);
    }
  }
  return specific;
}

export function impact(db, ports, root, target, limit, settings = impactSettings) {
  const seeds = target ? targetSeeds(db, target) : changedSeeds(db, ports, root);
  const changed = seeds.map((seed) => ({ file: seed.path, symbols: changedNames(db, seed, settings) }));
  const seedPaths = new Set(seeds.map((seed) => seed.path));
  const partners = cochangePartners(db, seeds);
  const paths = fileTable(db, [...partners.keys()]).paths;
  const related = new Map();
  const entry = (file) => related.get(file) ?? { file, cochange: null, commits: 0, mentions: [] };
  for (const [id, { commits, best }] of partners) {
    const file = paths.get(id);
    if (file !== undefined && !seedPaths.has(file)) {
      related.set(file, { ...entry(file), cochange: best, commits });
    }
  }
  for (const [file, names] of specificMentions(db, [...new Set(changed.flatMap((seed) => seed.symbols))], settings)) {
    if (!seedPaths.has(file)) {
      related.set(file, { ...entry(file), mentions: names });
    }
  }
  const ranked = [...related.values()]
    .map((item) => ({ ...item, score: item.commits + settings.mentionWeight * item.mentions.length, test: fileClasses.test.test(item.file) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || byKey(a.file, b.file));
  return {
    changed,
    related: ranked.slice(0, limit).map(({ file, cochange, mentions, test }) => ({ file, cochange, mentions, test })),
    moreFiles: Math.max(0, ranked.length - limit),
  };
}

export function when(db, query, type, limit) {
  const match = ftsQuery(terms(query));
  if (!match) {
    throw new FindbriefError(messages.whenNeedsWords);
  }
  const { subject, body } = ranking.commitBm25Weights;
  const rows = db
    .prepare(
      `SELECT r.id, r.sha, r.time, r.subject, bm25(rfts, ${subject}, ${body}) score FROM rfts JOIN revision r ON r.id=rfts.rowid
    WHERE rfts MATCH ? AND (? IS NULL OR r.type=?) ORDER BY score, r.time DESC LIMIT ?`,
    )
    .all(match, type, type, limit);
  const touchedFiles = db.prepare(
    `SELECT path FROM touch WHERE revision=? ORDER BY path LIMIT ${whenSettings.filesShownPerCommit}`,
  );
  return rows.map((row) => ({
    sha: row.sha,
    time: row.time,
    subject: row.subject,
    files: touchedFiles.all(row.id).map((touched) => touched.path),
  }));
}

export function areaMap(files) {
  const modules = new Set(
    files
      .filter((file) => fileClasses.moduleManifests.has(basename(file)))
      .map((file) => dirname(file))
      .filter((directory) => directory !== "."),
  );
  return (file) => {
    for (let directory = dirname(file); directory !== "."; directory = dirname(directory)) {
      if (modules.has(directory)) {
        return directory;
      }
    }
    return file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
  };
}

function weightedAreas(files, rankOf) {
  const areaOf = areaMap(files.map((file) => file.path));
  const areas = new Map();
  for (const file of files) {
    const name = areaOf(file.path);
    const area = areas.get(name) ?? { area: name, weight: 0, files: [] };
    const score = rankOf(file.id) * (file.extra ? ranking.weights.spec : 1);
    area.weight += score;
    area.files.push({ path: file.path, score, id: file.id });
    areas.set(name, area);
  }
  return areas;
}

function keySymbolStatement(db) {
  const keyKinds = briefSettings.keySymbolKinds.map((kind) => `'${kind}'`).join(",");
  return db.prepare(
    `SELECT name FROM sym WHERE file=? AND kind IN (${keyKinds}) ORDER BY line, name LIMIT ${briefSettings.keySymbolsPerFile}`,
  );
}

function areaLine(area, keySymbols) {
  const top = area.files
    .sort((a, b) => b.score - a.score || byKey(a.path, b.path))
    .slice(0, briefSettings.topFilesPerArea)
    .map((file) => {
      const names = keySymbols.all(file.id).map((row) => row.name);
      return names.length ? `${file.path} (${names.join(", ")})` : file.path;
    });
  return `- ${area.area} [${area.files.length}]: ${top.join("; ")}`;
}

function recentCommitLines(db) {
  return db
    .prepare(`SELECT sha, time, subject FROM revision ORDER BY time DESC, id DESC LIMIT ${briefSettings.recentCommits}`)
    .all()
    .map((row) => `- ${isoDay(row.time)} ${shortSha(row.sha)} ${row.subject}`);
}

export function brief(db, head, budget, rankingGraph) {
  const rank = pagerank(rankingGraph, new Map(Array.from(rankingGraph.ids, (id) => [id, 1])), ranking.weights.alpha);
  const files = db.prepare("SELECT id, path, extra FROM file ORDER BY path").all();
  const areas = weightedAreas(files, (id) => rank[rankingGraph.nodeOf.get(id)] ?? 0);
  const keySymbols = keySymbolStatement(db);
  const ordered = [...areas.values()]
    .map((area) => ({ ...area, weight: round(area.weight) }))
    .sort((a, b) => b.weight - a.weight || byKey(a.area, b.area));
  const tail = ["", messages.brief.recentHeading, ...recentCommitLines(db)];
  const lines = [messages.brief.heading(head, files.length, areas.size), "", messages.brief.areasHeading];
  for (const [position, area] of ordered.entries()) {
    const line = areaLine(area, keySymbols);
    if (lines.join("\n").length + line.length + tail.join("\n").length + briefSettings.tailReserveCharacters > budget) {
      lines.push(messages.brief.moreAreas(ordered.length - position));
      break;
    }
    lines.push(line);
  }
  return [...lines, ...tail].join("\n");
}
