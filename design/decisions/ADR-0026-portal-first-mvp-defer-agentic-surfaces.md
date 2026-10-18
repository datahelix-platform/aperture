# ADR-0026: Portal-first MVP; defer agentic, agent-assist, and schema-editing surfaces

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** labadorf, design session
- **Related:** ADR-0016 (defer Bridge), ADR-0021 (defer in-app chat); ADR-0013, ADR-0018, ADR-0019, ADR-0020, ADR-0022–0025 (deferred from MVP by this ADR); `vision.md`; `portal-requirements.md` L1/L13/L14; [aperture#2](https://github.com/datahelix-platform/aperture/issues/2)

## Context

`vision.md` frames Aperture as an AI-native data & workflow explorer; the config-driven
**portal** is its substrate/MVP, not the product. The portal-requirements track (Steps 1–5)
scoped what the MVP actually ships and what is deferred. This ADR ratifies that scope boundary
so the agentic and authoring ADRs are not mistaken for MVP commitments, and so the substrate
invariants that keep those futures cheap to add are explicitly preserved.

## Decision

Aperture's **MVP is the config-driven portal**: the read loop (browse/search/detail/cross-link/
export) and the write loop (schema-derived forms + one guided multi-step workflow), over a single
pluggable Hippo endpoint. The following are **deferred from the MVP** (designs retained as records,
not built for MVP):

- **Agentic surfaces** — runtime in-app agent/chat, per-user LLM keys, conversations-as-provenance,
  data-stories: **ADR-0013, 0018, 0019, 0020, 0022, 0023, 0024, 0025** are *Deferred from MVP*.
- **Build-time agent-assisted component authoring** — ADR-0021's near-term coding-agent surface
  (with ADR-0018) is *Deferred from MVP*; MVP components are **hand-authored** (L14).
- **Embedded schema editing** — the in-app schema-editor (L5/L11/L12) is *Deferred from MVP*,
  tracked in [aperture#2](https://github.com/datahelix-platform/aperture/issues/2); MVP schema
  authoring happens upstream via Hippo `recipe_import` (L13).

**Substrate invariants are preserved** so each deferred surface is an additive future, not a
rewrite: config-as-LinkML-in-Hippo (ADR-0003/0004), components-hold-no-authority +
capability-scoped client (ADR-0008), view-description-not-DOM (ADR-0009), typed component
contract + Worker sandbox (ADR-0010/0011), dry-run validation (ADR-0006/0009).

## Consequences

- Each deferred ADR carries a "Deferred from MVP — see ADR-0026" note in its Status line; its
  *design* remains Accepted/Proposed as recorded, only its **MVP scope** is deferred.
- MVP component authoring is manual; the runtime/contract substrate (ADR-0010/0011) stays in MVP
  because the Tier-1 workflow (ADR-0027) needs it.
- Reversing any deferral is a status note flip + the relevant Hippo dependency, not a redesign.

## Alternatives considered

- **Mark each deferred ADR `Rejected` / delete.** Wrong — these are sound designs deferred on
  *scope/timing*, not rejected on merit; the convention forbids deleting decisions.
- **Invent a `Deferred` status enum.** Avoided — keeps the platform status vocabulary
  (Proposed/Accepted/Rejected/Superseded) intact; deferral is a scope decision recorded here and
  pointed to, the same pattern as ADR-0016/0021 deferring whole capabilities.
- **Build agentic/schema-editing in MVP.** Rejected — not required for the core data-portal
  value and pulls in heavier dependencies (Bridge, Hippo overlay mode, agent runtime).
