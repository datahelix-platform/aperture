# ADR-0012: Config layering resolves to one canonical validated instance

- **Status:** Accepted (as built, amended to the shipped rule — see the 2026-11-10 amendment; layer attribution + resolved-output validation deferred with the agent loop)
- **Date:** 2026-06-13 (ratified 2026-11-10, decision pass)
- **Deciders:** labadorf
- **Related:** handoff §9.4 (open question Q4); depends on ADR-0003, ADR-0005, ADR-0007

## Context

Is Aperture config a single document per deployment, or layered (base defaults →
schema-derived → admin overrides → user-accessible subset)? Layering is more powerful but
each layer is a place bugs hide. ADR-0003 already commits to deployment-config vs user-state
as *distinct* LinkML classes, so single-document is effectively off the table.

## Decision (proposed — amended at ratification, see below)

**Layered authoring resolving to one canonical validated instance**, using the layers the
design already implies (not a new four-tier invention):

1. **Schema-derived defaults** — *derived, not stored* (regenerated from the LinkML schema
   per ADR-0005). A derived layer can't drift, so it isn't "a place bugs hide."
2. **Deployment/admin config** — stored, versioned, provenance-tagged (ADR-0003).
3. **User state** — high-churn, scoped to the viewer (ADR-0003).

Neutralize the "layers hide bugs" risk with two mechanisms already needed for the agent loop
(handoff §6):
- **(a) layer-attributed resolution** — `describe`/introspect returns the resolved value
  *and which layer produced it*;
- **(b) validate-the-resolved-output** — the dry-run validator runs against the *resolved*
  instance, catching bad layer combinations before apply.

**Drop the proposed 4th layer** ("user-accessible subset") *as a layer*: per ADR-0007 that's
pure ACL/visibility over layers 2–3, not config precedence.

## Consequences

- Requires the "describe my config" introspection capability (handoff §6) to be
  layer-attributed from day one.
- The dry-run validator must operate on resolved output, not per-layer fragments.

## Alternatives considered

- **Single config document.** Off the table given ADR-0003's distinct classes.
- **Four-tier layering with a user-subset precedence layer.** Conflates ACL with precedence;
  rejected per ADR-0007.

## Amendment (2026-11-10 — ratified as the shipped rule)

Ratified by labadorf in the 2026-11-10 decision pass. The decision above was a proposal.
What shipped is narrower, and that is what this ADR now records as binding.

**The shipped rule:**

1. **Per-kind whole-document override with env fallback.** Each deployment config kind is one
   control-plane document, e.g. `config/nav` and `config/workflows`. When present, it replaces
   the env-resolved default (`VITE_NAV`, …) **as a whole document**. There is no field-level
   merge across layers. If the document is absent or the store is unreachable, the env default
   stands. If the document is invalid, Aperture falls back to env and surfaces the error, never
   swallowing it (ADR-0029). Code: `web/src/nav/config.ts` (`resolveNavConfig`,
   `parseNavConfig`) and `web/src/nav/NavConfigContext.tsx`; `workflows/WorkflowsContext.tsx`
   follows the same pattern.
2. **Schema-derived defaults stay derived, not stored.** Derive-all is the base, and config
   only overrides it (ADR-0005).
3. **User state is owner-scoped**, not a precedence layer: `savedView` / `workflowDraft`
   documents carry `owner` + `visibility` (ADR-0032 amendment). Deployment `config` stays
   un-namespaced.
4. **Validation is a hand-written TypeScript parser per kind** (`parseNavConfig` and its
   siblings). It runs on the one document that wins, which under whole-document override *is*
   the resolved instance. There is no LinkML-derived validator yet.

**Deferred**, tied to the deferred agent loop (ADR-0026; ADR-0013 is superseded by Mosaic's agent surface):

- **(a) layer-attributed resolution** ("describe my config" → value + producing layer). With
  whole-document override the producing layer is trivially "control plane or env", so this
  becomes interesting only when an agent edits config.
- **(b) validate-the-resolved-output as a dry-run step** before an agent-driven apply.

The "drop the 4th layer" decision is unchanged: the user-accessible subset is ACL/visibility
(ADR-0007, ADR-0032), not precedence.
