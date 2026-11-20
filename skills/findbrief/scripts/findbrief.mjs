#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  cli,
  FindbriefError,
  git as gitFormat,
  impact as impactSettings,
  isoDay,
  limits,
  lookupTable,
  messages,
  nonEmptyOrNull,
  nonZeroOr,
  ranking,
  runtime,
  search,
  why as whySettings,
  words,
} from "./config.mjs";
import { brief, exactTokens, find, impact, pagerank, refs, terms, when, why, withTextLines } from "./rank.mjs";
import { ignoreRules, ignoreVerdict, indexCounts, readGraph, readText, refreshIndex, repositoryFilterOverrides, runGit } from "./store.mjs";
import { symbols } from "./symbols.mjs";

async function importSqliteWithoutItsWarning() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => (runtime.suppressedWarning.test(String(warning)) ? undefined : emitWarning.call(process, warning, ...rest));
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

const { DatabaseSync } = await importSqliteWithoutItsWarning();

function localConfigMentionsFilters(file) {
  const { filterHint, localConfigBytes } = gitFormat.safety;
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    return error.code !== "ENOENT";
  }
  return !stats.isFile() || stats.size > localConfigBytes || filterHint.test(readFileSync(file, "utf8"));
}

function mayDefineRepositoryFilters(cwd) {
  const { relocatingVariables, gitDirectory, localConfigFiles } = gitFormat.safety;
  if (relocatingVariables.some((name) => process.env[name] !== undefined)) {
    return true;
  }
  try {
    if (!lstatSync(path.join(cwd, gitDirectory)).isDirectory()) {
      return true;
    }
    return localConfigFiles.some((file) => localConfigMentionsFilters(path.join(cwd, gitDirectory, file)));
  } catch {
    return true;
  }
}

function safeGit() {
  const { safety } = gitFormat;
  const env = { ...process.env, ...safety.environment };
  const spawn = (cwd, args, input) => spawnSync("git", [...safety.options, ...args], { cwd, env, encoding: "utf8", input, maxBuffer: limits.gitOutputBytes });
  const filterOverrides = (cwd, command) =>
    safety.filteringCommands.has(command) && mayDefineRepositoryFilters(cwd) ? repositoryFilterOverrides(spawn(cwd, safety.repositoryFilters).stdout ?? "") : [];
  return (cwd, args, input) => spawn(cwd, [...filterOverrides(cwd, args[0]), ...args], input);
}

export function createPorts({ environment = process.env } = {}) {
  return Object.freeze({
    environment,
    homeDirectory: homedir(),
    now: () => Date.now(),
    git: safeGit(),
    lstat: (file) => lstatSync(file),
    readFile: (file) => readFileSync(file),
    exists: (file) => existsSync(file),
    makeDirectory: (directory, options) => mkdirSync(directory, options),
    openDatabase: (file) => new DatabaseSync(file),
  });
}

export { exactTokens, find, ignoreRules, ignoreVerdict, pagerank, symbols, terms, words };

export const WEIGHTS = ranking.weights;

export function refresh(root, { environment = process.env, ports = createPorts({ environment }) } = {}) {
  return refreshIndex(ports, root);
}

export function graph(db, environment = process.env) {
  return readGraph(db, environment);
}

export function fit(text, budget) {
  if (text.length <= budget) {
    return text;
  }
  return (
    text.slice(0, text.lastIndexOf("\n", budget - messages.truncated.length) + 1) +
    messages.truncated
  );
}

const commitLine = (commit) => `${isoDay(commit.time)} ${messages.shortSha(commit.sha)} ${commit.subject}`;

function whyLines(result) {
  const lines = [];
  for (const definition of result.definitions) {
    lines.push(`${definition.kind} ${definition.name} at ${definition.file}:${definition.line}`);
    if (definition.note) {
      lines.push(`  ${definition.note}`);
    }
    for (const commit of definition.commits) {
      lines.push(`  ${commitLine(commit)}`);
    }
  }
  for (const commit of result.commits) {
    const reason = commit.body.split("\n").find((line) => line.trim()) ?? "";
    lines.push(commitLine(commit), ...(reason ? [`    ${reason.slice(0, whySettings.reasonCharacters)}`] : []));
  }
  if (result.cochanged.length) {
    lines.push(messages.changesWith(result.cochanged.map((entry) => `${entry.path} (${entry.n})`).join(", ")));
  }
  return lines;
}

function refsLines(result) {
  const lines = [...result.definitions.map(messages.refsDefinition), ...result.files.map(({ file, lines: at, more }) => messages.refsFile(file, at, more))];
  if (result.moreFiles) {
    lines.push(messages.moreFiles(result.moreFiles));
  }
  return lines.length ? lines : [messages.noMentions(result.target)];
}

