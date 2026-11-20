import { languages, limits } from "./config.mjs";
import { tokenize } from "./lexer.mjs";

function languageOf(catalog, file, text) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (base.includes(".")) {
    return catalog.extensions[base.slice(base.lastIndexOf(".") + 1).toLowerCase()];
  }
  return catalog.shebangs.find(([pattern]) => pattern.test(text))?.[1];
}

function matchingCloses(tokens, open, close) {
  const closes = new Int32Array(tokens.length).fill(-1), pending = [];
  for (let j = 0; j < tokens.length; j++) {
    if (tokens[j].type !== "punct") {
      continue;
    }
    if (tokens[j].text === open) {
      pending.push(j);
    } else if (tokens[j].text === close && pending.length) {
      closes[pending.pop()] = j;
    }
  }
  return closes;
}

function nextClauseEnds(body, tokens) {
  const ends = new Int32Array(tokens.length + 1).fill(-1);
  for (let j = tokens.length - 1; j >= 0; j--) {
    ends[j] = body.clauseEnds.has(tokens[j].text) ? j : ends[j + 1];
  }
  return ends;
}

function nextTypeStops(body, tokens) {
  const depthBefore = new Int32Array(tokens.length + 1);
  for (let j = 0; j < tokens.length; j++) {
    const change = body.typeNesting[tokens[j].text];
    depthBefore[j + 1] = depthBefore[j] + (change === undefined ? 0 : change);
  }
  const stops = new Int32Array(tokens.length).fill(-1), nearestAtDepth = new Map();
  for (let j = tokens.length - 1; j >= 0; j--) {
    if (body.returnTypeStops.has(tokens[j].text)) {
      nearestAtDepth.set(depthBefore[j], j);
    }
    stops[j] = nearestAtDepth.get(depthBefore[j]) ?? -1;
  }
  return stops;
}

function lazily(build) {
  let value = null;
  return () => (value ??= build());
}

function methodScan(methods, tokens) {
  const { open, close } = methods.parameters;
  return {
    closes: lazily(() => matchingCloses(tokens, open, close)),
    clauseEnds: lazily(() => nextClauseEnds(methods.body, tokens)),
    typeStops: lazily(() => nextTypeStops(methods.body, tokens)),
  };
}

const bodyOpeners = new Map([
  ["block", () => true],
  ["clause", (body, tokens, j, scan) => tokens[scan.clauseEnds()[j + 1]]?.text === body.block],
  ["returnType", (body, tokens, j, scan) => tokens[j + 1 < tokens.length ? scan.typeStops()[j + 1] : -1]?.text === body.block],
]);

function opensMethodBody(methods, tokens, j, scan) {
  const next = tokens[j];
  if (next === undefined) {
    return false;
  }
  const opener = methods.bodyOpeners[next.text];
  return opener !== undefined && bodyOpeners.get(opener)(methods.body, tokens, j, scan);
}

const methodPositions = new Map([
  ["memberStart", (methods, tokens, k) => k === 0 || methods.after.has(tokens[k - 1].text) || tokens[k - 1].line < tokens[k].line],
  [
    "afterType",
    (methods, tokens, k) => {
      const previous = tokens[k - 1];
      return previous !== undefined && (previous.type === "id" ? !methods.notAfterWords.has(previous.text) : methods.afterPunctuation.has(previous.text));
    },
  ],
]);

const implRoleOf = (impl, token) => (token.type === "punct" || !token.raw ? impl.roles[token.text] : undefined);

const implHeaderRules = [
  {
    when: (header, token) => header.impl.genericDepth[token.text] !== undefined,
    then: (header, token) => {
      const change = header.impl.genericDepth[token.text];
      header.depth += change;
      header.locked = header.locked || (change > 0 && header.owner !== null);
    },
  },
  { when: (header) => header.depth !== 0, then: () => {} },
  {
    when: (header, token, role) => role === "headerEnd",
    then: (header) => {
      header.ended = true;
    },
  },
  {
    when: (header, token, role) => role === "traitTarget",
    then: (header) => {
      header.owner = null;
      header.locked = false;
    },
  },
  {
    when: (header, token, role) => token.type === "id" && !header.locked && role !== "modifier",
    then: (header, token) => {
      header.owner = token.text;
    },
  },
  {
    when: (header, token, role) => token.type === "punct" && role !== "pathMark",
    then: (header) => {
      header.locked = header.owner !== null;
    },
  },
];

