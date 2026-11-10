# ADR-0010: View-description vocabulary is a typed noun-catalog (keystone)

- **Status:** Proposed  — ⛔ **Deferred from MVP** (ADR-0026; decided 2026-11-10) — to be **superseded by the platform View Contract ADR** once `datahelix:platform/design/view-contract.md` is ratified
- **Date:** 2026-06-13 (deferred 2026-11-10, decision pass)
- **Deciders:** labadorf (deferral)
- **Related:** handoff §9.2 (open question Q2), open-questions Q2, ADR-0004, ADR-0009; gates ADR-0011, ADR-0012, ADR-0013

## Context

Components emit a serializable view description (ADR-0009). The vocabulary of that
description is a calibration problem: too thin and components can't express real
visualizations (pressure to allow raw rendering, breaking ADR-0009); too rich and it becomes
the bloated DSL ADR-0004 explicitly rejected.

This is the **keystone** decision. Per `portal-open-questions.md`, resolving it determines
where computation lives, which forces the runtime (ADR-0011), and the agent loop (ADR-0013)
and config layering (ADR-0012) then largely fall out of already-settled invariants.

## Decision (proposed)

Make the vocabulary a **catalog of typed, parameterized view primitives** (table,
faceted-list, key-value detail, line/step, bar, scatter, KM-curve, heatmap, …), each a closed
LinkML type. A view description is then *which primitive + bound data + typed params*.
Bounded yet growable.

**Calibration rule (enforceable against handoff §10):** every addition to the vocabulary is a
**noun** (a chart/layout type), never a **verb** (a transform/expression). Nouns go in the
vocabulary; verbs live in the query/binding layer (Hippo GraphQL) or in a Type-B component.
The escape hatch for a missing primitive is "compose primitives," not "raw render."

## Consequences

- Heavy computation is pushed into Hippo's GraphQL query/binding layer (or a Canon/Cappella
  computed result Aperture binds to), shrinking the Type-B component surface to genuinely
  novel rendering.
- If it holds, "novel views" are mostly "missing primitive + richer query" — i.e. mostly
  Type-A config, not Type-B code.

## Notes / open sub-questions

- **Load-bearing probe (resolve first):** can a survival-curve view stratified by genotype be
  expressed as `KM-curve primitive + a stratification group-by query`, or does it genuinely
  need escape-hatch rendering? Run this against 2–3 concrete target components before
  ratifying. The whole resolution chain (0011→0012→0013) rests on this bet.
- Constraint from Hippo today: GraphQL exposes equality filters + offset pagination only, and
  multivalued slots don't persist in the SQLite adapter — "richer query" stratification may
  be limited until Hippo's CEL-over-GraphQL and linktable support land (sec4 §4.7 limits).

## Deferral note (2026-11-10)

Deferred from MVP by labadorf in the 2026-11-10 decision pass, using the same pattern as
ADR-0013's deferral under ADR-0026. The MVP shipped without a component view vocabulary. The
table, detail, form, workflow (ADR-0033) and graph (ADR-0037) views are built-in portal views,
not catalog primitives.

**Forward pointer:** the typed view vocabulary now belongs to the platform **View Contract**
(`datahelix:platform/design/view-contract.md`), a rendering standard shared across
components. Once that document is ratified as a platform ADR, **this ADR is to be marked
`Superseded by` that platform ADR**. It is not to be ratified here. The survival-curve probe
moved to Reel with the agentic keystone (see `design/INDEX.md`). ADR-0015's composition half
and ADR-0037's catalog promotion are deferred with this ADR.
