#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  byKey,
  environment as environmentNames,
  files as fileClasses,
  languages,
  limits,
  lookupTable,
  nonEmptyOrNull,
  nonZeroOr,
} from "../scripts/config.mjs";
import { find, refresh, WEIGHTS } from "../scripts/findbrief.mjs";
import { symbols } from "../scripts/symbols.mjs";

const bench = Object.freeze({
  unanswerable: /\.(svg|lock)$/,
  conventionalPrefix: /^\w+(\([^)]*\))?!?:\s*/,
  maxTouchedFiles: 40,
  minimumQueryWords: 2,
  resultsPerQuestion: 10,
  symbolCases: {
    minimumNameLength: 6,
    kinds: ["struct", "enum", "trait", "fn", "class", "function", "def", "interface", "type"],
    keepEvery: 10,
  },
  astCases: {
    minimumNameLength: 6,
    keepEvery: 10,
  },
  tuning: {
    multipliers: [0, 0.5, 0.75, 1.25, 1.5, 2],
    passes: 2,
    keys: ["text", "path", "symbol", "spec", "test", "bm25.0", "bm25.1"],
    roundingScale: 1000,
    minimumImprovement: 1e-9,
  },
  recallDepth: 5,
  temporaryPrefixes: { clone: "findbrief-holdout-", index: "findbrief-holdout-index-" },
});

const HEADING = languages.headingKindPrefix;
const NAME_COLUMN_WIDTH = 28;
const LANGUAGE_COLUMN_WIDTH = 4;
const COUNT_COLUMN_WIDTH = 6;
const PERCENT_COLUMN_WIDTH = 5;

function git(root, ...args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: limits.gitOutputBytes,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}

const shortSha = (sha) => sha.slice(0, limits.shortShaLength);

function trackedFiles(root, at) {
  const listing = at ? git(root, "ls-tree", "-r", "--name-only", at) : git(root, "ls-files");
  return new Set(listing.split("\n"));
}

function commitRecords(root, range) {
  return git(root, "log", "--no-merges", "--no-renames", "--format=%x1e%H%x00%s", "--name-only", range)
    .split("\x1e")
    .slice(1);
}

const isAnswerable = (file, tracked) =>
  tracked.has(file) && !fileClasses.skipped.test(file) && !bench.unanswerable.test(file);

function commitCase(record, tracked) {
  const [head, ...names] = record.split("\n");
  const [sha, subject] = head.split("\0");
  const touched = names.map((name) => name.trim()).filter(Boolean);
  const expected = [...new Set(touched.filter((file) => isAnswerable(file, tracked)))].sort();
  const query = subject.replace(bench.conventionalPrefix, "").trim();
  const usable =
    expected.length && touched.length <= bench.maxTouchedFiles && query.split(/\s+/).length >= bench.minimumQueryWords;
  return usable ? { sha: shortSha(sha), query, expected } : null;
}

export function cases(root, { range = "HEAD", at = null } = {}) {
  const tracked = trackedFiles(root, at);
  return commitRecords(root, range)
    .map((record) => commitCase(record, tracked))
    .filter((question) => question !== null);
}

export function symbolCases(db) {
  const { minimumNameLength, kinds, keepEvery } = bench.symbolCases;
  const kindList = kinds.map((kind) => `'${kind}'`).join(",");
  return db
    .prepare(
      `SELECT s.name query, f.path FROM sym s JOIN file f ON f.id=s.file
    WHERE s.kind NOT LIKE '${HEADING}%' AND length(s.name) >= ${minimumNameLength}
    GROUP BY s.name HAVING count(*) = 1 AND max(s.kind) IN (${kindList})
    ORDER BY s.name`,
    )
    .all()
    .filter((_, i) => i % keepEvery === 0)
    .map((row) => ({ query: row.query, expected: [row.path] }));
}

