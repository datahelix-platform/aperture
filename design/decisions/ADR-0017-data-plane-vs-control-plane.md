# ADR-0017: Separate data plane (browsed sources) from control plane (config/state store)

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** labadorf, design session
- **Related:** ADR-0002 (generic over any GraphQL endpoint), ADR-0003 (config-in-Hippo), ADR-0013; platform `sec6_security_model.md`

## Context

Reframing Aperture as "a generic front end that can interface with any GraphQL endpoint" (and
possibly several — Hippo now, Canon/Cappella later) surfaced a conflation: Aperture deals with
GraphQL in two unrelated roles, and treating them as one muddied the architecture.

## Decision

Aperture distinguishes two planes:

- **Data plane** — the endpoint(s) Aperture *browses*. Generic, introspection-driven,
  potentially **many** heterogeneous sources. Aperture assumes nothing source-specific in the
  render path. Hippo is the first data source; Canon/Cappella may follow.
- **Control plane** — where Aperture stores *its own* config + user state (ADR-0003). **One**
  designated store. The reference implementation is LinkML-on-Hippo, but this is a
  *config-store port*, not a hard dependency on the data plane being Hippo.

Consequence of the split: **Hippo can be the control-plane store even when the data plane
points at Canon/Cappella or a third-party GraphQL API.** ADR-0003 therefore reads as "the
config-store port has a reference implementation in LinkML-on-Hippo," not "Aperture requires
Hippo."

## Amendment (2026-06-30 — MVP narrowing, `portal-requirements.md` L2 / N5.4)

- **One active data-plane endpoint at a time (L2).** The data plane stays *source-agnostic and
  capability-negotiated*, but the MVP talks to exactly **one** active endpoint at a time
  (Hippo now; swapping to Bridge or a future Cappella gateway is a **config change, not a
  refactor**). Cross-source **federation is deferred** and, if ever needed, is a gateway (Bridge)
  concern, not Aperture's — this narrows the "potentially many heterogeneous sources" framing
  below to "one swappable source" for the MVP without changing the plane split.
- **Control plane co-located for MVP (N5.4).** The MVP runs the control-plane store on **a Hippo**
  (may be the same instance as the data plane). The port abstraction is unchanged; co-location is
  a deployment stance, reversible.

## Consequences

- The data-access layer must be a capability-negotiated source adapter (see `architecture.md`
  layer D): generic `__schema` introspection baseline + per-source enrichment (Hippo's
  `hippoSchema`/`hippoEntityType`; a Canon/Cappella adapter later).
- Multi-source aggregation/federation, if needed, is a data-plane concern handled at the
  gateway (Bridge), not in Aperture (platform sec6 §6.6).
- Keeps ADR-0002's "generic" invariant honest: no source-specific (or domain-specific) nouns
  leak into Aperture source.

## Alternatives considered

- **One GraphQL relationship (config and data in the same assumed store).** Simpler to write,
  but couples Aperture to Hippo for *data* and prevents pointing the data plane elsewhere.
  Rejected — it defeats the generic-over-any-endpoint reframe.

> **Note (2026-11-20, platform [ADR-0007](../../../platform/design/decisions/ADR-0007-retire-hippo-data-contract-identifiers.md)):** Mosaic v0.16.0 renamed the GraphQL fields named here: `hippoSchema` / `hippoEntityType` → `mosaicSchema` / `mosaicEntityType` (Q3), and Aperture reads the new names (aperture#35). The decision itself is unchanged.
