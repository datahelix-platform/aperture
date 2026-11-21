# Aperture — Implementation Plan

**Status:** 🟠 Working plan (2026-06-30). Sequenced build plan for the MVP, grounded in the ADRs
(esp. ADR-0014 SPA, ADR-0017 Layer-D adapter, ADR-0029 capability-gating, ADR-0030 stack) and
`portal-requirements.md` (R3.*/W4.*/N5.*). **Current focus: Phase 0 — the walking skeleton.**

> **Visual target available (2026-07-01):** the Claude Design export
> ([`design-export/`](./design-export/)) is the visual source of truth for the skeleton, and
> [`design-tokens.md`](./design-tokens.md) is the extracted design-system seed for the `web/`
> theme. Phase-0 steps 0.1a / 0.5 implement against these (hand-translated to React + TanStack —
> not converted; self-host fonts, tokenize inline styles — see the export README's "deltas").

## Phasing (overview)

| Phase | Deliverable | Requirements |
|---|---|---|
| **0 — Walking skeleton** *(this plan)* | SPA boots → connects to a Hippo GraphQL endpoint → negotiates capabilities → lists **one** schema-derived collection in a table, with query-state in the URL. Proves the spine. | N5.1/N5.2/N5.9; R3.1/R3.2 (thin slice) |
| 1 — Read loop | Full browse: collections nav, table, **facets + FTS**, detail, cross-links, export | R3.1–R3.10; ADR-0029 |
| 2 — Write loop (Tier 0) | Schema-derived create/edit forms + client pre-validation | W4.1–W4.5; ADR-0027 |
| 3 — Tier 1 workflow | One guided multi-step workflow (staged → validate → atomic commit via Hippo #84) | W4.6–W4.9; ADR-0028 |
| 4 — Control plane | Saved views, drafts, config-as-data persistence (LinkML-on-Mosaic) | ADR-0003/0017; L10 |

Component sandbox (ADR-0011), agentic & schema-editing surfaces are **deferred** (ADR-0026).

---

## Phase 0 — Walking skeleton

**Goal.** The smallest end-to-end vertical slice that exercises the architecture's spine:
**config → Layer-D adapter → capability negotiation → schema-derived render**. When done, a
developer points the app at a running `hippo serve`, the app introspects the schema, lists entity
types, and renders one type's entities in a TanStack table with the collection + page reflected in
the URL. No facets, detail, write, or auth yet.

**Why this slice.** It de-risks the novel bet (`prior-art.md`): runtime schema-introspection →
derived binding, behind the capability protocol — the thing nobody else does — on the smallest
possible surface.

### Steps

- **0.1 — Repo & tooling.** Add a top-level **`web/`** package: Vite + React + TypeScript, ESLint
  + Prettier, Vitest, `npm`/`pnpm` scripts (`dev`/`build`/`test`/`typecheck`/`lint`). Add a CI job
  (typecheck + lint + test + build) alongside the existing Python CI. *(ADR-0030)*
- **0.1a — App shell (layout library).** A **layout registry** + a typed **named-slot contract**
  (`header`, `primaryNav`, `main`, optional `footer`/`inspector`/`aside`); ship **one** hard-coded
  layout `headerNavMain` implementing it. Config "selects" a layout (trivial — one entry) and binds
  content to slots; a slot a layout lacks degrades honestly. The registry seam exists so more
  layouts drop in later without a refactor. *(ADR-0031)*
- **0.2 — Endpoint config.** A single **active endpoint** (L2) resolved from env/config
  (`VITE_GRAPHQL_URL`, mirroring the Python side's `DATAHELIX_*` convention). One config module;
  no multi-source. *(N5.2)*
- **0.3 — GraphQL client + Layer-D adapter.** A urql client; a `MosaicSource` adapter module that:
  (a) runs `__schema` introspection baseline + Mosaic `mosaicSchema`/`mosaicEntityType` enrichment,
  (b) exposes a typed **`Capabilities`** object (facets, FTS, pagination kind, sort, aggregation,
  relationship traversal, batch write — populated from what the endpoint advertises). *(ADR-0017;
  N5.1)*
- **0.4 — Capability seam.** A small `useCapabilities()` surface the UI reads; features check it
  and **degrade honestly** — Phase 0 only needs "offset pagination supported?" but the seam is the
  one ADR-0029 mandates, established here so later features plug in. *(ADR-0029)*
- **0.5 — Schema-derived collection list (the slice).** Query `mosaicSchema` → list entity types
  (rendered in the `primaryNav` slot) → select one → query its entities (offset page) → render a
  **TanStack Table** in the `main` slot whose columns derive from the type's slots (scalar/enum/ref
  renderers minimal). Loading/empty/error states. *(R3.1/R3.2; slots per ADR-0031)*
- **0.6 — Query-state in URL.** `nuqs`-backed state for `{collection, page}` so the view is
  shareable/bookmarkable — the R3.9 precursor, proven on the thin slice. *(R3.9)*
- **0.7 — Capability-scoped client seam (no-op).** Thread the data client through an injection
  point so Bridge can later wrap it; for MVP it's a transparent pass-through. *(ADR-0008/0016; N5.3)*

### Explicitly out of scope (Phase 0)

Facets/FTS, detail view, cross-links, export (→ Phase 1); any write (→ Phase 2/3); component
sandbox; real control-plane store (Phase 4); auth beyond the no-op seam.

### Dependencies & dev setup

- A running **Hippo GraphQL** endpoint (`hippo serve`, graphql extra) for dev + e2e; document the
  one-liner. Confirm CORS / introspection availability against `hippo serve` early (a known risk —
  `prior-art.md` notes introspection is sometimes gated; Mosaic's `mosaicSchema` sidesteps standard
  `__schema` if needed).

### Tests

- **Adapter unit tests** (mock GraphQL): introspection → `Capabilities`; schema → column model.
- **Component test**: table renders rows/columns from a fixture; empty/error states.
- **Capability-gating test**: a feature hidden when its capability is absent (no faking).
- **Smoke e2e** (optional, gated on a dev Hippo): boot → list a seeded type.

### Acceptance criteria

- `cd web && npm run dev`, point at a `hippo serve` URL → app lists entity types, renders one
  type's entities in a table; `{collection, page}` round-trips through the URL.
- The adapter exposes a populated `Capabilities` object; at least one UI affordance is gated on it.
- CI (JS pipeline) green: typecheck, lint, unit tests, build.

### Open questions to resolve during Phase 0

- `web/` vs `app/` dir name; `npm` vs `pnpm`.
- The **slot superset** for the layout contract (ADR-0031): start minimal
  (`header`/`primaryNav`/`main`/`footer`) and grow, vs. enumerate `inspector`/`aside` now. Lean
  minimal; add slots when a layout needs them.
- Exact shape of the `Capabilities` type (enumerate now vs. grow per feature — start minimal).
- Whether to generate TS types from the Hippo schema at build time, or stay fully runtime-derived
  (lean runtime-derived per the novel bet; revisit if DX suffers).