function implOwner(tokens, k, impl) {
  const header = { impl, depth: 0, owner: null, locked: false, ended: false };
  const end = Math.min(tokens.length, k + 1 + limits.implHeaderTokens);
  for (let j = k + 1; j < end; j++) {
    const token = tokens[j], role = implRoleOf(impl, token);
    implHeaderRules.find((rule) => rule.when(header, token, role))?.then(header, token);
    if (header.ended) {
      return header.owner;
    }
  }
  return end === tokens.length ? header.owner : null;
}

function afterTypeParameters(methods, tokens, at) {
  const angles = methods.typeParameters;
  if (angles === undefined || tokens[at]?.text !== angles.open) {
    return at;
  }
  const end = Math.min(tokens.length, at + limits.typeParameterTokens);
  let depth = 0;
  for (let j = at; j < end; j++) {
    const text = tokens[j].type === "punct" ? tokens[j].text : "";
    depth += text === angles.open ? 1 : text === angles.close ? -1 : 0;
    if (depth === 0) {
      return j + 1;
    }
  }
  return -1;
}

function isFunctionExpression(definition, tokens, k) {
  const expressions = definition.expressions;
  if (expressions === undefined || tokens[k].text !== expressions.keyword) {
    return false;
  }
  const lead = tokens[k - 1]?.text === expressions.modifier ? tokens[k - 2]?.text : tokens[k - 1]?.text;
  return expressions.after.has(lead);
}

function isTypeAlias(definition, tokens, k, at) {
  const followers = definition.aliasFollowers?.[tokens[k].text];
  return followers === undefined || followers.includes(tokens[at + 1]?.text);
}

function indentedDeclarations(definition, tokens, nameAt) {
  const found = [], scopes = [];
  let indent = 0;
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.indent !== undefined) {
      indent = token.indent;
      while (scopes.length && scopes.at(-1).indent >= indent) {
        scopes.pop();
      }
    }
    const kind = token.type === "id" && !token.raw && definition.declares[token.text];
    const name = kind && nameAt(k + 1);
    if (name) {
      found.push({ name, kind, line: tokens[k + 1].line, owner: scopes.at(-1)?.owner ?? null });
      scopes.push({ indent, owner: name });
      k++;
    }
  }
  return found;
}

const blockRoles = new Map([
  ["group", (scope) => {
    scope.nesting++;
  }],
  ["ungroup", (scope) => {
    scope.nesting--;
  }],
  ["open", (scope) => {
    const opens = scope.pending?.nesting === scope.nesting;
    scope.stack.push(opens ? scope.pending.name : scope.stack.at(-1) ?? null);
    scope.pending = opens ? null : scope.pending;
  }],
  ["close", (scope) => {
    scope.stack.pop();
  }],
  ["end", (scope) => {
    if (scope.pending?.nesting === scope.nesting) {
      scope.pending = null;
    }
  }],
]);

