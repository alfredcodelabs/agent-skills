---
name: base-config
description: Organize configuration, constants, errors, and logs when implementing or reviewing code, avoiding magic strings, magic numbers, hardcoded operational values, and duplicate definitions. Adapt to the project's language, architecture, and business context.
---

# Configuration, constants, errors, and logs

Every value needs a meaning, a source of truth, and an owner. Before moving literals, identify
what they represent and who can change them. Renaming a literal or moving it to JSON does not
prove that hardcoding has been resolved.

## Adapt to the project

Read existing instructions, configuration, contracts, and conventions. Locate how options are
resolved, errors are represented, and logs are emitted. Reuse those mechanisms; do not introduce
another loader, logger, catalog, or shared module when the existing one meets the need.

Adapt examples to the language and business domain. Do not impose a global error class, an
application-wide constants file, or a configuration framework. Keep concepts with their owning
module; share only those with equivalent meaning and behavior.

## Classify before changing

| Value type | Appropriate location |
| --- | --- |
| Timeout, retry, capacity, endpoint, or choice that varies by deployment | Typed operational configuration with bounds and explicit precedence. |
| Fixed protocol rule, unit, or contractual limit | Meaningful constant, enum, or type in the owning module. |
| Domain state, role, event, or code | Canonical contract definition reused by producers and consumers. |
| Account, region, physical name, or address of a deployed resource | Configuration or infrastructure reference, following project conventions. |
| Secret or credential | Existing secrets mechanism, preserving resolution and rotation policies. |
| Obvious local literal without hidden meaning | May remain local; avoid constants that only add indirection. |

Repetition is a signal, not proof of equivalence: equal values may belong to different rules.
A business value used only once may still need a name and an authoritative definition. Do not
invent thresholds or make a fixed rule configurable to silence a linter.

## Operational configuration

- Use `config.json` as the input file when that is the project's chosen convention. Preserve
  another existing format or mechanism if it already satisfies the contract.
- Declare defaults, sources, precedence, and when settings take effect. For a new project, one
  possible baseline is defaults → file → environment → validation → injection. Preserve accepted
  precedence when changing an existing project.
- Validate types, units, ranges, and relationships between options. An explicitly invalid value
  must not silently become a default. Syntactically valid JSON may still be invalid configuration.
- Resolve startup options once and inject them into consumers. Respect any dynamic reload or
  rotation lifecycle; do not freeze credentials or other values that must remain current.
- Avoid scattered environment reads and contradictory defaults. Document whether changing an
  option requires a restart. Keep secrets and sensitive values out of examples and diagnostics.

## Errors and logs

- Preserve structured internal causes and translate them into the public contract at the owning
  boundary. Avoid classifying failures by message text when codes or types are available.
- Reuse an existing error catalog when it is authoritative for the domain. Do not create a JSON
  table merely to centralize fixed contracts; types and exhaustive case selection may fit better.
- When changing contractual codes, statuses, messages, or headers, trace affected consumers,
  retries, queues, and orchestrations. Centralization does not authorize public behavior changes.
- Initialize the shared logger where the project expects it. Log a failure once at its owning
  boundary, with a level, stable code, and request, task, or event correlation.
- Use approved structured fields. Avoid full payloads, secrets, and raw causes that may contain
  sensitive data. Distinguish operational failures from expected denials according to the contract.

## Verification

Review the change and its direct consumers for unexplained literals, duplicate definitions,
embedded operational settings, and discrepancies between configuration and actual usage.
Use existing lint, types, and schemas; text searches produce candidates, not confirmed findings.

Check affected risks: configuration precedence and invalid inputs, error compatibility, log
correlation, and absence of sensitive data. Do not claim that a linter detects all hardcoding
or that syntax validation proves a business contract.

Report moved values and their source of truth, preserved or changed behavior, verification
performed, and unresolved domain decisions. For a review-only request, report findings with
locations and proposed fixes without modifying the application.
