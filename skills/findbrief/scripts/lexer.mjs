const sticky = (pattern) => new RegExp(pattern.source, pattern.flags + "y");
const asciiLimit = 128;

function matchEnd(pattern, text, i) {
  pattern.lastIndex = i;
  return pattern.test(text) ? pattern.lastIndex : -1;
}

function quotedEnd(lexer, text, i, quote, singleLine) {
  while (i < text.length && !text.startsWith(quote, i) && !(singleLine && text[i] === lexer.lineBreak)) {
    i += text[i] === lexer.escape ? 2 : 1;
  }
  return Math.min(text.length, i + quote.length);
}

function advanceTo(state, end) {
  const { text, lexer } = state;
  let i = state.i, line = state.line;
  for (; i < end; i++) {
    if (text.charCodeAt(i) === lexer.lineBreakCode) {
      line++;
    }
  }
  state.i = i;
  state.line = line;
}

function lineEnd(state, from) {
  const end = state.text.indexOf(state.lexer.lineBreak, from);
  return end === -1 ? state.text.length : end;
}

function emit(state, type, value, raw = false) {
  const token = { type, text: value, line: state.line, raw };
  if (state.lexer.tracksIndentation && state.fresh && state.nesting === 0) {
    token.indent = state.i - state.lineStart;
  }
  state.fresh = false;
  state.tokens.push(token);
}

function templateSegment(state, templates) {
  const { text, lexer } = state;
  emit(state, "punct", templates.quote);
  let j = state.i;
  while (j < text.length && text[j] !== templates.quote && !text.startsWith(templates.interpolationStart, j)) {
    j += text[j] === lexer.escape ? 2 : 1;
  }
  if (text.startsWith(templates.interpolationStart, j)) {
    state.templates.push(0);
    advanceTo(state, j + templates.interpolationStart.length);
  } else {
    advanceTo(state, j + templates.quote.length);
  }
  emit(state, "punct", templates.quote);
}

const regexAllowedAfter = new Map([
  ["num", () => false],
  ["punct", (regex, previous) => !regex.notAfterPunctuation.has(previous.text)],
  ["id", (regex, previous) => !previous.raw && regex.afterWords.has(previous.text)],
]);

function regexAllowed(regex, previous) {
  return previous === undefined || regexAllowedAfter.get(previous.type)(regex, previous);
}

function characterOrLifetimeEnd(state, quote) {
  const { text, lexer, i } = state;
  if (text[i + 1] === lexer.escape) {
    return quotedEnd(lexer, text, i + 1, quote, true);
  }
  const width = (text.codePointAt(i + 1) ?? 0) > 0xffff ? 2 : 1;
  if (text[i + 1 + width] === quote) {
    return i + 2 + width;
  }
  return Math.max(i + 1, matchEnd(lexer.identifier, text, i + 1));
}

const wordRules = new Map([
  [
    "rawIdentifiers",
    (state, raw, word, end, after) => {
      const nameEnd = word === raw.prefix && after === raw.mark ? matchEnd(state.lexer.identifier, state.text, end + 1) : -1;
      if (nameEnd === -1) {
        return false;
      }
      emit(state, "id", state.text.slice(end + 1, nameEnd), true);
      state.i = nameEnd;
      return true;
    },
  ],
  [
    "rawStrings",
    (state, raw, word, end, after) => {
      if (!raw.prefixes.test(word) || (after !== raw.quote && after !== raw.fence)) {
        return false;
      }
      const { text } = state;
      state.i = end;
      const fence = raw.fenceRun.exec(text.slice(end, end + raw.fenceLookahead))[0];
      const close = text.indexOf(raw.quote + fence, end + fence.length + 1);
      advanceTo(state, close === -1 ? text.length : close + raw.quote.length + fence.length);
      return true;
    },
  ],
  [
    "stringPrefixes",
    (state, prefixes, word, end, after) => {
      if (!prefixes.pattern.test(word) || !prefixes.quotes.has(after)) {
        return false;
      }
      state.i = end;
      return true;
    },
  ],
]);

