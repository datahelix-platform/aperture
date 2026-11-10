# ADR-0027: Aperture is a read *and* write portal (v1 write boundary)

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** labadorf, design session
- **Related:** ADR-0026 (portal-first MVP), ADR-0028 (workflow atomicity), ADR-0008/0009/0010/0011 (component substrate); `portal-requirements.md` L3/L4, Step 4; Hippo sec9 (validation)

## Context

The original portal framing emphasized browse/search. The requirements track established that
the MVP must also **write**: wet-lab staff need to record what happened at the bench, correctly.
The open question was the write boundary — how much mutation surface ships in v1 without pulling
in runtime-agentic mutation (deferred, ADR-0026).

## Decision

Aperture is a **read and write portal**. It provides **schema-derived data-entry / mutation UIs**,
not just browse. The **v1 write boundary**:

- **Tier 0 — generated single-entity forms.** Create/edit forms derived from a type's LinkML
  slots (the mirror of the detail view); relationship ref-pickers; partial-merge update; no hard
  delete (availability transitions / supersede).
- **Tier 1 — one guided multi-step workflow component** (e.g. tissue banking: register donor →
  accession sample → record processing) as the keystone proof of the component framework.

Further workflow components ship in **v1.x**; **agent-driven runtime mutation is deferred**
(ADR-0026). **Validation authority is server-side** (Hippo's LinkML→CEL→Python pipeline); Aperture
generates entry UI from schema and pre-validates client-side for fast feedback only. Every
mutation is transactional and provenance-tagged by Hippo.

## Consequences

- Re-activates the component substrate for the portal track: typed component contract
  (ADR-0010/0011), no-authority + capability-scoped client (ADR-0008), view-description-not-DOM
  (ADR-0009). The Tier-1 workflow is the first real consumer.
- Forces a workflow-atomicity model for multi-entity writes — recorded separately in ADR-0028.
- Client pre-validation must derive from the same LinkML shape rules; the server `ValidationResult`
  (field-attributed, tier-annotated) is surfaced on rejection.
- MVP components are hand-authored (ADR-0026 / L14); agent-assist is deferred.

## Alternatives considered

- **Read-only portal.** Rejected — fails the wet-lab data-entry need that justifies the portal.
- **Full mutation surface incl. runtime agentic writes in v1.** Rejected — scope; pulls in the
  deferred agent runtime. Tier 0 + one Tier 1 proves the framework without it.
- **Client-side validation as authority.** Rejected — server is the only safe authority; client
  checks are UX sugar (Hippo sec9).

## Amendment (2026-11-10 — Tier 1 shipped without the component substrate)

Recorded by labadorf in the 2026-11-10 decision pass. The first Consequences bullet ("Re-activates
the component substrate … ADR-0010/0011 … The Tier-1 workflow is the first real consumer") did
not hold. The Tier-1 workflow shipped as **steps-as-data interpreted by a pure reducer engine**
(ADR-0033), not as a sandboxed Type-B component, and `implementation-plan.md` defers the
component sandbox. **ADR-0010 and ADR-0011 are Deferred from MVP** (ADR-0026 amendment). The
write-boundary decision itself (Tier 0 forms + one Tier 1 workflow, server-side validation
authority) is unchanged.
