# ADR-0034: SPA image is deployment-agnostic — endpoint config injected at container start

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** epic implementation (issue #22, DataHelix 1.0 P1.4)
- **Related:** ADR-0017 (endpoint as config), ADR-0029 (honest degradation); DataHelix ADR-0001 (certified frontier)

## Context

The certified-frontier ledger (DataHelix ADR-0001) pins components by **image digest** — one
exact artifact is the evidence a composition was certified against. But Vite bakes `VITE_*`
env vars into the static bundle at build time. If the endpoint URL is baked, every deployment
(and the certification stack itself, which points Aperture at a compose-network hostname)
needs its own image — and a digest-pinned image can't be retargeted at all. Issue #22 posed
the fork: documented build-args, or runtime injection into `dist/`.

## Decision

Aperture publishes **one deployment-agnostic image** per release. The nginx entrypoint
(`web/docker/40-aperture-config.sh`) writes recognized `VITE_*` env vars into `config.js` at
container start; `index.html` loads it before the bundle and `src/config/runtime.ts` overlays
it on `import.meta.env` (runtime wins). Dev and plain static hosting serve a no-op
`public/config.js`. The runtime vocabulary is the same `VITE_*` names as build time — one set
of names, two arrival times.

## Consequences

- `ghcr.io/bu-neuromics/aperture@sha256:…` is a single certifiable artifact; the certify
  compose configures it with plain container env (`VITE_HIPPO_GRAPHQL_URL`), as its comments
  already assumed.
- Every env read must go through `runtimeEnv()` — a new `VITE_*` read site that defaults to
  bare `import.meta.env` silently ignores runtime config. (Current sites: endpoint,
  control-plane URL, workflows, nav.)
- `config.js` must never be cached (`Cache-Control: no-store` in the nginx config), or a
  retargeted container serves a stale endpoint.

## Alternatives considered

- **Bake `VITE_HIPPO_GRAPHQL_URL` at build (documented build-args):** rejected — couples the
  artifact to one deployment, multiplies images per environment, and breaks the
  digest-pinning model (a retarget forces a rebuild, which changes the digest and voids the
  certification).
- **Server-side templating of `index.html`:** rejected — same effect as `config.js` but
  mutates the HTML shell, which is harder to reason about with hashed-asset caching.

> **Note (2026-11-20, platform [ADR-0007](../../../platform/design/decisions/ADR-0007-retire-hippo-data-contract-identifiers.md)):** The env vars named here are renamed `VITE_HIPPO_GRAPHQL_URL` / `VITE_HIPPO_CONTROL_PLANE_URL` → `VITE_GRAPHQL_URL` / `VITE_CONTROL_PLANE_URL` (Q5; aperture#35). The old names are not read. The decision itself is unchanged.
