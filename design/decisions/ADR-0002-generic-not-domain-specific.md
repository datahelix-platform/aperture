# ADR-0002: Aperture is generic against any Hippo deployment, not brain-bank-specific

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** design session (backfilled from handoff §2.1)
- **Related:** handoff §2.1, §10 (invariant), ADR-0003

## Context

Aperture's first deployment is the VA brain bank portal, but Hippo is a generic LinkML
runtime. Building Aperture around brain-bank nouns would couple the portal to one schema and
forfeit reuse across every other Hippo deployment.

## Decision

Aperture is generic against *any* Hippo deployment + LinkML schema + GraphQL endpoint. The
brain bank portal is simply the first and most-tested *instance* of the generic app.

**Invariant:** No brain-bank domain nouns (`Donor`, `Specimen`, `BrainRegion`, etc.) appear
anywhere in Aperture source. Those live only in schema + config. Domain nouns leaking into
source is the signal that the generic abstraction has drifted.

## Consequences

- Everything domain-specific is pushed into the LinkML schema and config (see ADR-0003).
- Aperture binds to Hippo's schema introspection (`hippoSchema`/`hippoEntityType`, GraphQL
  introspection) at runtime rather than to hardcoded types.
- This invariant is a standing review check (handoff §10): grep Aperture source for domain
  nouns on every change.

## Refinement (2026-06-15)

Broadened from "generic against any **Hippo** deployment" to **generic against any GraphQL
endpoint**. Hippo is the first and most-tested data source, not a requirement: Aperture binds
to standard GraphQL `__schema` introspection (baseline) plus optional per-source enrichment
(Hippo's `hippoSchema`/`hippoEntityType`), so Canon/Cappella or a third-party API can be data
sources too. This also splits the GraphQL relationship into a **data plane** (browsed sources)
and a **control plane** (config/state store) — see ADR-0017. The invariant is unchanged and, if
anything, stricter: no source-specific *or* domain-specific nouns in Aperture source.

## Alternatives considered

- **Build the brain-bank portal directly, generalize later.** Faster to first demo, but
  "generalize later" rarely survives shipped domain coupling. Rejected — generality is a
  founding constraint, not a refactor.
- **Stay generic only over Hippo deployments.** Still couples Aperture to one backend's
  introspection surface. Rejected by the 2026-06-15 refinement in favour of any-GraphQL.

> **Note (2026-11-20, platform [ADR-0007](../../../platform/design/decisions/ADR-0007-retire-hippo-data-contract-identifiers.md)):** Mosaic v0.16.0 renamed the GraphQL fields named here: `hippoSchema` / `hippoEntityType` → `mosaicSchema` / `mosaicEntityType` (Q3), and Aperture reads the new names (aperture#35). The decision itself is unchanged.
