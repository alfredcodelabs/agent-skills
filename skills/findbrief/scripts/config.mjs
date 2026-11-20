const rejectSetMutation = () => {
  throw new TypeError("findbrief configuration sets are read-only");
};
const readOnlySet = (values) => {
  const set = new Set(values);
  for (const mutator of ["add", "delete", "clear"]) {
    Object.defineProperty(set, mutator, { value: rejectSetMutation });
  }
  return set;
};
const wordSet = (list) => readOnlySet(list.split(" "));

function deepFreeze(value) {
  if (value instanceof RegExp) {
    return Object.preventExtensions(value);
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

const MILLISECONDS_PER_SECOND = 1000;
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;

export class FindbriefError extends Error {
  constructor(message) {
    super(message);
    this.name = "FindbriefError";
  }
}

export const lookupTable = (entries) => Object.assign(Object.create(null), entries);
export const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const round = (x) => Math.round(x * ranking.scoreRoundingScale) / ranking.scoreRoundingScale;
export const nonEmptyOrNull = (value) => (value === undefined || value === null || value === "" ? null : value);
export const nonZeroOr = (value, fallback) => (value === 0 || Number.isNaN(value) ? fallback : value);
export const isoDay = (seconds) => new Date(seconds * MILLISECONDS_PER_SECOND).toISOString().slice(0, ISO_DATE_LENGTH);

export function words(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

export const ranking = deepFreeze({
  weights: {
    bm25: [8, 4, 1],
    text: 0.4,
    path: 0.35,
    symbol: 0.25,
    spec: 0.5,
    test: 0.7,
    history: 0.5,
    alpha: 0.25,
  },
  commitBm25Weights: { subject: 4, body: 1 },
  lanes: { typo: 1, exact: 2, path: 3 },
  textCandidates: 100,
  pagerankIterations: 30,
  scoreRoundingScale: 1e12,
  maxDefinedSymbolsShown: 4,
});

const edgeKinds = { uses: "uses", cochange: "cochange" };

export const graph = deepFreeze({
  edgeKinds,
  storedEdgeKinds: [edgeKinds.uses, edgeKinds.cochange],
  edgeDirections: [
    [0, 1],
    [1, 0],
  ],
  storedParts: ["ids", "offsets", "targets", "weights"],
  maxDefiningFilesPerUse: 2,
  commonIdentifierFileCount: 60,
  usedNamesShownPerEdge: 3,
  usesWeightOffset: 1,
  bulkCommitFileCount: 40,
  cochangeHalfLifeDays: 180,
  cochangeDecayBase: 0.5,
  secondsPerDay: 86400,
  pairKeyBase: 1e7,
});

export const limits = deepFreeze({
  schemaVersion: 15,
  maxFileBytes: 512 * 1024,
  binarySniffBytes: 8192,
  gitOutputBytes: 256 * 1024 * 1024,
  identifiersPerFile: 20000,
  implHeaderTokens: 256,
  typeParameterTokens: 64,
  symbolNameLength: 200,
  racyModificationMs: 2000,
  busyTimeoutMs: 10000,
  indexNameHashLength: 12,
  shortShaLength: 7,
});

export const storage = deepFreeze({
  indexDirectoryMode: 0o700,
  meta: { schema: "schema", head: "head", inventory: "inventory" },
  keyValue: { directories: "dirs", words: "words", edgeListPrefix: "edges:" },
});

const gitEmptyValue = "FINDBRIEF_GIT_EMPTY";
const gitFalseValue = "FINDBRIEF_GIT_FALSE";
const commitLogFormat = "/%H%x00%ct%x00%s%x00%b";

export const git = deepFreeze({
  safety: {
    options: ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "log.showSignature=false", "-c", "protocol.ext.allow=never"],
    environment: { GIT_NO_LAZY_FETCH: "1", [gitEmptyValue]: "", [gitFalseValue]: "false" },
    filteringCommands: wordSet("status diff"),
    repositoryFilters: ["config", "-z", "--name-only", "--show-scope", "--get-regexp", "^filter\\."],
    untrustedScopes: wordSet("local worktree"),
    relocatingVariables: ["GIT_DIR", "GIT_COMMON_DIR"],
    gitDirectory: ".git",
    localConfigFiles: ["config", "config.worktree"],
    localConfigBytes: 1024 * 1024,
    filterHint: /filter|include/i,
    filterSection: "filter.",
    filterOverrides: [
      ["clean", gitEmptyValue],
      ["smudge", gitEmptyValue],
      ["process", gitEmptyValue],
      ["required", gitFalseValue],
    ],
    configFromEnvironment: (key, variable) => `--config-env=${key}=${variable}`,
  },
  commands: {
    topLevel: ["rev-parse", "--show-toplevel"],
    trackedFiles: ["ls-files", "-s", "-z"],
    status: (listUntracked) => ["status", "--porcelain=v2", "--branch", "-z", `--untracked-files=${listUntracked ? "all" : "no"}`, "--no-renames", "--ignore-submodules=all"],
    ignoredUnder: (pathspecs) => ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ...pathspecs],
    hashPaths: ["hash-object", "--no-filters", "--stdin-paths"],
    hashPath: (file) => ["hash-object", "--no-filters", "--", file],
    isAncestor: (ancestor, head) => ["merge-base", "--is-ancestor", ancestor, head],
    commitLog: (range) => ["log", "--reverse", "--no-renames", `--format=${commitLogFormat}`, "--name-only", "-z", range],
    commitRange: (from, to) => `${from}..${to}`,
    commitTime: (commit) => ["log", "-1", "--format=%ct", commit],
    lineHistory: (span, limit) => ["log", "-L", span, "-s", "--no-textconv", "--no-ext-diff", `-${limit}`, "--format=%H%x00%ct%x00%s"],
    lineSpan: (first, last, file) => `${first},${last}:${file}`,
    headTree: ["ls-tree", "-r", "-z", "HEAD"],
    changedLines: (files) => ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--", ...files],
  },
  regularFileModes: ["100644 ", "100755 "],
  porcelain: {
    records: lookupTable({ "#": "header", "1": "ordinary", u: "unmerged", "?": "untracked" }),
    pathField: lookupTable({ ordinary: 8, unmerged: 10 }),
    branchOidHeader: "# branch.oid ",
    untrackedPathOffset: 2,
    deletedStatus: "D",
  },
  commitSha: /^[0-9a-f]{40,64}$/,
  commitMarker: "/",
  commitFieldCount: 4,
  namesSeparator: "\n",
  commitTime: /^\d+$/,
  treeEntry: /^\d+ blob ([0-9a-f]+)\t/,
  literalPathspec: ":(literal)",
  stdinPathUnsafe: /\n|\r$|^"/,
  outsideRepository: /^\/|(^|\/)\.\.(\/|$)/,
  fieldSeparator: "\0",
});

export const cli = deepFreeze({
  optionPrefix: "-",
  options: lookupTable({
    "-n": { name: "limit", value: "integer" },
    "--type": { name: "type", value: "text" },
    "--budget": { name: "budget", value: "integer" },
    "--json": { name: "json", value: "flag" },
  }),
  rankColumnWidth: 2,
  jsonIndentation: 2,
  errorExitStatus: 2,
  defaultLimit: 10,
  minimumLimit: 1,
  maximumLimit: 100,
  defaultBudget: 6000,
  minimumBudget: 500,
});

export const brief = deepFreeze({
  keySymbolKinds: ["struct", "enum", "trait", "class", "fn", "function", "def"],
  keySymbolsPerFile: 4,
  topFilesPerArea: 2,
  recentCommits: 8,
  tailReserveCharacters: 80,
});

export const why = deepFreeze({
  definitionsShown: 3,
  cochangedShown: 5,
  spanWithoutNextSymbol: 40,
  reasonCharacters: 160,
});

export const when = deepFreeze({
  filesShownPerCommit: 4,
});

export const impact = deepFreeze({
  mentionWeight: 1,
  maxDeclaringFiles: 3,
  maxMentioningFiles: 30,
  symbolsShownPerFile: 4,
  changedFilesShown: 10,
  newFileHeader: "+++ b/",
  hunkHeader: /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/,
});

export const refs = deepFreeze({
  linesShownPerFile: 8,
  nameBoundary: "[\\p{L}\\p{M}\\p{N}_]",
  regexSpecials: /[.*+?^${}()|[\]\\/]/g,
});

export const search = deepFreeze({
  stopWords: wordSet(
    "a an and are as at be by for from in into is it its of on or the to with add adds added support supports supported handle handles allow allows make makes use uses using via when",
  ),
  termPattern: /[\p{L}\p{N}]+/gu,
  minimumTermLength: 2,
  stemming: {
    minimumLength: 5,
    suffixRules: [
      [/(ies)$/, "y"],
      [/(ing|ed|es|s)$/, ""],
    ],
  },
  identifierPattern: /[A-Za-z_][A-Za-z0-9_]{3,}/g,
  wholeIdentifier: /^[A-Za-z_][A-Za-z0-9_]{3,}$/,
  exactToken: {
    leadingPunctuation: /^[`'"(]+|[`'"),:;]+$/g,
    trailingPeriod: /\.$/,
    currentDirectoryPrefix: /^\.\//,
    allowedCharacters: /^[\p{L}\p{M}\p{N}_./:-]+$/u,
    codeShape: /[a-z][A-Z]|_|::|\/|\.\w+$/,
  },
  pathLike: /[/.]/,
  pathSeparators: /[/._-]/g,
  rawIdentifierPrefix: /(^|::)r#/g,
  ownerSeparator: "::",
});

const asciiClass = (pattern) => (character) => pattern.test(character);

export const ignoreGrammar = deepFreeze({
  lineBreak: /\r?\n/,
  comment: "#",
  negation: "!",
  escape: "\\",
  separator: "/",
  globstar: "**",
  wildcardOrEnd: /[*?[]|$/,
  escapedCharacter: /\\(.)/gs,
  trailingSpace: /\s/,
  tokens: lookupTable({ "\\": "escape", "*": "star", "?": "any", "[": "class", "/": "separator" }),
  classes: {
    close: "]",
    negations: wordSet("! ^"),
    range: "-",
    namedOpen: "[:",
    namedClose: ":]",
    named: lookupTable({
      alnum: asciiClass(/^[A-Za-z0-9]$/),
      alpha: asciiClass(/^[A-Za-z]$/),
      blank: asciiClass(/^[ \t]$/),
      cntrl: asciiClass(/^[\x00-\x1f\x7f]$/),
      digit: asciiClass(/^[0-9]$/),
      graph: asciiClass(/^[\x21-\x7e]$/),
      lower: asciiClass(/^[a-z]$/),
      print: asciiClass(/^[\x20-\x7e]$/),
      punct: asciiClass(/^[!-\/:-@[-`{-~]$/),
      space: asciiClass(/^[ \t\n\v\f\r]$/),
      upper: asciiClass(/^[A-Z]$/),
      xdigit: asciiClass(/^[0-9A-Fa-f]$/),
    }),
  },
});

export const files = deepFreeze({
  ignoreFile: ".briefignore",
  skipped:
    /(^|\/)(Cargo\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum|flake\.lock)$|\.min\.(js|css)$|\.map$|\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|gz|zip|tar|zst|deb|pdf|sqlite3?|wasm|bin)$/i,
  test: /(^|\/)(tests?|__tests__|testdata|fixtures?)\/|(_tests?|\.test|\.spec|_spec)\.\w+$|(^|\/)test_[^/]*\.py$/,
  history:
    /(^|\/)((change[-_ ]?log|changes|history|news|release[-_ ]?notes)([-_ ]?v?\d[\w.-]*)?(\.(md|mdx|rst|txt|adoc))?|(change[-_ ]?log|release[-_ ]?notes|releases)\/.+\.(md|mdx|rst|txt|adoc))$/i,
  moduleManifests: wordSet(
    "Cargo.toml package.json go.mod pyproject.toml setup.py pom.xml build.gradle build.gradle.kts composer.json Gemfile mix.exs deno.json CMakeLists.txt",
  ),
});

export const commits = deepFreeze({
  conventionalSubject: /^(\w+)(?:\(([^)]*)\))?!?:\s*(.*)$/,
});

export const environment = deepFreeze({
  indexHome: "FINDBRIEF_HOME",
  xdgCacheHome: "XDG_CACHE_HOME",
  homeCacheDirectory: ".cache",
  indexDirectoryName: "findbrief",
  edgeKindsOverride: "FINDBRIEF_EDGES",
  edgeKindsSeparator: ",",
});

export const runtime = deepFreeze({
  suppressedWarning: /SQLite/,
});

export const sessionStart = deepFreeze({
  heading: "findbrief map of this repository (from the session-start hook; do not run brief again). Use the findbrief skill for find, refs, impact, why and when.",
  command: "brief",
});

const headingKindPrefix = "h";
const headingCloseMark = "#";
const headingBlanks = " \t";

function headingText(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === headingCloseMark) {
    end--;
  }
  while (end > 0 && headingBlanks.includes(text[end - 1])) {
    end--;
  }
  return end === 0 ? text[0] : text.slice(0, end);
}
const notDeclaringAfter = wordSet(". ?. * < ,");
const importedAfter = wordSet("import");
const unicodeIdentifier = /[\p{L}_][\p{L}\p{M}\p{N}_]*/u;
const dollarIdentifier = /[\p{L}_$][\p{L}\p{M}\p{N}_$]*/u;

const commonLexical = {
  scanOrder: ["lineBreak", "whitespace", "lineContinuation", "lineComments", "blockComment", "strings", "templates", "regex", "charactersOrLifetimes", "number", "identifier", "punctuation"],
  wordRuleOrder: ["rawIdentifiers", "rawStrings", "stringPrefixes"],
  lineBreak: "\n",
  whitespace: " \t\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
  escape: "\\",
  shebang: "#!",
  number: { digits: "0123456789", pattern: /[0-9][\w.]*/ },
  punctuation: /::|->|=>|\?\.|[^\s]/u,
};
const slashComments = ["//"];
const flatBlockComment = { open: "/*", close: "*/", nests: false };
const singleLineQuotes = [
  { delimiter: '"', multiLine: false },
  { delimiter: "'", multiLine: false },
];

const lexical = {
  rust: {
    ...commonLexical,
    identifier: unicodeIdentifier,
    lineComments: slashComments,
    blockComment: { ...flatBlockComment, nests: true },
    strings: [{ delimiter: '"', multiLine: true }],
    charactersOrLifetimes: { quote: "'" },
    rawIdentifiers: { prefix: "r", mark: "#" },
    rawStrings: { prefixes: /^(r|br|cr)$/, quote: '"', fence: "#", fenceRun: /^#*/, fenceLookahead: 256 },
    stringPrefixes: { pattern: /^(b|c|r|br|cr)$/, quotes: wordSet("\" '") },
  },
  javascript: {
    ...commonLexical,
    identifier: dollarIdentifier,
    lineComments: slashComments,
    blockComment: flatBlockComment,
    strings: singleLineQuotes,
    templates: { quote: "`", interpolationStart: "${", interpolationEnd: "}", nestedOpen: "{" },
    regex: {
      delimiter: "/",
      classMarks: lookupTable({ "[": true, "]": false }),
      afterWords: wordSet("return typeof instanceof in of new delete void throw case do else yield await"),
      notAfterPunctuation: wordSet(") ] }"),
      flags: /^[a-z]*/,
      flagsLookahead: 8,
    },
  },
  java: {
    ...commonLexical,
    identifier: dollarIdentifier,
    lineComments: slashComments,
    blockComment: flatBlockComment,
    strings: [{ delimiter: '"""', multiLine: true }, ...singleLineQuotes],
  },
  python: {
    ...commonLexical,
    identifier: unicodeIdentifier,
    lineComments: ["#"],
    lineContinuation: "\\\n",
    strings: [
      { delimiter: '"""', multiLine: true },
      { delimiter: "'''", multiLine: true },
      ...singleLineQuotes,
    ],
    stringPrefixes: { pattern: /^[rbuf]{1,2}$/i, quotes: wordSet("\" '") },
    indentation: { nestingDelta: lookupTable({ "(": 1, "[": 1, "{": 1, ")": -1, "]": -1, "}": -1 }) },
  },
};

const goIdentifier = String.raw`[\p{L}_][\p{L}\p{N}_]*`;
const braceBlocks = lookupTable({ "(": "group", "[": "group", ")": "ungroup", "]": "ungroup", "{": "open", "}": "close", ";": "end" });
const methodBody = {
  clauseEnds: wordSet("{ ;"),
  block: "{",
  returnTypeStops: wordSet("{ ; => = }"),
  typeNesting: lookupTable({ "(": 1, "<": 1, "[": 1, ")": -1, ">": -1, "]": -1 }),
};
const methodParameters = { open: "(", close: ")" };

export const languages = deepFreeze({
  placeholderName: "_",
  headingKindPrefix,
  code: lookupTable({
    rs: {
      lexical: lexical.rust,
      scopes: "braces",
      blocks: braceBlocks,
      declares: lookupTable({ fn: "fn", struct: "struct", enum: "enum", trait: "trait", type: "type", const: "const", static: "static", mod: "mod", union: "union", macro_rules: "macro" }),
      containers: wordSet("fn struct enum trait mod union macro_rules"),
      keywords: wordSet("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
      notDeclaringAfter,
      importedAfter,
      markerBeforeName: lookupTable({ macro_rules: "!", static: "mut" }),
      impl: {
        keyword: "impl",
        notAfter: wordSet("-> : , < & = +"),
        genericDepth: lookupTable({ "<": 1, ">": -1 }),
        roles: lookupTable({ "{": "headerEnd", ";": "headerEnd", where: "headerEnd", for: "traitTarget", dyn: "modifier", mut: "modifier", "::": "pathMark", "&": "pathMark" }),
      },
    },
    js: {
      lexical: lexical.javascript,
      scopes: "braces",
      blocks: braceBlocks,
      declares: lookupTable({ function: "function", class: "class", const: "const", let: "let", interface: "interface", type: "type", enum: "enum" }),
      containers: wordSet("function class interface enum"),
      moduleOnly: wordSet("const let"),
      methods: {
        kind: "fn",
        position: "memberStart",
        after: wordSet("{ } ; , * async static get set public private protected readonly override"),
        typeParameters: { open: "<", close: ">" },
        parameters: methodParameters,
        bodyOpeners: lookupTable({ "{": "block", ":": "returnType" }),
        body: methodBody,
      },
      keywords: wordSet("await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null of return super switch this throw true try typeof var void while with yield"),
      notDeclaringAfter,
      importedAfter,
      markerBeforeName: lookupTable({ function: "*" }),
      expressions: {
        keyword: "function",
        modifier: "async",
        after: wordSet("=> = ( , : ? [ || && ?? ! return throw yield await typeof void new"),
      },
      aliasFollowers: lookupTable({ type: ["=", "<"] }),
    },
    java: {
      lexical: lexical.java,
      scopes: "braces",
      blocks: braceBlocks,
      declares: lookupTable({ class: "class", interface: "interface", enum: "enum", record: "record" }),
      containers: wordSet("class interface enum record"),
      methods: {
        kind: "fn",
        position: "afterType",
        notAfterWords: wordSet("return new throw else case yield assert do"),
        afterPunctuation: wordSet("> ] { } ;"),
        signatureEnd: ";",
        parameters: methodParameters,
        bodyOpeners: lookupTable({ "{": "block", throws: "clause" }),
        body: methodBody,
      },
      keywords: wordSet("abstract assert boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public record return short static super switch synchronized this throw throws transient try void volatile while yield"),
      notDeclaringAfter,
      importedAfter,
    },
    py: {
      lexical: lexical.python,
      scopes: "indentation",
      declares: lookupTable({ def: "def", class: "class" }),
      keywords: wordSet("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"),
    },
  }),
  lineFormats: lookupTable({
    sh: { pattern: /^[ \t]*(?:function[ \t]+|(?=[A-Za-z_][\w-]*[ \t]*\(\)))(?<name>[A-Za-z_][\w-]*)(?:[ \t]*\(\))?[ \t]*\{/gm, name: (match) => match.groups.name, kind: () => "fn" },
    md: { pattern: /^(#{1,4})[ \t]+(.+)$/gm, name: (match) => headingText(match[2]), kind: (match) => headingKindPrefix + match[1].length },
    // gofmt puts every top-level declaration at column 0, so lines are enough;
    // a method's owner is its receiver type (`func (a *T) M` → T::M).
    go: {
      pattern: new RegExp(
        String.raw`^func[ \t]+(?:\([ \t]*(?:${goIdentifier}[ \t]+)?\*?(?<owner>${goIdentifier})(?:\[[^\]\n]*\])?[ \t]*\)[ \t]*)?(?<fn>${goIdentifier})` +
          String.raw`|^(?<keyword>type|const|var)[ \t]+(?!_[ \t=])(?<declared>${goIdentifier})`,
        "gmu",
      ),
      name: (match) => match.groups.fn ?? match.groups.declared,
      kind: (match) => match.groups.keyword ?? "fn",
      owner: (match) => match.groups.owner ?? null,
      groups: {
        open: /^(type|const|var)[ \t]*\($/,
        entry: new RegExp(String.raw`^\t(?!_[ \t=])(${goIdentifier})`, "u"),
        close: /^\)/,
        rawQuote: "`",
        kind: (match) => match[1],
      },
    },
  }),
  extensions: lookupTable({ java: "java", rs: "rs", js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", py: "py", sh: "sh", bash: "sh", md: "md", go: "go" }),
  shebangs: [
    [/^#!.*\b(ba)?sh\b/, "sh"],
    [/^#!.*python/, "py"],
  ],
});

const shortSha = (value) => value.slice(0, limits.shortShaLength);

const usage = "usage: findbrief.mjs brief | find QUERY | refs NAME [PATH] | impact [PATH|SYMBOL] | why PATH|SYMBOL | when QUERY [--type T] | index [-n N] [--json]";

export const messages = deepFreeze({
  program: "findbrief",
  usage,
  unknownOption: (option) => `${option} is not an option; ${usage}`,
  optionNeedsValue: (option) => `${option} needs a value; ${usage}`,
  notAWholeNumber: (option, value) => `${option} needs a whole number, not ${value}`,
  findNeedsWords: "find needs words to search for",
  whenNeedsWords: "when needs words to search for",
  noCommits: "the repository has no commits yet",
  unknownTarget: (target) => `no file or symbol named ${target}`,
  unknownOwner: (target, owners) => `no symbol named ${target}; defined in ${owners}`,
  gitFailed: (subcommand, stderr) => `git ${subcommand}: ${stderr}`,
  gitUnavailable: lookupTable({
    ENOENT: () => "git is not installed or not on PATH",
    ENOBUFS: (subcommand) => `git ${subcommand}: output exceeds ${limits.gitOutputBytes} bytes`,
  }),
  gitNotRun: (subcommand, error) => `git ${subcommand}: ${error.message}`,
  noMatches: "No matches. Try other words or a symbol name.",
  noMentions: (name) => `Nothing mentions ${name}.`,
  noChanges: "No changes against HEAD.",
  changedHeading: "Changed:",
  checkHeading: "Check:",
  moreChanged: (count) => `  … ${count} more changed files`,
  shortList: (names, shown) => names.slice(0, shown).join(", ") + (names.length > shown ? `, +${names.length - shown}` : ""),
  impactReason: (cochange, mentions, isTest, shown, single) =>
    [isTest ? "test" : "", cochange ? `changed ${single ? "together" : `with ${cochange.file}`} in ${cochange.commits} commits` : "", mentions.length ? `mentions ${messages.shortList(mentions, shown)}` : ""].filter(Boolean).join("; "),
  refsDefinition: (definition) => `${definition.kind} ${definition.name} at ${definition.file}:${definition.line}`,
  refsFile: (file, lines, more) => `${file}: ${lines.join(", ")}${more ? ` (+${more})` : ""}`,
  moreFiles: (count) => `… ${count} more files; narrow with a path`,
  noMatchingCommits: "No matching commits.",
  truncated: "… truncated: narrow the query or lower -n\n",
  shortSha,
  brief: {
    heading: (head, fileCount, areaCount) => `# Context at ${shortSha(head)}: ${fileCount} files, ${areaCount} areas`,
    areasHeading: "## Areas by centrality (top files: key symbols)",
    recentHeading: "## Recent commits",
    moreAreas: (count) => `- … ${count} more areas; use find`,
  },
  changesWith: (list) => `Changes with: ${list}`,
  fileHistoryFallback: "lines differ from HEAD or git could not follow them; showing the file's commits",
  reasons: {
    defines: (name, line) => `defines ${name}:${line}`,
    definesList: (list) => "defines " + list,
    closestTo: (name) => `closest to ${name}`,
    near: (reason, note) => `${reason} (${note})`,
    pathMatches: "path matches",
    matchesText: "matches text",
    matchesTextAt: (line) => `matches text:${line}`,
  },
});