function bracedDeclarations(definition, tokens, nameAt) {
  const found = [], scope = { stack: [], pending: null, nesting: 0 };
  const owner = () => scope.stack.at(-1) ?? null;
  const { methods, impl } = definition;
  const scan = methods === undefined ? null : methodScan(methods, tokens);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type === "punct") {
      const role = definition.blocks[token.text];
      if (role !== undefined) {
        blockRoles.get(role)(scope);
      }
      continue;
    }
    const previous = tokens[k - 1]?.text;
    const kind = !token.raw && !definition.notDeclaringAfter.has(previous) && definition.declares[token.text];
    if (kind) {
      let at = k + 1;
      const marker = definition.markerBeforeName?.[token.text];
      if (marker !== undefined && tokens[at]?.text === marker) {
        at++;
      }
      const name = nameAt(at);
      const imported = definition.importedAfter.has(previous) || isFunctionExpression(definition, tokens, k) || !isTypeAlias(definition, tokens, k, at);
      if (name && !imported && !(definition.moduleOnly?.has(token.text) && (scope.stack.length || scope.nesting))) {
        found.push({ name, kind, line: tokens[at].line, owner: owner() });
        scope.pending = definition.containers.has(token.text) ? { name, nesting: scope.nesting } : scope.pending;
        k = at;
      }
      continue;
    }
    if (impl !== undefined && !token.raw && token.text === impl.keyword && !impl.notAfter.has(previous)) {
      const type = implOwner(tokens, k, impl);
      scope.pending = type ? { name: type, nesting: scope.nesting } : scope.pending;
      continue;
    }
    const parametersAt = methods === undefined ? -1 : afterTypeParameters(methods, tokens, k + 1);
    if (parametersAt !== -1 && nameAt(k) && methodPositions.get(methods.position)(methods, tokens, k) && tokens[parametersAt]?.text === methods.parameters.open) {
      const close = scan.closes()[parametersAt];
      const signature = methods.signatureEnd !== undefined && tokens[k - 1]?.type === "id" && tokens[close + 1]?.text === methods.signatureEnd;
      if (close !== -1 && (opensMethodBody(methods, tokens, close + 1, scan) || signature)) {
        found.push({ name: token.text, kind: methods.kind, line: token.line, owner: owner() });
        scope.pending = { name: token.text, nesting: scope.nesting };
      }
    }
  }
  return found;
}

const scopeStrategies = new Map([
  ["indentation", indentedDeclarations],
  ["braces", bracedDeclarations],
]);

function declarations(catalog, definition, tokens) {
  const nameAt = (k) => {
    const token = tokens[k];
    return token?.type === "id" && (token.raw || !definition.keywords.has(token.text)) && token.text !== catalog.placeholderName ? token.text : null;
  };
  return scopeStrategies.get(definition.scopes)(definition, tokens, nameAt);
}

function lineSymbols(format, text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  const lineOf = (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1;
  };
  const found = [...text.matchAll(format.pattern)].map((m) => ({
    name: format.name(m),
    kind: format.kind(m),
    line: lineOf(m.index),
    owner: format.owner?.(m) ?? null,
  }));
  return format.groups ? found.concat(groupedSymbols(format.groups, starts, text)) : found;
}

// One pass over the lines: a line matching `open` starts a grouped declaration
// block (Go's `type (`), each `entry` line inside it declares a name, `close` ends it.
// Lines inside a multi-line literal delimited by `rawQuote` (which cannot contain
// that delimiter, like Go's backtick strings) are text, never structure.
function groupedSymbols(groups, starts, text) {
  const found = [];
  let kind = null;
  let insideLiteral = false;
  for (let i = 0; i < starts.length; i++) {
    const line = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] - 1 : text.length);
    const startsInsideLiteral = insideLiteral;
    if (groups.rawQuote !== undefined && line.split(groups.rawQuote).length % 2 === 0) {
      insideLiteral = !insideLiteral;
    }
    if (startsInsideLiteral) {
      continue;
    }
    if (kind === null) {
      const opened = groups.open.exec(line);
      kind = opened ? groups.kind(opened) : null;
    } else if (groups.close.test(line)) {
      kind = null;
    } else {
      const entry = groups.entry.exec(line);
      if (entry) {
        found.push({ name: entry[1], kind, line: i + 1, owner: null });
      }
    }
  }
  return found;
}

function recognized(catalog, language, text) {
  const format = catalog.lineFormats[language];
  if (format !== undefined) {
    return lineSymbols(format, text);
  }
  const definition = catalog.code[language];
  return declarations(catalog, definition, tokenize(definition.lexical, text));
}

export function symbols(file, text, catalog = languages) {
  const language = languageOf(catalog, file, text);
  if (!language) {
    return [];
  }
  const found = new Map();
  for (const s of recognized(catalog, language, text)) {
    if (!found.has(`${s.line}:${s.name}`)) {
      found.set(`${s.line}:${s.name}`, { ...s, name: s.name.slice(0, limits.symbolNameLength) });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
