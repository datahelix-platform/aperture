# Aperture — Instruction-Path Model → moved to Reel

> **Moved to Reel (2026-06-22).** The instruction-path / data-story model was split out of
> Aperture into the **Reel** component when the AI-native data-story engine became its own
> component (boundary: DataHelix platform ADR-0003 —
> `datahelix:platform/design/decisions/ADR-0003-reel-data-story-engine-separate-from-portal.md`,
> whose **Outcome** section records the execution; no separate runbook landed).
>
> **Canonical home:** Reel `design/instruction-path-model.md` —
> <https://github.com/datahelix-platform/reel/blob/main/design/instruction-path-model.md>

This document formalized *what a data story is* as a data structure — source-tagged typed
instructions reducing to intensional subgraph **states** + materialized **artifacts**, with as-of
reproducibility, list-of-parents topology, and recompute-with-suspend editing. Those decisions
are now **Reel ADR-0001–0004** (renumbered from Aperture ADR-0022–0025).

Aperture, **re-scoped to the rendering portal**, consumes Reel's output via the **View Contract**
(`datahelix:platform/design/view-contract.md`) and no longer owns this model. The local
superseded tombstones remain at
[`decisions/ADR-0022`](./decisions/ADR-0022-data-story-is-an-instruction-path.md) …
[`ADR-0026`](./decisions/ADR-0026-headless-core-thin-shell.md).