function holdout(root, back, environment) {
  const base = git(root, "rev-parse", `HEAD~${back}`).trim();
  const clone = mkdtempSync(path.join(tmpdir(), bench.temporaryPrefixes.clone));
  const home = mkdtempSync(path.join(tmpdir(), bench.temporaryPrefixes.index));
  try {
    git(root, "clone", "-q", "--shared", "--no-checkout", root, clone);
    git(clone, "checkout", "-q", "--detach", base);
    const holdoutEnvironment = { ...environment, [environmentNames.indexHome]: home };
    const { db } = refresh(clone, { environment: holdoutEnvironment });
    const questions = cases(root, { range: `${base}..HEAD`, at: base });
    const metrics = evaluate(db, questions, WEIGHTS);
    db.close();
    return { base: shortSha(base), questions, metrics };
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const declarationKey = (declaration) => `${declaration.line}:${declaration.name}`;
const sameOwner = (ours, truth) => (ours.owner ?? null) === (truth.owner ?? null);

function extractedDeclarations(root, file) {
  const declared = symbols(file, readFileSync(path.join(root, file), "utf8")).filter(
    (symbol) => !symbol.kind.startsWith(HEADING),
  );
  return new Map(declared.map((symbol) => [declarationKey(symbol), symbol]));
}

function compareExtractor(root, truth) {
  const byLanguage = new Map();
  const locations = new Map();
  for (const [file, { lang, decls }] of Object.entries(truth)) {
    const counts = byLanguage.get(lang) ?? { truth: 0, ours: 0, hit: 0, owner: 0 };
    const ours = extractedDeclarations(root, file);
    counts.truth += decls.length;
    counts.ours += ours.size;
    for (const declaration of decls) {
      const symbol = ours.get(declarationKey(declaration));
      counts.hit += symbol ? 1 : 0;
      counts.owner += symbol && sameOwner(symbol, declaration) ? 1 : 0;
      locations.set(declaration.name, [...(locations.get(declaration.name) ?? []), { file, line: declaration.line }]);
    }
    byLanguage.set(lang, counts);
  }
  return { byLanguage, locations };
}

const languageLine = ([lang, counts]) =>
  `${lang.padEnd(LANGUAGE_COLUMN_WIDTH)} ${String(counts.truth).padStart(COUNT_COLUMN_WIDTH)} declarations: recall ${pct(counts.hit / counts.truth)}, precision ${pct(counts.hit / counts.ours)}, owner ${pct(counts.owner / Math.max(1, counts.hit))}`;

function namesDeclaredOnce(locations) {
  const { minimumNameLength, keepEvery } = bench.astCases;
  return [...locations]
    .filter(([name, places]) => places.length === 1 && name.length >= minimumNameLength)
    .sort((a, b) => byKey(a[0], b[0]))
    .filter((_, i) => i % keepEvery === 0);
}

const reportedLine = (reason) => Number(/:(\d+)$/.exec(reason)?.[1]);

function findDeclaredOnce(db, unique) {
  let fileHits = 0;
  let lineHits = 0;
  for (const [name, [place]] of unique) {
    const top = find(db, name, 1, WEIGHTS)[0];
    const rightFile = top?.file === place.file;
    fileHits += rightFile ? 1 : 0;
    lineHits += rightFile && reportedLine(top.reason) === place.line ? 1 : 0;
  }
  return `find, ${unique.length} names declared once: right file first ${pct(fileHits / unique.length)}, right file and line ${pct(lineHits / unique.length)}`;
}

function astReport(root, db, truthPath) {
  const truth = JSON.parse(readFileSync(truthPath, "utf8"));
  const { byLanguage, locations } = compareExtractor(root, truth);
  const lines = [...byLanguage].sort((a, b) => byKey(a[0], b[0])).map(languageLine);
  return [...lines, findDeclaredOnce(db, namesDeclaredOnce(locations))];
}

export function score(list, truth) {
  const expected = new Set(truth);
  const rank = list.findIndex((file) => expected.has(file));
  return {
    hit1: rank === 0 ? 1 : 0,
    r5:
      list.slice(0, bench.recallDepth).filter((file) => expected.has(file)).length /
      Math.min(expected.size, bench.recallDepth),
    mrr: rank === -1 ? 0 : 1 / (rank + 1),
  };
}

function mean(rows) {
  const count = Math.max(1, rows.length);
  const average = (metric) => rows.reduce((sum, row) => sum + row[metric], 0) / count;
  return { hit1: average("hit1"), r5: average("r5"), mrr: average("mrr") };
}

const objective = (metrics) => (metrics.mrr + metrics.hit1) / 2;

function evaluate(db, questions, weights) {
  return mean(
    questions.map((question) =>
      score(
        find(db, question.query, bench.resultsPerQuestion, weights).map((result) => result.file),
        question.expected,
      ),
    ),
  );
}

function scaledWeights(weights, key, step) {
  const { roundingScale } = bench.tuning;
  const scaled = (value) => Math.round(value * step * roundingScale) / roundingScale;
  const next = structuredClone(weights);
  const [name, index] = key.split(".");
  if (index === undefined) {
    next[name] = scaled(weights[name]);
  } else {
    next[name][index] = scaled(weights[name][index]);
  }
  return next;
}

const ALPHA = "alpha";
const invalidStep = (key, weights) => key === ALPHA && (weights.alpha <= 0 || weights.alpha >= 1);

function tune(db, train) {
  const { multipliers, passes, keys, minimumImprovement } = bench.tuning;
  let best = structuredClone(WEIGHTS);
  let bestScore = objective(evaluate(db, train, best));
  for (let pass = 0; pass < passes; pass++) {
    for (const key of keys) {
      for (const step of multipliers) {
        const next = scaledWeights(best, key, step);
        if (invalidStep(key, next)) {
          continue;
        }
        const value = objective(evaluate(db, train, next));
        if (value > bestScore + minimumImprovement) {
          best = next;
          bestScore = value;
        }
      }
    }
  }
  return best;
}

const pct = (fraction) => (100 * fraction).toFixed(1).padStart(PERCENT_COLUMN_WIDTH) + " %";
const line = (name, metrics, extra = "") =>
  `${name.padEnd(NAME_COLUMN_WIDTH)} ${pct(metrics.hit1)}  ${pct(metrics.r5)}  ${metrics.mrr.toFixed(3)}${extra}`;

function timedLine(name, run, questions) {
  const start = performance.now();
  const metrics = run();
  if (!questions.length) {
    return `${name.padEnd(NAME_COLUMN_WIDTH)} no cases`;
  }
  return line(name, metrics, `   ${((performance.now() - start) / questions.length).toFixed(1)} ms/question`);
}

const flag = () => true;
const valueAfter = (argv, at) => nonEmptyOrNull(argv[at + 1]);

const optionTable = lookupTable({
  "--tune": { name: "tune", read: flag },
  "--holdout": { name: "holdout", read: valueAfter },
  "--ast": { name: "ast", read: valueAfter },
  "--sample": { name: "sample", read: valueAfter },
});

function parseOptions(argv) {
  const options = { tune: false, holdout: null, ast: null, sample: null };
  for (const [option, { name, read }] of Object.entries(optionTable)) {
    const at = argv.indexOf(option);
    if (at !== -1) {
      options[name] = read(argv, at);
    }
  }
  return options;
}

function sampleEvenly(questions, size) {
  if (questions.length <= size) {
    return questions;
  }
  const bucket = (i) => Math.floor((i * size) / questions.length);
  return questions.filter((_, i) => bucket(i) !== bucket(i - 1));
}

function holdoutSection({ root, environment, options }) {
  const result = holdout(root, Number(options.holdout), environment);
  return [line(`holdout, ${result.questions.length} commits after ${result.base}`, result.metrics)];
}

function astSection({ root, db, options }) {
  return ["", ...astReport(root, db, options.ast)];
}

function tuneSection({ db, train, test }) {
  const tuned = tune(db, train);
  const check = [evaluate(db, test, WEIGHTS), evaluate(db, test, tuned)];
  return [
    line("current, tune half", evaluate(db, train, WEIGHTS)),
    line("current, check half", check[0]),
    line("tuned, tune half", evaluate(db, train, tuned)),
    line("tuned, check half", check[1]),
    "",
    objective(check[1]) > objective(check[0])
      ? `Improves on unseen commits; candidate weights: ${JSON.stringify(tuned)}`
      : "Does not improve on unseen commits; keep the current weights.",
  ];
}

const optionalSections = [
  { enabled: (options) => options.holdout !== null, lines: holdoutSection },
  { enabled: (options) => options.ast !== null, lines: astSection },
  { enabled: (options) => options.tune, lines: tuneSection },
];

function main(argv, { cwd, environment }) {
  const options = parseOptions(argv);
  const root = git(cwd, "rev-parse", "--show-toplevel").trim();
  const { db } = refresh(root, { environment });
  const size = nonZeroOr(Number(options.sample), Infinity);
  const all = sampleEvenly(cases(root), size);
  const named = sampleEvenly(symbolCases(db), size);
  const train = all.filter((_, i) => i % 2 === 0);
  const test = all.filter((_, i) => i % 2 === 1);
  const context = { root, db, environment, options, all, named, train, test };
  const report = [
    `${all.length} questions from commits (${train.length} to tune, ${test.length} to check)`,
    "",
    `${"".padEnd(NAME_COLUMN_WIDTH)} hit@1    recall@5  MRR`,
    timedLine("context, commits", () => evaluate(db, all, WEIGHTS), all),
    timedLine(`context, ${named.length} exact symbols`, () => evaluate(db, named, WEIGHTS), named),
  ];
  for (const section of optionalSections) {
    if (section.enabled(options)) {
      report.push(...section.lines(context));
    }
  }
  db.close();
  process.stdout.write(report.join("\n") + "\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2), { cwd: process.cwd(), environment: process.env });
}