function lineBreakScanners(lineBreak) {
  const scan = (state) => {
    advanceTo(state, state.i + 1);
    state.fresh = true;
    state.lineStart = state.i;
    return true;
  };
  return [{ triggers: lineBreak, scan }];
}

function whitespaceScanners(whitespace) {
  const scan = (state) => {
    state.i++;
    return true;
  };
  return [{ triggers: whitespace, scan }];
}

function lineContinuationScanners(marker) {
  const scan = (state) => {
    if (!state.text.startsWith(marker, state.i)) {
      return false;
    }
    advanceTo(state, state.i + marker.length);
    return true;
  };
  return [{ triggers: marker[0], scan }];
}

function lineCommentScanners(markers) {
  return markers.map((marker) => {
    const scan = (state) => {
      if (!state.text.startsWith(marker, state.i)) {
        return false;
      }
      state.i = lineEnd(state, state.i);
      return true;
    };
    return { triggers: marker[0], scan };
  });
}

function blockCommentScanners(comment) {
  const scan = (state) => {
    const { text } = state;
    if (!text.startsWith(comment.open, state.i)) {
      return false;
    }
    let depth = 1, j = state.i + comment.open.length;
    while (j < text.length && depth > 0) {
      if (comment.nests && text.startsWith(comment.open, j)) {
        depth++;
        j += comment.open.length;
      } else if (text.startsWith(comment.close, j)) {
        depth--;
        j += comment.close.length;
      } else {
        j++;
      }
    }
    advanceTo(state, j);
    return true;
  };
  return [{ triggers: comment.open[0], scan }];
}

function stringScanners(strings) {
  return strings.map(({ delimiter, multiLine }) => {
    const scan = (state) => {
      if (!state.text.startsWith(delimiter, state.i)) {
        return false;
      }
      advanceTo(state, quotedEnd(state.lexer, state.text, state.i + delimiter.length, delimiter, !multiLine));
      return true;
    };
    return { triggers: delimiter[0], scan };
  });
}

function templateScanners(templates) {
  const start = (state) => {
    state.i += templates.quote.length;
    templateSegment(state, templates);
    return true;
  };
  const resume = (state) => {
    if (state.templates.length === 0 || state.templates.at(-1) !== 0 || !state.text.startsWith(templates.interpolationEnd, state.i)) {
      return false;
    }
    state.templates.pop();
    state.i += templates.interpolationEnd.length;
    templateSegment(state, templates);
    return true;
  };
  return [
    { triggers: templates.quote, scan: start },
    { triggers: templates.interpolationEnd[0], scan: resume },
  ];
}

function regexScanners(regex) {
  const scan = (state) => {
    if (!regexAllowed(regex, state.tokens.at(-1))) {
      return false;
    }
    const { text, lexer } = state;
    let j = state.i + 1, inClass = false;
    while (j < text.length && text[j] !== lexer.lineBreak && (inClass || text[j] !== regex.delimiter)) {
      const classMark = regex.classMarks[text[j]];
      if (classMark !== undefined) {
        inClass = classMark;
      }
      j += text[j] === lexer.escape ? 2 : 1;
    }
    advanceTo(state, j + 1);
    state.i += regex.flags.exec(text.slice(state.i, state.i + regex.flagsLookahead))[0].length;
    return true;
  };
  return [{ triggers: regex.delimiter, scan }];
}

function characterScanners(characters) {
  const scan = (state) => {
    advanceTo(state, characterOrLifetimeEnd(state, characters.quote));
    return true;
  };
  return [{ triggers: characters.quote, scan }];
}

function numberScanners(number) {
  const pattern = sticky(number.pattern);
  const scan = (state) => {
    pattern.lastIndex = state.i;
    const digits = pattern.exec(state.text)[0];
    emit(state, "num", digits);
    state.i += digits.length;
    return true;
  };
  return [{ triggers: number.digits, scan }];
}

