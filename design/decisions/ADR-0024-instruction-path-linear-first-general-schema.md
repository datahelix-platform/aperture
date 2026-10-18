# ADR-0024: Instruction-path topology — general schema now, linear-only validator in v1

- **Status:** Superseded by Reel ADR-0003 (2026-06-22 data-story-engine split)
- **Date:** 2026-06-17
- **Deciders:** labadorf, design session
- **Related:** ADR-0022 (instruction-path model), ADR-0009 (dry-run validation), ADR-0021 (defer in-app chat; linear MVP first); `instruction-path-model.md` §4, §7

> **⤳ Superseded — moved to Reel (2026-06-22).** This decision moved to the **Reel** component
> when the AI-native data-story engine was split out of Aperture (boundary: DataHelix platform ADR-0003 —
> `datahelix:platform/design/decisions/ADR-0003-reel-data-story-engine-separate-from-portal.md`,
> whose **Outcome** section records the execution; no separate runbook landed). Its
> canonical home is now **Reel [ADR-0003](https://github.com/datahelix-platform/reel/blob/main/design/decisions/ADR-0003-instruction-path-linear-first-general-schema.md)**
> (renumbered from this ADR). Kept here as a tombstone per the never-delete convention — **do not
> edit; edit the Reel ADR.** The body below is the original Aperture text, preserved for history.

## Context

The instruction-path model (ADR-0022) gives each `Instruction` a reference to its parent
state(s). Topology then falls out of arity: **linear** (≤1 parent, ≤1 child), **tree** (≤1
parent, many children — forking), and **DAG** (many parents — convergence via grain-typed
**set-ops** like union/intersect/difference). The DAG case is genuinely useful: heterogeneous
cohort assembly (e.g. PTSD/MDD cases filtered by one set of criteria, controls by another, then
`union`ed). But trees and DAGs raise hard questions — narrative ambiguity ("which branch is *the*
story?"), rewind/scrub semantics on a DAG, and grain-compatibility of set-op operands — that we
should not solve to ship the keystone MVP, which is a single narrated linear path
(`data-stories.md`, ADR-0021).

The risk is choosing a *data model* that's too narrow now and forces a migration later, or one
that's too permissive now and lets v1 produce stories the v1 UI can't render.

## Decision

**Make the data model general and the validator narrow.** Persist `parents` as a *list* of
state-ids from day one (the schema accommodates linear, tree, and DAG without change). In **v1,
the dry-run validator enforces `len(parents) ≤ 1` and single-child**, so v1 stories are
physically linear while already stored in the general schema.

Lighting up richer topology later is then a **validator relaxation plus adding the `set-op` op
type to the catalog — never a data migration.** Set-ops, when enabled, are **grain-typed**:
operands must be union-compatible (same grain) or be pivoted to a common grain first; the
validator (ADR-0009) rejects ill-typed combinations or offers an auto-pivot.

This sets the build ladder: **(1) linear as-of rewind (v1)** → **(2) constrained cohort-assembly
mode** (set-op convergence only, no freeform branching) → **(3) full DAG story explorer**
(future). Rungs 2–3 are additive UI + validator changes.

## Consequences

- v1 ships the simple, narratable linear story with no exposure to tree/DAG complexity, yet
  every persisted story is forward-compatible — no migration when topology is unlocked.
- The DAG explorer and rewind-on-a-DAG are explicitly **deferred** (`instruction-path-model.md`
  §6, §11): once a node has multiple downstream paths and set-op ancestors, "scrub to a point" is
  no longer well-defined (recompute stays well-defined; the UI affordance does not).
- Establishes "topology is a property of the data, not the engine" as an invariant: the core
  never needs rebuilding to grow into richer modes.

## Alternatives considered

- **Linear-only data model now, generalize later.** Smallest schema today, but forces a real
  migration of stored stories to add `parents`/set-ops. Rejected: the list-of-parents schema is
  nearly free now and avoids the migration.
- **Expose tree/DAG in v1.** Maximizes power but drags in narrative ambiguity, DAG rewind, and
  set-op grain semantics before the keystone is even proven. Rejected as premature (cf. ADR-0021).
- **Allow DAG merges beyond set-ops** (arbitrary join semantics). Unbounded complexity; deferred
  entirely.

## Notes / open sub-questions

- Whether the **cohort-assembly mode (rung 2)** should precede generic branching is left open;
  the heterogeneous-filtering use case is valuable enough that it plausibly jumps the queue.
