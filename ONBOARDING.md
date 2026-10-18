# Aperture — Handoff / Start Here

**What it is:** the config-driven **data portal** MVP over a Hippo (LinkML + GraphQL) knowledge
graph — the substrate for an AI-native explorer (`design/vision.md`). Generic over any schema;
domain comes from config, not code (ADR-0002).

**Status (2026-07-06):** design **complete and ratified** (Steps 1–6, 31 ADRs).
**All four MVP build phases are implemented** — the walking skeleton (issues
[#3](https://github.com/datahelix-platform/aperture/issues/3)/[#4](https://github.com/datahelix-platform/aperture/issues/4)/[#5](https://github.com/datahelix-platform/aperture/issues/5)),
the **read loop** ([#6](https://github.com/datahelix-platform/aperture/issues/6)): facets + FTS,
detail with cross-links/pivot/history, CSV+JSON export, query-state ⇄ URL; the **Tier-0
write loop** ([#7](https://github.com/datahelix-platform/aperture/issues/7)): mutation-derived
forms, server-authoritative validation, partial-merge updates, ref-pickers; the **Tier-1
guided workflow** ([#8](https://github.com/datahelix-platform/aperture/issues/8), ADR-0028):
stage → continuous dry-run → whole-set validate → one atomic `ingestBatch` with
client-id-linked intra-batch refs; and the **control plane** ([#9](https://github.com/datahelix-platform/aperture/issues/9),
ADR-0017/N5.4): saved views, cross-browser resumable drafts, and config-as-data (workflows)
as versioned documents on a LinkML-on-Hippo store (co-located by default,
`VITE_HIPPO_CONTROL_PLANE_URL` to split; honest localStorage fallback). Facet
**counts**/sort stay capability-gated off until Hippo X1
([hippo#96](https://github.com/BU-Neuromics/hippo/issues/96)).
**Cross-class queries + graph exploration** (ADR-0035/0037): the **Query builder** (nav →
"Query builder", or "Advanced…" on the facet panel) builds a typed QuerySpec — anchor,
field conditions with introspected operators, and "having ≥1 … where …" relationship
criteria (client-planned semijoin until Mosaic relationship predicates land) — riding the
URL, exportable, and explorable as a Cytoscape **graph view** (client one-hop expansion
until Mosaic `neighbors` lands). Local smoke harness: `web/e2e-smoke.mjs` +
`web/vite.smoke.config.ts` (same-origin `/graphql` dev proxy against a local
`mosaic serve --graphql`).

**Next actions (all tracked as issues, dependency-ordered):**

| # | What | Depends on |
|---|---|---|
| [#15](https://github.com/datahelix-platform/aperture/issues/15) | ⚠️ **Live `hippo serve` integration** — confirm the four assumed GraphQL shapes (the v1.0 gate) | — |
| [#16](https://github.com/datahelix-platform/aperture/issues/16) | Publish the Aperture→Hippo **contract file** (runs in hippo CI; feeds the DataHelix certified-frontier ledger) | #15 |
| [#17](https://github.com/datahelix-platform/aperture/issues/17) | **Control-plane recipe** (the ApertureDocument type as a Hippo recipe) | #15 |
| [#18](https://github.com/datahelix-platform/aperture/issues/18) | **Nav/composition overrides** — derive-all + reorder/relabel/hide as config-as-data (R3.1) | — |
| [#19](https://github.com/datahelix-platform/aperture/issues/19) | **Write-loop completeness** — W4.4 availability/supersede affordances, field clearing, saved-view removal | #15 |
| [#20](https://github.com/datahelix-platform/aperture/issues/20) | **Light up X1-gated capabilities** — sort, facet counts, totalCount, range filters | hippo#96 |
| [#2](https://github.com/datahelix-platform/aperture/issues/2) | Embedded schema editing (post-MVP) | X3a/X3b |

**Confirmed live shapes (#15, hippo 0.10.3)** — one sentence per seam; full detail in the #15
issue comments and the committed introspection capture
(`web/src/data/testing/realIntrospection.json`):

- **Introspection:** baseline `__schema` powers everything; the `hippoSchema` enrichment field is
  advertised (richer enrichment still a later upgrade).
- **Lists:** `books(filters, filterMode, limit!, offset!): BookPage` — `{ items total }` page
  envelopes, not bare lists; singular `book(id: ID!)` detail fields; bare-list `searchBooks(q!)`
  twins attach to their base collection as its search path.
- **Filters:** the generic `[FilterInput!]` (`{field, value}` keyed by LinkML slot name, never the
  camelCase rename) plus a `FilterMode` AND/OR combinator — no per-type filter inputs.
- **Single writes:** `create<T>(data: <T>CreateInput!)` / `update<T>(id, data)`; rejections are
  plain GraphQL `errors` messages (FK/NOT NULL constraint text), so EntityForm's field-attribution
  heuristic stands, extended to route a bare `FOREIGN KEY constraint failed` to reference fields.
- **Batch:** `ingestBatch(entities: [BatchEntityInput!]!, relationships, dryRun)` +
  a `validateBatch` twin — no server-side ref tokens; intra-batch links are client-pre-assigned
  ids (`data.id`); commits are atomic (any constraint violation rolls the whole set back as one
  GraphQL error); dry-run/validate is **permissive** in 0.10.3 (structural echo only — constraint
  checks run at commit), so the runner's continuous whole-set dry-run needed no softening.

Agentic surfaces (ADR-0026) remain deferred post-MVP, unfiled until scoped. The
cross-component integration-testing strategy (certified-frontier ledger, contract tests,
backport workflow) is specified in a handoff to the **DataHelix** monorepo (2026-07-07);
aperture's side of it is #16.

---

## Start here (in order)

1. **`design/INDEX.md`** — the Decision Log (ADR index) + document map. The source of truth.
2. **`design/portal-requirements.md`** — the full requirements record: decisions **L1–L14**, the
   read/write-loop requirements, and the cross-component **X-tracker**.
3. **`design/implementation-plan.md`** — the phased build (0 skeleton → read → write → workflow →
   control plane). Phase 0 is detailed.
4. **`design/decisions/`** — 31 ADRs. Load-bearing for a newcomer: **0026** (portal-first MVP +
   what's deferred), **0027** (read+write portal), **0028** (workflow atomicity ↔ Hippo #84),
   **0029** (capability-gated degradation), **0030** (frontend stack), **0031** (app-shell layout
   library).
5. **`web/README.md`** — how to run the SPA (`cd web && npm install && npm run dev`).

## MVP scope

**In:** read loop (browse/search/detail/cross-link/export) + write loop (schema-derived forms +
one guided multi-step workflow), over a single pluggable Hippo endpoint, client-side SPA, auth as
a no-op pass-through (Bridge deferred), hand-authored components in a Worker sandbox.

**Deferred (tracked):** embedded schema editing ([#2](https://github.com/datahelix-platform/aperture/issues/2));
agentic surfaces + build-time agent-assist (ADR-0026); faceting aggregation/counts (Hippo X1) and
server export (X2) → v1.x.

## Roadmap (GitHub issues, dependency-ordered)

| # | Phase | Depends on |
|---|---|---|
| [#3](https://github.com/datahelix-platform/aperture/issues/3) | 0.1a — App shell: layout registry + slot contract (ADR-0031) | 0.1 (done) |
| [#4](https://github.com/datahelix-platform/aperture/issues/4) | 0.2–0.4 — Layer-D urql adapter + capability negotiation | #3 |
| [#5](https://github.com/datahelix-platform/aperture/issues/5) | 0.5–0.7 — schema-derived collection table + URL state *(completes walking skeleton)* | #3, #4 |
| [#6](https://github.com/datahelix-platform/aperture/issues/6) | 1 — Read loop: facets, FTS, detail, cross-links, export | #5 |
| [#7](https://github.com/datahelix-platform/aperture/issues/7) | 2 — Write loop: Tier 0 generated forms | #6 |
| [#8](https://github.com/datahelix-platform/aperture/issues/8) | 3 — Tier 1 guided workflow (stage → validate → atomic commit) | #7 |
| [#9](https://github.com/datahelix-platform/aperture/issues/9) | 4 — Control plane: saved views, drafts, config-as-data | #6–#8 |

## Cross-component (Hippo) dependencies

- **X4 — batch unit-of-work** (whole-set dry-run + atomic multi-entity write): **✅ delivered** —
  [BU-Neuromics/hippo#84](https://github.com/BU-Neuromics/hippo/issues/84), on Hippo `main`. Powers
  Phase 3 (ADR-0028).
- **X1 — aggregation** (facet counts, `totalCount`, sort, range filters): **open** —
  [BU-Neuromics/hippo#96](https://github.com/BU-Neuromics/hippo/issues/96). Gates facet *counts* in
  Phase 1 (ADR-0029); equality facets + FTS ship without it.
- **X2** (server bulk export), **X3a/X3b** (schema-apply transport + overlay mode): deferred; X3a/X3b
  tracked under [#2](https://github.com/datahelix-platform/aperture/issues/2). See the X-tracker in
  `portal-requirements.md`.

## Repo layout

- `web/` — the **TypeScript SPA** (Vite + React + urql + TanStack Table + nuqs; ADR-0030). Talks to
  Hippo's GraphQL directly. This is the MVP product.
- `src/aperture/` — a **Python** client library (the `MosaicBackend` protocol + config), carried from
  the CLI era. **Not** on the SPA data path; kept for programmatic use.
- `design/` — all design docs + `design-export/` (the Claude Design prototype) + `design-tokens.md`
  (seeded into `web/src/styles/tokens.css`).

## Conventions

- **ADR-first:** every load-bearing decision is an ADR in `design/decisions/`, indexed by
  `design/INDEX.md`. Decisions are never deleted — reversals supersede with a pointer (see ADR-0026's
  deferral pattern). When an ADR imposes a requirement on another component, cross-reference both
  sides (e.g. ADR-0028 ↔ Hippo #84 / `sec5`).
- **Two CI pipelines:** Python (`.github/workflows/tests.yml`) + Web (`.github/workflows/web.yml`,
  typecheck/lint/test/build on `web/**`).
- **Dev branch → `main`** by fast-forward once a unit is complete and green.

## Current state / immediate next action

Design branch and `main` are in sync. Build Phase **0.1a** ([#3](https://github.com/datahelix-platform/aperture/issues/3)):
the `headerNavMain` layout + typed slot contract, translated from `design/design-export/` and styled
from the tokens.