function identifierScanners() {
  const scan = (state) => {
    const { text, lexer } = state;
    const end = matchEnd(lexer.identifier, text, state.i);
    if (end === -1) {
      return false;
    }
    const word = text.slice(state.i, end), after = text[end];
    for (const { rule, feature } of lexer.wordRules) {
      if (rule(state, feature, word, end, after)) {
        return true;
      }
    }
    emit(state, "id", word);
    state.i = end;
    return true;
  };
  return [{ triggers: null, scan }];
}

function punctuationScanners(punctuation, definition) {
  const pattern = sticky(punctuation);
  const templateDepth = definition.templates && new Map([[definition.templates.nestedOpen, 1], [definition.templates.interpolationEnd, -1]]);
  const nestingDelta = definition.indentation?.nestingDelta;
  const scan = (state) => {
    pattern.lastIndex = state.i;
    const mark = pattern.exec(state.text)[0];
    if (state.templates.length !== 0) {
      const change = templateDepth.get(mark);
      if (change !== undefined) {
        state.templates[state.templates.length - 1] += change;
      }
    }
    if (nestingDelta !== undefined) {
      const change = nestingDelta[mark];
      state.nesting = Math.max(0, state.nesting + (change === undefined ? 0 : change));
    }
    emit(state, "punct", mark);
    state.i += mark.length;
    return true;
  };
  return [{ triggers: null, scan }];
}

const scannerFactories = new Map([
  ["lineBreak", lineBreakScanners],
  ["whitespace", whitespaceScanners],
  ["lineContinuation", lineContinuationScanners],
  ["lineComments", lineCommentScanners],
  ["blockComment", blockCommentScanners],
  ["strings", stringScanners],
  ["templates", templateScanners],
  ["regex", regexScanners],
  ["charactersOrLifetimes", characterScanners],
  ["number", numberScanners],
  ["identifier", identifierScanners],
  ["punctuation", punctuationScanners],
]);

function compile(definition) {
  const scanners = definition.scanOrder
    .filter((feature) => definition[feature] !== undefined)
    .flatMap((feature) => scannerFactories.get(feature)(definition[feature], definition));
  const triggeredBy = (character) => scanners.filter(({ triggers }) => triggers === null || triggers.includes(character)).map(({ scan }) => scan);
  const ascii = Array.from({ length: asciiLimit }, (_, code) => triggeredBy(String.fromCharCode(code)));
  const wide = new Map();
  for (const { triggers } of scanners) {
    for (const character of triggers ?? "") {
      if (character.charCodeAt(0) >= asciiLimit) {
        wide.set(character, triggeredBy(character));
      }
    }
  }
  return {
    ascii,
    wide,
    anyCharacter: scanners.filter(({ triggers }) => triggers === null).map(({ scan }) => scan),
    identifier: sticky(definition.identifier),
    lineBreak: definition.lineBreak,
    lineBreakCode: definition.lineBreak.charCodeAt(0),
    escape: definition.escape,
    shebang: definition.shebang,
    tracksIndentation: definition.indentation !== undefined,
    wordRules: definition.wordRuleOrder
      .filter((feature) => definition[feature] !== undefined)
      .map((feature) => ({ rule: wordRules.get(feature), feature: definition[feature] })),
  };
}

const compiledLexers = new WeakMap();

function lexerFor(definition) {
  let lexer = compiledLexers.get(definition);
  if (lexer === undefined) {
    lexer = compile(definition);
    compiledLexers.set(definition, lexer);
  }
  return lexer;
}

export function tokenize(definition, text) {
  const lexer = lexerFor(definition);
  const state = { text, lexer, i: 0, line: 1, fresh: true, lineStart: 0, nesting: 0, tokens: [], templates: [] };
  if (lexer.shebang !== undefined && text.startsWith(lexer.shebang)) {
    state.i = lineEnd(state, 0);
  }
  while (state.i < text.length) {
    const code = text.charCodeAt(state.i);
    const scanners = code < asciiLimit ? lexer.ascii[code] : lexer.wide.get(text[state.i]) ?? lexer.anyCharacter;
    for (let s = 0; !scanners[s](state); s++) {}
  }
  return state.tokens;
}
