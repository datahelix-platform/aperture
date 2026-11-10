# ADR-0013: One API-based agent loop; component source is the only file-based artifact

- **Status:** Superseded by Mosaic ADR-0009 / ADR-0010 and Aperture ADR-0039 (2026-11-10)
- **Date:** 2026-06-13 (superseded 2026-11-10, decision pass)
- **Deciders:** labadorf (supersession)
- **Related:** handoff §9.3 (open question Q3); depends on ADR-0003, ADR-0005; informed by ADR-0006

> **⤳ Superseded (2026-11-10).** The premise, an agent loop that talks to "a running Aperture
> API", no longer holds. **Aperture hosts no agent loop and has no API server.** The SPA talks
> to Mosaic directly (ADR-0014, ADR-0030), and the agent surface lives in Mosaic:
> [Mosaic ADR-0009](https://github.com/datahelix-platform/mosaic/blob/main/design/decisions/ADR-0009-mcp-boundary-capability-manifest-queryspec.md)
> (the MCP boundary over a capability manifest and QuerySpec) and
> [Mosaic ADR-0010](https://github.com/datahelix-platform/mosaic/blob/main/design/decisions/ADR-0010-mcp-outbound-delegation-to-a-planning-service.md)
> (outbound delegation to a planning service, behind a validating relay). Aperture's one
> conversational affordance is a capability-gated panel that hosts no loop (**ADR-0039**).
>
> **Surviving principle, carried forward:** *config travels by API, component code travels by
> version control.* Config (Levels 1 & 2) reaches Mosaic over its API. Component source
> (Level 3) goes through VCS + review + headless validation (ADR-0009) and is then registered.
> Any future agent surface, wherever it is hosted, should keep this rule.
>
> Kept as a record per the never-delete convention. The body below is the original proposal.

## Context

Should "agent points at a local instance" and "agent points at an authenticated remote
endpoint" be the *same* loop (always talk to a running Aperture API) or genuinely different
(local = edit files in a repo; remote = call config-mutation endpoints)? Picking one now
avoids building both.

## Decision (proposed)

**One loop — the agent always talks to a running Aperture/Hippo API.**

- Local = Hippo on localhost, possibly no-op auth; remote = the same API, authenticated. The
  capability-scoped client (ADR-0008) resolves "current viewer" identically in both.
- "Edit files in a repo" would reintroduce a second source of truth that must sync with the
  canonical Hippo instance — exactly the drift ADR-0003/ADR-0005 forbid.
- Matches the kept `backends/` protocol (`MosaicSdkBackend` local / `MosaicRestBackend` remote
  behind one interface) — and should extend to a GraphQL backend.

**One honest carve-out:** Type-B **component source code** is code and wants VCS + review.
Precise rule: *config (Levels 1 & 2) travels by API into Hippo; component source (Level 3)
travels by VCS, passes the three-layer headless validation (ADR-0009), then registers into
Hippo.* This is not two agent loops — it is "config by API, code by VCS+validate+register,"
which the ADR-0006 hot-reload flow already implies.

## Consequences

- Aperture exposes config-mutation + dry-run validate over its API for both local and remote.
- Component authoring tooling targets VCS + the headless validators, then a register step.

## Alternatives considered

- **Two distinct loops (files locally, API remotely).** Doubles the surface and reintroduces
  a config source-of-truth that drifts from Hippo. Rejected.
