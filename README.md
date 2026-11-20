# Agent Skills

Reusable skills for coding agents: find relevant code, resume work across sessions, simplify
conditionals, organize configuration, and write useful documentation. Adapted from workflows
used in LocalCloud, CRM Channels, and Accounting.

**Adapt each skill to your project and its business context before using it.** Review its paths,
language support, architecture assumptions, contracts, and operational requirements. Success
in a source project does not establish compatibility with another one.

## Skills

| Skill | Use it to |
| --- | --- |
| [findbrief](skills/findbrief/SKILL.md) | Locate files, symbols, mentions, history, and change impact using a local Git index. |
| [taskbrief](skills/taskbrief/SKILL.md) | Share tasks, findings, ownership, and exact next steps across sessions and worktrees. |
| [conditional-smell](skills/conditional-smell/SKILL.md) | Choose guards, case selection, tables, ordered rules, or state transitions that preserve business behavior. |
| [base-config](skills/base-config/SKILL.md) | Address magic strings, magic numbers, hardcoded operational values, and duplicate configuration, errors, or logs. |
| [docs-writing](skills/docs-writing/SKILL.md) | Write direct, factual documentation using the project's language, audience, and conventions. |

Each folder contains its `SKILL.md` instructions and any supporting scripts or documentation.
The five packages are prepared for local review and have not been published.

## Install

Copy the skill folder into your project's skill directory. For example, from this repository:

```sh
mkdir -p /path/to/project/.agents/skills
cp -R skills/docs-writing /path/to/project/.agents/skills/
```

Use the discovery directory supported by your agent. Adjust script paths in the installed
`SKILL.md` when necessary. Copying a folder does not register optional hooks.

`findbrief` and `taskbrief` require Node.js 22.13+ with `node:sqlite`, plus Git for repository
operations. See their guides for setup, storage, commands, and limitations:

- [findbrief guide](skills/findbrief/README.md)
- [taskbrief guide](skills/taskbrief/README.md)

## Adapt to your project

Use existing project instructions and accepted contracts to decide:

- **Language and tools:** supported syntax, symbol extractors, lint rules, and commands.
- **Business rules:** permissions, data isolation, valid transitions, error precedence, and
  effects that must be atomic or idempotent.
- **Operational settings:** configuration sources, precedence, resource budgets, and recovery targets.
- **Documentation:** terminology, audience, tone, and language.

The approach is language agnostic; individual tools have specific coverage. For example,
`findbrief` extracts symbols only for its implemented languages. Extend its extractors when
needed, and confirm search results in the code.

In `base-config`, classify a value before moving it: operational settings belong in configuration,
fixed rules need meaningful constants or types, and domain contracts stay with their owners.
Moving every literal into `config.json` does not resolve hardcoding.

Validate the adapted workflow in an isolated destination environment. Keep caches, task databases,
logs, credentials, and private data outside distributed packages.

## Validation

All five `SKILL.md` files passed format validation. JavaScript syntax and local documentation
links were checked. The runtime scripts for `findbrief` and `taskbrief` retain their source versions.

The focused checks passed 11 symbol-extraction cases and seven task-memory cases. From this
repository root, run them with:

```sh
node skills/findbrief/dev/extract.test.mjs
node skills/taskbrief/dev/taskbrief.test.mjs
```

Some other tests create commits in temporary repositories. Do not run those tests when your
session forbids commits. The taskbrief worktree test is separated into `dev/worktrees.test.mjs`;
its worktree check remains unresolved. Full suites and ranking benchmarks have not been rerun.

## Candidates for later extraction

These workflows remain in the source projects and are not included as packages:

| Candidate | Preparation needed |
| --- | --- |
| `whitebox-review` | Separate reusable review criteria from service contracts, architecture rules, and runners. |
| `blackbox-validation` | Derive scenarios from the destination's public contracts and dependencies. |
| `security-audit` | Resolve review, scanning, and threat-model dependencies; define evidence requirements. |
| `local-agent` | Document and adapt OpenCode, Bash, user systemd, Ponytail, paths, and verification commands. |
| `pipe-validation` | Adapt checks to the destination's actual pipeline, dependencies, rules, and thresholds. |
| JSONata authoring and validation | Verify runtime compatibility and distinguish syntax, variable context, and execution results. |

Accounting's `sfn-schema.cjs` checks selected Serverless plugin options. It does not validate
full state-machine definitions or JSONata expressions, so it is not a complete JSONata linter.
The existing JSONata guide also needs runtime verification before reuse.

`dashboard-ui` remains specific to LocalCloud's embedded dashboard and would need a separate
scope for use elsewhere.

## License

A distribution license and applicable attributions have not been established yet. Define them
before publishing or redistributing these packages.
