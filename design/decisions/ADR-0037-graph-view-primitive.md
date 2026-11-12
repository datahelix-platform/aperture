# ADR-0037: Graph exploration view (Cytoscape; neighbors-fed with a client fallback)

- **Status:** Accepted (as built — both tiers; server `neighbors` tier added by [aperture#95](https://github.com/datahelix-platform/aperture/issues/95), 2026-11-12)
- **Date:** 2026-08-19 (ratified 2026-11-10, decision pass)
- **Deciders:** labadorf, design session
- **Related:** ADR-0035 (QuerySpec — a result set seeds the graph), ADR-0029
  (visible budgets/caps, honest degradation), ADR-0009/0010 (views are nouns — see the
  catalog note below), ADR-0002 (style/legend derived per class, no domain nouns);
  `design/cross-class-query.md` §8; **Mosaic OpenSpec `heterogeneous-roots`** (mosaic#158
  — the server `neighbors(id, depth, asOf)` this upgrades to); Mosaic ADR-0001 (as-of —
  time-traveling graphs once `neighbors` carries `asOf`).

## Context

Cross-class result sets and provenance neighborhoods are graph-shaped; a table can't show
"what's connected to this cohort" (`cross-class-query.md` §8). Mosaic will serve a
`neighbors(id, depth, asOf)` root (heterogeneous-roots, mosaic#158); until then the only
data source is per-entity reads: an entity's resolved reference fields (forward edges) and
filtered reverse lookups (collections whose reference column targets the entity's type).

## Decision

**Aperture ships a graph exploration view** — seeded from the current QuerySpec's result
set (or the active collection's first page), expanded one hop per node interaction:

- **Runtime: Cytoscape.js** (MIT, active, declarative stylesheets) — the exploration's
  survey pick; sigma.js/WebGL is the named fallback past ~5k nodes.
- **Data source, tiered:** Mosaic `neighbors` when introspection advertises it; until
  then the **client-side one-hop fallback** (detail read for forward edges + filtered
  reverse lookups), exact but slower and first-page-bounded — and the view says so in its
  legend (ADR-0029). Only the data tier changes when the server upgrades, not the view.
- **Honesty at scale:** a visible node budget (250) with an explicit "not shown" note;
  per-class colors with a legend derived from the type names; expansion page caps
  disclosed inline. Never a silently partial graph.
- **Second surface, deliberately:** never required to answer what the table answers;
  reached from the query builder ("Explore as graph") and never the default.

**Catalog note (ADR-0009/0010):** this ships as a *built-in portal view* (like the table
and detail views — portal chrome, not a user-authored component), so it does not run
ahead of the ADR-0010 view-vocabulary keystone. Promoting `graph` into the typed
component/view catalog — a serializable `{nodes, edges, style}` view description checkable
headlessly — is the second step and lands with/after ADR-0010, as the exploration's §8
describes. This ADR covers the built-in view and its data tiers.

## Consequences

- The portal gains its first cross-class *exploration* surface today, against endpoints
  that predate Mosaic's `neighbors` — and upgrades transparently when mosaic#158 lands
  (plus time travel once `asOf` rides along, Mosaic ADR-0001).
- A new runtime dependency (cytoscape, MIT). Bundle weight is real; code-splitting the
  graph view is follow-up hygiene.
- The client fallback's reverse lookups are first-page-bounded per collection — disclosed
  in the view; the server tier lifts this.

## Alternatives considered

- **Wait for server `neighbors`:** gives up the exploration surface the deployment wants
  now; the fallback is honest and already useful at portal scale. Rejected.
- **Canvas "draw the pattern" query builders:** prototypes/niche per the survey
  (`cross-class-query.md` §4); linear builder + graph *results* beats canvas querying.
- **sigma.js first:** better past ~5k nodes but weaker interaction ecosystem; Cytoscape
  is the survey's primary at portal scale. Revisit at scale.

## Notes / open sub-questions

- Promote to a catalog `graph` primitive with a serializable view description once
  ADR-0010 ratifies (the §8 design of record).
- Node-level `asOf` once the server tier lands (time-traveling exploration).
- Code-split the cytoscape chunk.

## Ratification note (2026-11-10)

Ratified by labadorf in the 2026-11-10 decision pass, **as built**. Checked against the code:

- `web/src/query/GraphView.tsx`: a Cytoscape view with a visible `NODE_BUDGET = 250` and a
  "not shown" note when the budget is hit. Per-class colours come from the shared
  `data/typeColor.ts` (ADR-0040), and the legend is derived from the type names.
- Entry point: `query/QueryBuilderView.tsx` "Explore as graph". It is a second surface, never
  the default.
- **Both tiers are built.** When introspection advertises a usable `neighbors(id, depth)`
  root (Mosaic v0.13.0+, `_neighbors_resolver`), each expansion is one `neighbors` call with
  `depth: 1` (`data/neighbors.ts`, capability `neighborsTraversal`); otherwise it is the
  client-side one-hop fallback (detail reads plus first-page reverse lookups). Tier selection
  and both expansions live in `query/graphExpansion.ts`; the legend names the tier in use, and
  the node budget, server `notices` and unresolved-type disclosures surface in both
  ([aperture#95](https://github.com/datahelix-platform/aperture/issues/95)). Node-level `asOf`
  is still not consumed (a later step).

The catalog-promotion step in the Decision's catalog note is waiting on ADR-0010, which is
now **Deferred from MVP** (see that ADR). Until it lands, the graph stays a built-in portal
view.
