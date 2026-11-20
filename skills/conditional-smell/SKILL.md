---
name: conditional-smell
description: Detect and simplify hard-to-maintain conditionals when writing, refactoring, or reviewing code in any language. Use when case chains, nesting, validations, or state transitions grow; choose a structure that preserves behavior and business rules.
---

# Conditionals and decision structure

Before adding a branch, identify the decision the code expresses and what requires its ordering.
Aim for a structure that is easy to understand and change while preserving the contract.

## Adapt to the language and business domain

Read project instructions, affected code, and the operation's contract. Adapt proposed structures
to the language's capabilities and conventions. Establish which business rules determine
precedence, valid states, permissions, errors, and defaults.

Use existing lint tools and thresholds, if any. Do not impose a universal value or add dependencies
or configuration to apply this skill. Metrics identify places to investigate; a lower number alone
does not prove that the result is clearer or correct.

## Signals to inspect

- Several branches compare the same key and grow with every new case.
- Nested preconditions hide the main flow.
- The same decision is repeated and must be changed in multiple places.
- States, events, or ordered rules are scattered across branches.
- A fallback conflates missing data with a valid value or silently accepts unknown inputs.

A signal warrants inspection, not automatic refactoring. Two simple cases usually fit a
conditional. Keep the existing structure if changing it makes comprehension harder or does
not improve the observed problem.

## Choose a structure

Start with guards or early returns when all you need is flatter preconditions. Preserve validation
order and resource cleanup that previously depended on nesting.

| Decision shape | Possible structure |
| --- | --- |
| Equality over known cases | Native case selection (`match`, `switch`, or equivalent). |
| Mapping keys to values or handlers | Table or map; check how missing keys are represented. |
| First matching rule wins | Ordered list of predicates or validators. |
| Ranges | Range cases or ordered bounds; check endpoints and gaps. |
| Combination of fields | Patterns over multiple values or a composite key, where supported. |
| State and event determine the next state | Explicit transitions; forbidden transitions retain the contractual error. |
| Type-specific behavior repeated in multiple places | Type methods or the existing polymorphism mechanism. |
| Route or prefix hierarchy | Segment matching; use a tree only if the hierarchy warrants it. |
| Dependency-driven ordering | Graph with cycle detection and valid ordering. |
| Configurable rules represented as data | Rule model and bounded evaluator, if the product needs that variability. |

Choose the simplest alternative that preserves the decision. Do not introduce a rule engine,
graph, or type hierarchy to replace a few fixed branches.

## Preserve the contract

- Trace callers before changing a shared decision. Check whether ordering affects errors,
  permissions, side effects, short-circuiting, or evaluation cost.
- Distinguish precedence from exhaustiveness. An unordered table cannot replace first-match
  rules. A map does not guarantee coverage of every domain value either.
- Use language-level exhaustiveness checks where available. Otherwise, if case coverage is a
  relevant guarantee, verify it with contract tests.
- Handle missing, null, zero, false, and empty strings according to the domain and language
  semantics. An unknown key receives a default only when the contract allows it.
- Convert external inputs to domain types at the boundary when that simplifies the logic;
  preserve compatibility, normalization, and expected errors.

## Verify and deliver

Run relevant tests and existing lint where appropriate. For a changed decision, check valid,
unknown, and boundary cases; include overlaps for ordered rules and invalid transitions for states.
Reuse tests that already demonstrate these guarantees.

Explain which decision was simplified, which business rule constrained the structure, and what
evidence shows that behavior was preserved. For a review-only request, report the finding and
proposal without changing code.
