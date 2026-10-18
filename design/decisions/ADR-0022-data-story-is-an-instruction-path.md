# ADR-0022: A data story is an instruction path producing typed subgraph states + artifacts

- **Status:** Superseded by Reel ADR-0001 (2026-06-22 data-story-engine split)
- **Date:** 2026-06-17
- **Deciders:** labadorf, design session
- **Related:** ADR-0003 (config-as-LinkML-in-Hippo), ADR-0009 (view-descriptions + headless validation), ADR-0010 (typed noun-catalog, keystone), ADR-0020 (conversations/actions are provenance events), ADR-0002 (generic, no domain nouns); `instruction-path-model.md`; `prefab/data-stories.md`

> **⤳ Superseded — moved to Reel (2026-06-22).** This decision moved to the **Reel** component
> when the AI-native data-story engine was split out of Aperture (boundary: DataHelix platform ADR-0003 —
> `datahelix:platform/design/decisions/ADR-0003-reel-data-story-engine-separate-from-portal.md`,
> whose **Outcome** section records the execution; no separate runbook landed). Its
> canonical home is now **Reel [ADR-0001](https://github.com/datahelix-platform/reel/blob/main/design/decisions/ADR-0001-data-story-is-an-instruction-path.md)**
> (renumbered from this ADR). Kept here as a tombstone per the never-delete convention — **do not
> edit; edit the Reel ADR.** The body below is the original Aperture text, preserved for history.

## Context

The AI-native explorer (`vision.md`) and the keystone MVP (`prefab/data-stories.md`) both
center on a "data story." We surveyed five UI prototypes (conversational notebook, transcript +
live artifact, steerable portal, spatial exploration graph, document/briefing composer) and
found they are not five apps but **five renderers over one underlying object**. Building five
UIs against five ad-hoc state models would be wasteful and would foreclose the richer modes. We
need to name the object precisely, independent of any UI, so the model is built once and
rendered many ways — and so a simple linear UI can ship now without painting us into a corner.

`data-stories.md` already framed it as "a sequence of cohort-states + transforms, narrated," but
left the structure informal: what *is* a transform, what *is* a state, what is the unit of edit?

## Decision

**Aperture models a data story as an *instruction path*: an ordered/linked set of first-class,
source-tagged `Instruction`s that deterministically produces a sequence of `State`s and the
`Artifact`s rendered from them**, per the reduction `state[n] = apply(instruction[n], state[n-1])`.

- **`Instruction`** — a first-class **source-tagged** event (`chat | ui_event | agent | replay`)
  that expands to one or more nested, sequential typed **ops** (think tool calls) drawn from the
  closed catalog (`filter · exists-related-filter · distinct-values · group-by+count ·
  pivot-grain · set-op · render-as-primitive`). A UI event is born as one op; a chat turn is raw
  intent elaborated by the LLM into ops and **dry-run-validated** (ADR-0009) before applying. The
  `Instruction` is the **unit of rewind**; its nested ops are inspectable but not independently
  addressable — to change a turn, edit the prompt and re-elaborate.
- **`State`** — a typed **subgraph specification** (intensional): the predicates/selections that
  *denote* a subgraph of `Entity`/`Relationship` instances per the LinkML schema. A "cohort" is a
  State viewed through a focal lens (focal type + selection); re-rooting/grain-pivot changes the
  lens. State is stored as the spec, **not** the materialized objects.
- **`Artifact`** — the materialization of work (an evaluated subgraph, or a rendered view
  primitive), immutable and provenance-stamped. Transform ops advance the State; render ops bind
  an Artifact to the current State without advancing it.
- **`DataStory`** — the persisted container (instructions + one as-of watermark + artifacts),
  itself a LinkML artifact stored in Hippo (ADR-0003).

The full model lives in [`instruction-path-model.md`](../instruction-path-model.md).

## Consequences

- **One model, many renderers.** Each UI mode is a slice — `(admitted topology) × (admitted
  instruction sources) × (state projection) × (deliverable slice)`. The five prototypes become
  points in this space; we build the substrate once.
- **The instruction path *is* the provenance log** (ADR-0020): chat turns, agent actions, and
  config revisions are already first-class provenance events; the path is that log made
  navigable. A saved story is a serializable, validatable, shareable LinkML artifact for free
  (ADR-0003) — and the "re-runnable declarative artifact" `vision.md` promises is literally
  "replay the path."
- **Obligations:** the op catalog must be closed and typed (couples to ADR-0010); every
  instruction must be dry-run-validatable before apply (ADR-0009); State must stay intensional
  (forces the reproducibility model — ADR-0023).
- **Deferred:** ops over *heterogeneous* entity types within one subgraph (multi-type op
  semantics) are hard and out of scope for v1; the v1 op catalog stays single-focal-type.

## Alternatives considered

- **A bespoke state model per UI prototype.** Five renderers, five models — wasteful, and each
  forecloses the others. Rejected: the prototypes share one object.
- **State = materialized subgraph (extensional).** Simpler to render, but stories balloon and
  lose replayability/reproducibility. Rejected in favor of intensional State + materialized
  Artifacts (ADR-0023).
- **Leave "transform"/"cohort-state" informal** (as in `data-stories.md`). Insufficient to build
  rewind, edit, validation, or topology on. Rejected: this ADR formalizes them.

## Notes / open sub-questions

- This whole chain sits behind the keystone **ADR-0010** probe ("can an LLM reliably drive a
  typed declarative artifact through a validator to a correct change?"). If rung 1 fails, this
  model is moot. Ratify after the probe.
- Multi-type op semantics (§2 of the model doc) remain an open design problem.
