# ADR-0023: Data-story reproducibility via one as-of watermark per story-version

- **Status:** Superseded by Reel ADR-0002 (2026-06-22 data-story-engine split)
- **Date:** 2026-06-17
- **Deciders:** labadorf, design session
- **Related:** ADR-0022 (instruction-path model), ADR-0020 (provenance events), ADR-0017 (data plane vs control plane); `instruction-path-model.md` §5; Hippo `docs/data-model.md` (provenance & history, `state_at`)

> **⤳ Superseded — moved to Reel (2026-06-22).** This decision moved to the **Reel** component
> when the AI-native data-story engine was split out of Aperture (boundary: DataHelix platform ADR-0003 —
> `datahelix:platform/design/decisions/ADR-0003-reel-data-story-engine-separate-from-portal.md`,
> whose **Outcome** section records the execution; no separate runbook landed). Its
> canonical home is now **Reel [ADR-0002](https://github.com/datahelix-platform/reel/blob/main/design/decisions/ADR-0002-data-story-reproducibility-as-of-watermark.md)**
> (renumbered from this ADR). Kept here as a tombstone per the never-delete convention — **do not
> edit; edit the Reel ADR.** The body below is the original Aperture text, preserved for history.

## Context

A data story is a narrative artifact people share, revisit, and cite. **It must tell the same
story whenever it is rerun** — a story composed today should reproduce identically next month —
*unless the user explicitly asks to pull in new data*. But the story's instructions query
**live Hippo**, whose graph grows over time (new ingestions, supersessions). Naïve replay
("re-run the queries") would silently change artifacts as data lands, destroying reproducibility
and trust. This is the one way the parametric-CAD analogy breaks: CAD recompute is deterministic;
querying a moving database is not.

Hippo already provides the substrate: no hard deletes; an append-only provenance log with
`state_snapshot` + `previous_state_hash`; per-entity as-of reconstruction (`client.state_at`);
and `schema_version` derived from the provenance log (so the *type system* as-of T is recoverable
too).

## Decision

**A `DataStory` carries exactly one as-of watermark (a timestamp), and every query in the story
resolves against the graph as it stood at that watermark.** Replay re-evaluates the instructions'
typed ops as-of T, so it is deterministic and the story reproduces identically regardless of when
it runs.

**"Pull in new data" is never a silent refresh.** It is an explicit instruction that produces a
**new story-version at a new watermark** (replaying the path against the new T) and is itself a
recorded, rewindable provenance event. One watermark per story-version — a single story never
mixes data from multiple times.

To make recompute-on-edit efficient and to mirror Hippo's own design, **instruction nodes are
content-addressed**: a node's identity is `hash(op, parent-hashes, watermark)`, so editing an
instruction recomputes only reachable descendants whose hash changed; unchanged branches are
reused (the same idea as Hippo's `previous_state_hash`).

## Consequences

- Reproducibility is a property of the data model, not of operator discipline: rewind/replay
  shows *what you saw then*, materialized artifacts are data-version-stamped, and "refresh against
  current data" is an explicit, audited action.
- **Forces State to stay intensional** (ADR-0022): you can only replay-as-of-T if the State is a
  spec re-evaluated against the graph, not a frozen bag of objects.
- **Surfaces a new platform requirement on Hippo (D-4):** graph-level / query-spanning as-of —
  "evaluate this whole subgraph query as the graph stood at T," resolving every entity,
  relationship, and schema version to T, over the transport Aperture uses. Hippo today exposes
  this only **per entity** (`state_at`) and not on the GraphQL surface (equality-filter +
  additive-only). The substrate exists in the provenance log; the query-spanning resolver is a
  build. This extends the `vision.md` invariant to "typed, introspectable, dry-run-validatable,
  provenance-tracked — **and time-travelable**."
- Content-addressing gives free memoized recompute and aligns the instruction graph with the
  provenance graph.

## Alternatives considered

- **Always re-execute against current data on replay.** Simplest to implement; destroys
  reproducibility (the story changes under you). Rejected — this is the failure mode the whole
  ADR exists to prevent.
- **Snapshot the materialized results into the story** (extensional state). Reproducible, but
  stories balloon, can't be re-rooted/replayed, and lose the "re-runnable artifact" property.
  Rejected in favor of intensional state + as-of replay.
- **Per-instruction watermarks.** Would let one story mix data from many times — confusing and
  rarely desired. Rejected: one watermark per story-version; "pull new data" forks a new version.

## Notes / open sub-questions

- Depends on **D-4 (Hippo graph-level as-of query)**, which must be filed as a Hippo spec item;
  this ADR cannot be ratified until that capability is on Hippo's roadmap.
