---
name: findbrief
description: Locate repository files, symbols, mentions, history, and change impact using a deterministic local Git index. Use when orienting in a repository, locating code, or answering where something lives, what a change affects, when it was introduced or fixed, and why it exists. Adapt language extractors and project vocabulary to the destination.
---

# Project context

## Adapt to the project

The approach is language agnostic. Before use, adapt paths, vocabulary, and extractors to the
project and its business context. Current symbol extraction covers Go, JavaScript/TypeScript,
Rust, Java, Python, shell, and Markdown; other languages are indexed as text and paths. This
does not imply symbol support for arbitrary syntax.

Requires Node.js 22.13+ with `node:sqlite` and Git. Run from the root of the Git repository you
want to query. In a workspace with several repositories, query each separately; do not assume
the workspace root has Git history of its own.

Set `C` to this skill's script path: for a repository-local installation,
`C=.agents/skills/findbrief/scripts/findbrief.mjs`; for a shared installation outside it, use an
absolute path. Adjust maintenance commands to the chosen location too.

Each command updates the index from Git before answering. The same query on the same tree
returns the same output regardless of the index's update history.

## Workflow

1. When orienting in a repository, run `node "$C" brief` once, unless the optional hook already
   supplied that map to the session.
2. To locate code, run `node "$C" find <query>` before grep or opening files.
   - Write the query in English using the code's terms (service, operation, type), even when
     the request uses another language or everyday wording.
   - Use exact symbol names or paths when known: they rank first. For a method, use
     `Owner::name`; in Go the owner is the receiver type
     (`func (a *SigningKeyAdmin) Rotate` → `SigningKeyAdmin::Rotate`).
   - Open results in order and stop when you find the target.
   - If none fit, retry once with synonyms or a symbol name, then use grep.
3. To find name usage, run `node "$C" refs <Name> [path]`: it returns definitions and lines
   mentioning the exact name, with code before notes. These are mentions, not proven calls.
4. Before changing a file or symbol whose rationale is unknown, run `node "$C" why <path|Symbol>`.
5. To learn when something was added or fixed, run `node "$C" when <words> [--type fix]`.
6. Before finishing a change, run `node "$C" impact`: it lists files changed against HEAD with
   affected symbols, and files to inspect because they often change together or mention those
   symbols (`test` marks tests). Use `impact <path|Symbol>` before editing a target.
7. Confirm claims in the code: the index locates evidence but does not prove behavior.

## Read `find` results

| Reason | Meaning |
| --- | --- |
| `defines X:N` | Defines symbol `X` at line `N`. |
| `defines X:N (closest to T::Y)` | `T` has no `Y`; `X` is `Y` under another owner. |
| `path matches` | The path matches the query. |
| `matches text:N` | Contains terms without defining them; line `N` has the most matches. |

`find` does not guess incomplete or misspelled names: use the full name or search words.
Files that tend to change together appear in `why` and `impact`, not `find`.

`why` ends with `Changes with:`, listing files to inspect when changing the target. If a symbol's
file has uncommitted changes, `why Symbol` notes this and shows file history instead of line history.

## Options

`-n N` limits results, or files in `refs` (default 10, maximum 100). `--budget N` limits text output
to `N` characters (default 6000, minimum 500). If output ends with `… truncated`, reduce `-n` or
narrow the query. `--json` returns the full result. Any other argument starting with `-` is a usage
error (exit code 2), not part of the query. Paths may be relative to the current directory, start
with `./`, or be absolute within the repository.

## Scope

Indexes tracked files and untracked files Git does not ignore; skips lockfiles, minified files,
and known binary extensions. Other binaries and files above 512 KiB are indexed only by path
and history, without symbols or text. A repository-root `.briefignore` uses `.gitignore` syntax
to exclude more paths; a `!dir/…` rule includes Git-ignored files as notes weighted at half the
code weight. Tests and fixtures also rank slightly below the code they test; changelogs and
release notes receive half weight because they repeat history, which `when` searches.

Extracts symbols from Go, JavaScript/TypeScript, Rust, Java, Python, shell, and Markdown. Go
extraction reads top-level declarations placed at column zero by gofmt (`func`, receiver methods,
`type`, `const`, `var`, including grouped blocks); unformatted code may lose symbols.
The index lives in `$XDG_CACHE_HOME/findbrief` (`~/.cache/findbrief` if the variable is missing
or not absolute), or `FINDBRIEF_HOME` when set. It can be deleted and rebuilt.

## Maintenance

Extractors and extensions are defined in `scripts/config.mjs` and `scripts/symbols.mjs`.
When extraction changes, increment `limits.schemaVersion` to rebuild the index. Ranking weights
are initial values: evaluate them with project queries before tuning.

From this catalog root, `node skills/findbrief/dev/extract.test.mjs` checks extractors without
creating commits. The full `node --test skills/findbrief/dev/` suite creates commits in temporary
repositories: do not run it when session instructions forbid commits. The benchmark is in
`dev/bench.mjs` and needs a repository with history. See [README.md](README.md) for installation,
adaptation, and limitations.
