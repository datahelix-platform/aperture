# ADR-0030: Frontend stack for the MVP SPA (React + Vite + urql; TanStack Table + nuqs)

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** labadorf, design session
- **Related:** ADR-0014 (client-side SPA), ADR-0016 (Bridge = BFF, deferred), ADR-0017 (Layer-D adapter), ADR-0002 (generic over any endpoint), ADR-0029 (capability-gated); `library-survey.md`; `portal-requirements.md` N5.9

## Context

ADR-0014 ratified the MVP as a **client-side SPA** talking to the active endpoint's GraphQL
directly (Hippo now), with Bridge as the deferred BFF (ADR-0016). The repo today is **Python**
(`src/aperture/` — the `MosaicBackend` protocol + config, carried from the CLI era), but the SPA is
a TypeScript app. `library-survey.md` evaluated the component libraries and flagged the concrete
framework/client selection as warranting its own ADR. This ADR locks the stack so the walking
skeleton can begin.

## Decision

The MVP frontend is a **TypeScript single-page app, in this repo**, under a top-level `web/`
package, that talks to Hippo's GraphQL **directly** via the Layer-D capability-negotiated adapter
(ADR-0017). Stack:

- **Language/build:** TypeScript + **Vite**.
- **Framework:** **React** (ecosystem fit for the surveyed libs; largest assist surface).
- **GraphQL client:** **urql** — lightweight, exchange-based, flexible cache control; the best fit
  for a generic, runtime-introspection-driven adapter over any endpoint (vs. Apollo's heavier,
  more opinionated cache; vs. Relay's schema-coupling, which conflicts with ADR-0002).
- **Data grid:** **TanStack Table** (headless, framework-agnostic) — `library-survey.md`.
- **URL / query-state:** **nuqs** — shareable query state (R3.9) — `library-survey.md`.

The Python `src/aperture/` (`MosaicBackend` protocol + config) is **retained as a separate,
optional Python client** for programmatic/SDK use; it is **not on the SPA's data path** (the SPA
talks to Hippo directly). No Python BFF for MVP — the BFF role is Bridge (ADR-0016, deferred).

## Consequences

- The repo becomes **polyglot**: a Python library (`src/aperture/`) + a TS app (`web/`). CI gains a
  JS pipeline (typecheck, lint, test, build) alongside the existing Python one.
- The **Layer-D adapter is TypeScript** over urql: `__schema` introspection baseline + Hippo
  `hippoSchema`/`hippoEntityType` enrichment, exposing a declared **capability** set the UI gates
  on (ADR-0029).
- The component sandbox (ADR-0011), when built, uses a Web Worker + Comlink **inside** the SPA;
  forms/workflow libs (JSONForms/XState, `library-survey.md`) are write-loop-phase choices, not
  locked here.
- Framework lock-in is bounded: TanStack Table is framework-agnostic; the view-description runtime
  (ADR-0009/0010) keeps render concerns declarative.

## Alternatives considered

- **Apollo Client.** Batteries-included but heavier/more opinionated; more to tame for
  generic-over-any-endpoint. Rejected for MVP; reconsider if urql's cache proves limiting.
- **Solid / Svelte / Vue.** Lighter or ergonomic, but nuqs/JSONForms/RJSF are React-first → more
  custom work for the write loop. Rejected on ecosystem fit.
- **Thin Python BFF reusing `MosaicBackend`.** Adds a service to run and contradicts ADR-0016
  (BFF = Bridge). Rejected; the Python client stays for programmatic use only.
- **Separate frontend repo.** Splits code from the design docs and adds cross-repo overhead.
  Rejected for MVP; revisit if the app and the Python client need independent release cadences.
- **graphql-request + codegen.** Too thin — hand-rolled caching/pagination as the read loop
  grows. Rejected.

> **Note (2026-11-20, platform [ADR-0007](../../../platform/design/decisions/ADR-0007-retire-hippo-data-contract-identifiers.md)):** Mosaic v0.16.0 renamed the GraphQL fields named here: `hippoSchema` / `hippoEntityType` → `mosaicSchema` / `mosaicEntityType` (Q3), and Aperture reads the new names (aperture#35). The decision itself is unchanged.
