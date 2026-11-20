# findbrief

Locate files, symbols, mentions, history, and change impact using a local Git index.
No server, embeddings, or package-registry dependencies are required.

## Installation and adaptation

Requires Node.js 22.13+ with `node:sqlite` and Git. The queried repository must already have
at least one commit. Copy the entire folder to the project's `.agents/skills/findbrief`,
or install elsewhere and adjust the `C` path in `SKILL.md`.

Run from the repository you want to query. In a workspace of independent repositories,
query each separately; the index does not automatically combine their histories.

**Adapt the skill to the destination project's language, structure, and business context.**
The approach is language agnostic; implemented extractors have specific coverage. They currently
cover Go, Rust, JavaScript/TypeScript, Java, Python, shell, and Markdown. Other languages are
indexed as text and paths, without a promise of symbol extraction. Go assumes gofmt formatting.

Use names and vocabulary found in the code, even when the request uses another language.
Review extensions, file classes, and extractors in `scripts/config.mjs` and `scripts/symbols.mjs`
when the project requires it. Increment `limits.schemaVersion` when extraction changes.

## Commands

With `C` pointing to the installation's `scripts/findbrief.mjs`:

| Command | Result |
| --- | --- |
| `node "$C" brief` | Compact map of areas, central files, and recent history. |
| `node "$C" find <query>` | Relevant files with reasons and lines. |
| `node "$C" refs <Name> [path]` | Definitions and textual mentions of a name. |
| `node "$C" why <path or symbol>` | History and files that tend to change with the target. |
| `node "$C" when <words> [--type fix]` | Historical changes matching the query. |
| `node "$C" impact [path or symbol]` | Files related to the target or current diff. |
| `node "$C" index` | Index statistics. |

`-n N` limits results, `--budget N` limits text output, and `--json` returns full data.
See `SKILL.md` for workflow and result interpretation.

## Local state and limitations

The index lives in `$XDG_CACHE_HOME/findbrief` or `~/.cache/findbrief`; `FINDBRIEF_HOME` overrides
its location. It is a rebuildable cache and must not be included when distributing the skill.

References are textual mentions, not compiler-proven calls. Extractors are heuristic and can
miss or misidentify declarations in particular syntax. Confirm results in code before making
decisions. Binaries and large files are indexed only by path and history according to configured limits.

The index combines text and symbol search with mention and co-change relationships. Initial
weights come from the source projects; evaluate usefulness with destination queries. Historical
benchmark numbers are not carried over as guarantees for other projects.

## Optional hook

`hooks/session-start.mjs` prints `brief` for the directory received as `cwd` in JSON on stdin,
or the current directory if none is provided. Outside a repository or on error, it prints no
map. The package does not register the hook automatically: configure it for your agent using
a valid installed script path. Check that it starts in the correct repository.

## Development

From this catalog root:

```sh
node skills/findbrief/dev/extract.test.mjs
```

The full `node --test skills/findbrief/dev/` suite creates commits in temporary repositories.
Do not run it in a session that forbids commits. `dev/bench.mjs` evaluates ranking using existing
history; `dev/ast-truth.py` requires Python and tree-sitter to compare extraction.
`dev/` is not required at runtime.