function impactLines(result) {
  if (!result.changed.length) {
    return [messages.noChanges];
  }
  const { symbolsShownPerFile: shown, changedFilesShown } = impactSettings;
  const lines = [
    messages.changedHeading,
    ...result.changed.slice(0, changedFilesShown).map(({ file, symbols: names }) => `  ${file}${names.length ? ` (${messages.shortList(names, shown)})` : ""}`),
    ...(result.changed.length > changedFilesShown ? [messages.moreChanged(result.changed.length - changedFilesShown)] : []),
    messages.checkHeading,
    ...result.related.map((item, i) => `${String(i + 1).padStart(cli.rankColumnWidth)}. ${item.file}  ${messages.impactReason(item.cochange, item.mentions, item.test, shown, result.changed.length === 1)}`),
  ];
  if (result.moreFiles) {
    lines.push(messages.moreFiles(result.moreFiles));
  }
  return lines;
}

const renderers = lookupTable({
  brief: (result) => [result],
  find: (result) => [
    ...(result.length ? [] : [messages.noMatches]),
    ...result.map((match, i) => `${String(i + 1).padStart(cli.rankColumnWidth)}. ${match.file}  ${match.reason}`),
  ],
  when: (result) => [
    ...(result.length ? [] : [messages.noMatchingCommits]),
    ...result.flatMap((commit) => [commitLine(commit), `    ${commit.files.join(", ")}`]),
  ],
  why: whyLines,
  refs: refsLines,
  impact: impactLines,
  index: (result) => [JSON.stringify(result)],
});
const render = (command, result) => renderers[command](result).join("\n") + "\n";

const commands = lookupTable({
  brief: ({ db, head, budget, ports }) => brief(db, head, budget, graph(db, ports.environment)),
  find: ({ db, query, limit, ports, textOf }) => withTextLines(find(db, query, limit, WEIGHTS), query, textOf),
  impact: ({ db, ports, root, args, limit }) => {
    if (args.length > 1) {
      throw new FindbriefError(messages.usage);
    }
    return impact(db, ports, root, args[0] ?? null, limit);
  },
  refs: ({ db, args, limit, textOf }) => {
    if (args.length < 1 || args.length > 2) {
      throw new FindbriefError(messages.usage);
    }
    return refs(db, args[0], { limit, scope: args[1] ?? null, textOf });
  },
  why: ({ db, ports, root, query, limit }) => why(db, ports, root, query, limit),
  when: ({ db, query, type, limit }) => when(db, query, type, limit),
  index: ({ db, head }) => ({ head, ...indexCounts(db) }),
});

function splitArguments(argv) {
  const options = lookupTable({}), positional = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (!arg.startsWith(cli.optionPrefix)) {
      positional.push(arg);
      continue;
    }
    const option = cli.options[arg];
    if (option === undefined) {
      throw new FindbriefError(messages.unknownOption(arg));
    }
    options[option.name] = optionValues[option.value](arg, argv[at + 1]);
    at += option.value === "flag" ? 0 : 1;
  }
  return { options, positional };
}

function valueOf(option, value) {
  if (value === undefined || value.startsWith(cli.optionPrefix)) {
    throw new FindbriefError(messages.optionNeedsValue(option));
  }
  return value;
}

const optionValues = lookupTable({
  flag: () => true,
  text: valueOf,
  integer: (option, value) => {
    const number = Number(valueOf(option, value));
    if (!Number.isSafeInteger(number)) {
      throw new FindbriefError(messages.notAWholeNumber(option, value));
    }
    return number;
  },
});

const boundedNumber = (value, fallback, minimum, maximum = Infinity) =>
  Math.max(minimum, Math.min(maximum, nonZeroOr(value ?? fallback, fallback)));

function parseArguments(argv) {
  const { options, positional } = splitArguments(argv);
  const [command, ...rest] = positional;
  return {
    json: options.json === true,
    limit: boundedNumber(options.limit, cli.defaultLimit, cli.minimumLimit, cli.maximumLimit),
    type: nonEmptyOrNull(options.type),
    budget: boundedNumber(options.budget, cli.defaultBudget, cli.minimumBudget),
    command,
    rest,
  };
}

function repositoryPath(arg, { root, cwd, ports }) {
  const inRepository = path.relative(root, path.resolve(cwd, arg));
  const insideRepository = inRepository && inRepository.split(path.sep)[0] !== ".." && !path.isAbsolute(inRepository);
  return search.pathLike.test(arg) && insideRepository && (path.isAbsolute(arg) || ports.exists(path.join(root, inRepository))) ? inRepository : arg;
}

function main(argv, { cwd, ports }) {
  const { json, limit, type, budget, command, rest } = parseArguments(argv);
  const root = runGit(ports, cwd, gitFormat.commands.topLevel).trim();
  const run = commands[command];
  if (!run) {
    throw new FindbriefError(messages.usage);
  }
  const { db, head } = refreshIndex(ports, root);
  try {
    const args = rest.map((arg) => repositoryPath(arg, { root, cwd, ports }));
    const textOf = (file) => readText(ports, root, file);
    const result = run({ db, head, root, budget, limit, type, ports, query: args.join(" "), args, textOf });
    process.stdout.write(
      json
        ? JSON.stringify(result, null, cli.jsonIndentation) + "\n"
        : fit(render(command, result), budget),
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2), { cwd: process.cwd(), ports: createPorts({ environment: process.env }) });
  } catch (error) {
    if (!(error instanceof FindbriefError)) {
      throw error;
    }
    process.stderr.write(`${messages.program}: ${error.message}\n`);
    process.exit(cli.errorExitStatus);
  }
}
