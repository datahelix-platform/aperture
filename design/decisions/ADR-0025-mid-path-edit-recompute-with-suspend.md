# ADR-0025: Mid-path edits recompute downstream and suspend-on-invalid (not discard)

- **Status:** Superseded by Reel ADR-0004 (2026-06-22 data-story-engine split)
- **Date:** 2026-06-17
- **Deciders:** labadorf, design session
- **Related:** ADR-0022 (instruction-path model), ADR-0023 (as-of watermark), ADR-0009 (dry-run validation), ADR-0020 (provenance events); `instruction-path-model.md` §6

> **⤳ Superseded — moved to Reel (2026-06-22).** This decision moved to the **Reel** component
> when the AI-native data-story engine was split out of Aperture (boundary: DataHelix platform ADR-0003 —
> `datahelix:platform/design/decisions/ADR-0003-reel-data-story-engine-separate-from-portal.md`,
> whose **Outcome** section records the execution; no separate runbook landed). Its
> canonical home is now **Reel [ADR-0004](https://github.com/datahelix-platform/reel/blob/main/design/decisions/ADR-0004-mid-path-edit-recompute-with-suspend.md)**
> (renumbered from this ADR). Kept here as a tombstone per the never-delete convention — **do not
> edit; edit the Reel ADR.** The body below is the original Aperture text, preserved for history.

## Context

A data story is "rewindable like CAD": the user scrolls back to instruction *k*, changes it, and
continues. Two questions, often conflated under the word "diverge," are actually orthogonal:

- **Topology** — does the story fork? (settled linear-first in ADR-0024)
- **Mid-path edit behavior** — when instruction *k* is edited, what happens to *k+1 … n*?

This ADR settles the second. The naïve options are **discard** downstream (truncate-and-rebuild)
or **recompute** it (replay forward). Discard is lossy — fixing a typo in step 2 of a 6-step
story throws away four turns. Recompute risks nondeterminism *unless* replay is pinned — which it
is, by the as-of watermark (ADR-0023).

## Decision

**On a mid-path edit, recompute downstream against the fixed as-of watermark, and
suspend-and-flag any downstream instruction that no longer validates** (rather than discarding
downstream work). Because replay re-evaluates typed ops as-of T (ADR-0023), recompute is
deterministic. A downstream instruction whose op no longer validates against the changed upstream
State (e.g. it references a slot the new filter removed) is marked **suspended** (CAD-style
"failed to regenerate") for the user to re-prompt — it is **not** silently dropped.

Edits operate at two layers, mirroring the "pull new data" discipline (ADR-0023):
- **Story content** is *mutable by replacement* — the recomputed path becomes the story.
- **Edit history** is **append-only**: a provenance event records the edit ("at 14:03 user
  rewound to step 2 and replaced downstream"), per ADR-0020. Nothing is truly lost (audit log),
  yet the story stays a clean line (content).

## Consequences

- Editing is predictable and non-lossy: downstream turns survive an upstream change when they
  still validate; only genuinely broken steps surface for attention.
- The dry-run validator (ADR-0009) gains a second role beyond apply-time checking: it is the
  **regenerate-time gate** that detects which downstream steps to suspend.
- Content-addressed nodes (ADR-0023) make recompute cheap — only reachable descendants whose hash
  changed re-run.
- **Deferred:** recompute is well-defined on a DAG (re-evaluate the reachable subgraph), but the
  *rewind/scrub UI affordance* is not; deferred with the DAG explorer (ADR-0024).

## Alternatives considered

- **Discard downstream (truncate-and-rebuild).** Simpler, but lossy and hostile to multi-step
  stories. Rejected: with as-of replay, recompute is safe, so there's no reason to throw work
  away.
- **Recompute and silently auto-repair** broken downstream steps (re-elaborate their NL).
  Tempting, but hides correctness changes from the user. Rejected for trust: suspend-and-flag
  keeps the human in the loop on any step that no longer holds.
- **Forbid mid-path edits; only append.** Avoids the question entirely but cripples the "CAD
  rewind" promise. Rejected.

## Notes / open sub-questions

- The narration of a recomputed story (do downstream prose summaries re-generate?) is left to the
  renderer; the model only guarantees the typed ops and artifacts are re-evaluated.
