# Cross-Class Query & Heterogeneous Results — Design Exploration

**Status:** 🟠 Working — research + candidate design, feeding a Proposed ADR slate (0035+)
**Date:** 2026-08-18 · **Rev 2** (same day): Mosaic is now in scope for changes — the execution
design is co-designed with the Mosaic query surface, priced against Mosaic source
(`datahelix-platform/mosaic` @ `502991c`, v0.12.1) rather than treating the server as fixed.
**Rev 3 note (2026-08-19, status only — exploration text below unchanged):** the Mosaic side of
§10 has landed as design artifacts (mosaic PR #159: doc-drift fixes, **Mosaic ADR-0006/0007**
Proposed — mosaic#153/#154 — and OpenSpec changes `typed-filter-inputs`/`aggregation-and-
ordering`/`search-composition`/`heterogeneous-roots`, mosaic#155–#158). The Aperture side is
promoted to **[ADR-0035](./decisions/ADR-0035-cross-class-queries-typed-queryspec.md)**
(**Accepted** 2026-08-19, aperture#46); the X-tracker entry §10 names "X3" landed as **X5** in
`portal-requirements.md`, since X3a/X3b were already taken by the schema-editing requirements.
**Problem owner:** Aperture (portal query capability, Level-2 binding); instruction-path
composition stays with Reel; server capabilities land in Mosaic via its ADR/OpenSpec process.

---

## 1. Problem

The portal's default surface is a nav list of every derived collection. That is honest but not
useful: the first question a researcher brings is rarely "show me all X" — it is a *criteria*
question that spans classes ("donors over 60 with samples of type X processed after date Y").
Today Aperture cannot express that at all. The gap has three parts:

1. **Query expression.** A user-friendly way to build potentially complex criteria that traverse
   reference edges between classes, driven entirely by the introspected GraphQL schema.
2. **Tabular results + CSV export.** A joined, SQL-like flat table as the workhorse presentation
   and the export format.
3. **Heterogeneous result exploration.** Optionally, a graph view over result sets that mix
   classes, explorable by expanding neighbors.

This doc records (§2) the constraint envelope from our ADRs, (§3) what the endpoint actually
executes today — corrected against Mosaic source, (§4) external prior art, (§5–§6) the QuerySpec
artifact and its UX, (§7) the **Mosaic co-design** — a priced menu of server capabilities and
the one big wire-contract decision, (§8–§9) results presentation and risks, and (§10) the
recommended path and ADR slate on both sides.

## 2. Constraint envelope (what any design must satisfy)

Hard constraints from Accepted ADRs:

- **Derived, never enumerated** (ADR-0002). Every class, edge, operator, and traversal offered
  must come from introspection. No hardcoded join lists, no domain nouns.
- **No middle scripting layer** (ADR-0004). The query cannot be an expression box or a DSL the
  user types. It must be a *closed, typed, declarative artifact* — a noun. ADR-0004 explicitly
  assigns "relationship joins" to Level-2 binding territory, which is where this feature lives.
- **Capability-honest** (ADR-0029). Every operator/traversal/aggregate must map to a declared
  capability and visibly gate off otherwise. Client-side compensation is allowed only at small
  scale, itself behind the gate, never silent.
- **One endpoint** (ADR-0017 amendment). Cross-*class*, never cross-*source*.
- **New views are nouns** (ADR-0009/0010). A graph view enters the primitive catalog as a typed,
  parameterized primitive emitting a serializable, headlessly-validatable view description.
- **Persistence rides the control plane** (ADR-0032). A saved query is a `{kind, name, payload}`
  versioned-envelope document.

Recorded prior decisions to build *with*, not around:

- **ADR-0022** (relocated to Reel ADR-0001) already defines the sanctioned op vocabulary:
  `filter · exists-related-filter · distinct-values · group-by+count · pivot-grain · set-op ·
  render-as-primitive`, over intensional subgraph **states** viewed through a **focal lens**
  (focal type + selection). Heterogeneous multi-type op semantics are its named open problem.
- **ADR-0024** (→ Reel ADR-0003) **rejects arbitrary join semantics**; grain-typed set-ops and
  grain pivots are the sanctioned convergence mechanisms.
- **The Reel boundary.** The instruction-path/data-story engine is Reel's. Per
  `prefab/README.md`: *"the portal's core-loop cohort/query-state remains the foundation Reel's
  stories build on."* Aperture's job is the **single query state** — one anchored, criteria-bound
  subgraph selection — not paths, versions, or story composition.

The vision doc supplies the through-line: push computation into the query/binding layer; keep
the view vocabulary a noun catalog; every artifact typed and dry-run-validatable so an LLM can
drive it (`vision.md:50-62`). A cross-class query artifact is not just compatible with the
AI-native framing — it is the substrate the agentic probe ladder (`vision.md:98-108`, rung 2)
requires. And with Mosaic in scope, the same through-line applies server-side: the *GraphQL
schema itself* should be the query-capability contract, so that "what can I ask here?" is
answerable by introspection alone — by the builder UI and by an agent equally (ADR-0005's
"the schema is the agent's primary context").

## 3. What the endpoint executes — corrected against Mosaic source (v0.12.1)

Aperture's picture of the endpoint comes from a **hippo 0.10.3** introspection capture
(`web/src/data/testing/realIntrospection.json`) plus design-doc claims — and both are stale.
Audit of Mosaic source (`src/mosaic/graphql/`, `src/mosaic/core/`) corrects the record:

**Believed missing but actually shipped:**

| Capability | Reality | Evidence (mosaic repo) |
|---|---|---|
| `in` operator | `FilterInput` has `op: FilterOp = EQ` with `EQ`/`IN` since v0.12.0 (#102) | `graphql/resolvers.py:53-72`; `sqlite_adapter.py:2772-2780` |
| `totalCount` under filter | `Page.total` is a true filtered count already | `schema_builder.py:641`, `query_service.py:270` |
| Multivalued slots persisting | fixed v0.10.0 (#79/ADR-0002); PG parity v0.11.0 | `sqlite_adapter.py:1422-1526`; CHANGELOG v0.10.0 |
| Filter-error honesty | unknown/unfilterable fields raise **coded `GraphQLError`s** (`UNKNOWN_FILTER_FIELD`, `UNFILTERABLE_FIELD`) listing the valid set | `resolvers.py:405-444` (#149) |
| Filtering a to-one edge by its edge name | `resolve_filter_field` accepts slot name, camelCase, or the resolved edge name (`donor` → `donor_id`) | `schema_builder.py:214-235` |

Mosaic's own docs lag the same way (`sec4_api_layer.md:732-734`, `docs/graphql.md:188` still say
"equality only / multivalued slots don't persist"). **First action item regardless of design:
refresh our introspection capture against mosaic ≥ v0.12.1 and fix the stale docs on both
sides.**

**Available and UNUSED by Aperture — free capability:**

- `FilterMode { AND, OR }` — derived (`schemaModel.ts:682-685`) but the client hardcodes `'AND'`
  (`hippoSource.ts:170`).
- `asOf: String` on every list field — zero hits in `web/src`. (Server-side it is list-only:
  not on singular gets, search twins, or nested traversal fields, and the DataLoader cache key
  omits it — Mosaic ADR-0001's §6.8.5 remainder.)
- `findByXref(system, value)` and `relatedTo(id, relationshipType)` — the endpoint's two
  cross-class root fields, both unused.

**Genuinely missing (the real gap, confirmed in source):** comparison operators
(`gt/lt/ne/contains/isNull` **raise** by design — #129 made unsupported ops fail loud,
`core/storage/__init__.py:50-106`), relationship/nested predicates (multivalued refs are
explicitly walled off from filtering, `resolvers.py:435-442`; no EXISTS/join machinery exists in
the SQL builders), facet counts / group-by / min-max on slots, `order_by` (the only ordering is
a hardcoded Python-side `created_at` sort, `query_service.py:268`), search composed with filters
(the twin path is also unranked, N+1, envelope-less, and has an `offset >= limit → []` slice
bug, `resolvers.py:491-499`), and any heterogeneous root (no GraphQL interface/union anywhere;
`Entity` is deliberately excluded from the schema).

Two structural facts that drive all server pricing (§7): **limit/offset are applied in Python,
not SQL** (`query_service.py:184-188` builds the storage `Query` without them — every matching
row is materialized), and the **two adapters diverge physically** (SQLite: per-class tables with
typed columns; Postgres: one JSONB table — every range/sort feature costs a per-type cast on the
PG side, and the repo has a strict parity discipline).

Also load-bearing for the client: Mosaic filters key on LinkML **slot names**, not camelCase
renames (`schemaModel.ts:280-287`) — any query IR must store slot names; and ref selections
currently fetch only the target id (`hippoSource.ts:83-92`), so column traversal needs widened
selection sets regardless of server work.

## 4. Prior art (external survey, 2026-08-18)

Full trail in the survey run for this doc; the distilled findings:

**Filter builders over typed schemas.** The industry atom is *field / operator / value* rows in
shallow AND/OR groups. Airtable and Notion both cap nesting at depth 3 — a deliberate ceiling
worth copying. `react-querybuilder` (MIT, very active) is the strongest React substrate: its
serializable rule-group JSON doubles as an IR, and a custom `ruleGroupProcessor` can emit any
wire format — but it has **no native concept of relationships**; that part is ours to design.
(react-awesome-query-builder is inactive; jQuery QueryBuilder is the wrong substrate.)

**Related-entity conditions.** Two proven idioms, both needed:

- **Implicit traversal in the field picker** (Metabase): related classes' fields appear nested
  under the reference edge (`sample → processing.date`), so single-valued (to-one) hops never
  look like joins. Metabase's open wound: no semi/anti-join in the GUI — exactly the "donors
  *having* samples…" semantics — so users hit a wall.
- **Explicit quantified relationship criteria** (Hasura `_bool_exp` nesting, Directus
  `_some`/`_none`, Airtable conditional rollups, Kibana's nested-document syntax): "having ≥1 /
  exactly 0 [Samples] where […]", with the sub-conditions constrained to hold on the *same*
  related record. This maps 1:1 onto ADR-0022's `exists-related-filter`.

**Cohort builders (the scientist-facing gold standard).** OHDSI Atlas and i2b2 converge on:
pick an anchor population, stack inclusion criteria of the form "having at least N [events]
where [attributes]", express exclusion as "exactly 0 of…" (eliminates a whole class of
confusion), and — the single biggest trust-builder — show **live counts/attrition per
criterion**. Sobering datum: only ~51% of real trial criteria were fully expressible in Atlas
(Nature s41598-023-49560-w) → any structured builder needs a curated escape hatch, not a
scripting one.

**Graph query UIs.** Canvas-style "draw the pattern" builders (TigerGraph, Kineviz, Neo4j Labs
visual-cypher-builder) remain prototypes/niche. What works for non-experts: **Neo4j Bloom's**
schema-token autocomplete over near-natural-language patterns, plus admin-curated
**parameterized saved queries** ("search phrases"); and **Linkurious's** linear block stacks
(node block → edge block → node block). Lesson: linear beats canvas.

**GraphQL-native.** GraphiQL-class explorers solve *field selection* (checkbox trees — steal
for column/export pickers) but leave filters as raw input. Nobody ships a friendly generic
builder over GraphQL filter conventions — genuinely open space. Hasura/Directus define the
state-of-the-art *wire* conventions: per-type `<Type>_bool_exp` input objects, `_and/_or/_not`,
per-scalar operator objects, relationship predicates by nesting the related type's bool_exp
under the edge name (array relationships ≙ `_some`).

**Flat export of one-to-many.** Three shapes seen in the wild: row explosion (Metabase/SQL),
long format with instance columns (REDCap — analysts hate reshaping it; a whole ecosystem of
un-reshaping tools exists), aggregate/rollup columns (Airtable). Strongest synthesis: **anchor
semantics** — one row per anchor entity by default; traversing a to-many path in the column set
forces an explicit per-column choice between *aggregate* (count/concat/min/max) and *explode*
(grain change), with predicted row counts shown. Visible caps beat opaque limits (ADR-0029
already mandates this and `export.ts` implements it).

**Graph visualization libraries.** Shortlist for a React SPA at 100–5k nodes:
**Cytoscape.js** (MIT, best-maintained, richest interactions: expand-collapse, compound nodes,
CSS-like declarative stylesheets that mesh with view-descriptions-not-DOM) as primary;
**sigma.js + graphology** (MIT, WebGL, official React bindings) if result sets grow past ~5k.

**NL-to-query.** The converged pattern (Metabase Metabot → MBQL, Neo4j text2cypher tools):
the LLM emits the *same serializable structure the visual builder edits* — never opaque query
text — validated against the schema, landing in the builder for review and correction. This is
exactly our ADR-0005/0009 posture: one typed artifact, equally accessible to humans and LLMs.

## 5. The QuerySpec noun (unchanged by co-design — that's the point)

The centerpiece is a typed, serializable, introspection-validated query artifact. Working name
**QuerySpec**; in ADR-0022 terms it is an intensional subgraph State restricted to a single
focal lens — the "cohort/query-state foundation" Reel builds on.

```yaml
QuerySpec:
  anchor: <typeName>            # focal type: defines what a result row IS
  asOf: <timestamp>?            # graph-level as-of
  criteria: CriteriaGroup       # what qualifies an anchor entity
  columns: [ColumnSpec]         # what each row shows / exports
  sort: [{path, dir}]?          # gated on server order_by (§7 M2)

CriteriaGroup:
  mode: AND | OR
  items: [FieldCondition | RelatedCondition | CriteriaGroup]   # nesting capped at depth 3

FieldCondition:
  slot: <LinkML slot name>      # never the camelCase rename
  op: eq | neq | in | gt | gte | lt | lte | contains | isNull  # each op capability-gated
  value: <JSON>

RelatedCondition:               # ≙ ADR-0022 exists-related-filter
  edge: <ref | refList field>   # a derived reference edge on the enclosing class
  quantifier: some | none       # "having ≥1 …" / "having exactly 0 …"; count>=N later, gated
  criteria: CriteriaGroup       # conditions holding on the SAME related record

ColumnSpec:
  path: [<edge>…, <slot>]       # anchor slot, or a to-one traversal path
  # to-many paths additionally require ONE of:
  aggregate: count | joinIds | min | max   # keeps anchor grain (default)
  explode: true                            # changes grain — ≙ pivot-grain; must be explicit
```

Why this shape:

- **Closed and typed** — a noun catalog of criteria, not an expression language (ADR-0004).
  Every legal value of `anchor`, `edge`, `slot`, and `op` is enumerable from introspection, so
  a dry-run validator is total (ADR-0005/0009 posture).
- **Anchor semantics answer the export question** before it's asked: a result row is an anchor
  entity; grain changes are explicit `explode` decisions, mirroring ADR-0024's grain-typed
  discipline. No arbitrary joins — traversal is always along schema-derived reference edges.
- **Quantifiers, not joins.** `some`/`none` gives semi/anti-join expressiveness (the thing
  Metabase never shipped and Atlas proves scientists need) without join semantics.
- **LLM-emittable.** An agent emits QuerySpec JSON, the validator gates it, the builder renders
  it for review — the exact Metabot/text2cypher pattern, and rung 2 of the vision's probe
  ladder.
- **One artifact, three transports:** URL (nuqs, shareable), control plane (saved, versioned
  envelope), and agent I/O.
- **Server-independence is the payoff of IR-first design:** the co-design in §7 changes *how*
  a QuerySpec executes (which parts compile to server args vs. gate off), but never the
  artifact. Saved queries, URLs, and NL tooling survive every server upgrade; only the planner
  moves.

## 6. UX — three on-ramps, one artifact

**(a) The facet panel stays** and becomes a *degenerate QuerySpec* (anchor = current collection,
flat AND FieldConditions). No regression; the certification-contract test-ids
(`FacetPanel.tsx:35-37`) are untouched.

**(b) The builder** (progressive disclosure from the facet panel — "Advanced…", the
Notion simple→advanced escalation):

- Anchor picker ("Rows are: Donors") — this replaces "which collection am I in" as the query's
  frame.
- Criteria rows: field/op/value, with the **field picker showing to-one refs' fields nested
  under the edge** (Metabase implicit traversal) — one-hop to-one conditions never look like
  joins. Offered operators per slot are read off the introspected filter input types (§7 M1),
  not a hardcoded table (ADR-0002).
- **Relationship criterion rows** for to-many edges, rendered in the Atlas idiom:
  *"having **at least one** / **no** Samples where …"* with an indented sub-group whose
  conditions hold on the same sample. Sub-groups can nest one more level (cap 3 total).
- **Live counts per criterion** (attrition-style) once facet/count aggregation lands (§7 M2);
  until then the result total is the only number shown — never a client-computed count over a
  partial page (ADR-0029).
- Column/export picker: checkbox tree over anchor slots + traversal paths (the
  GraphiQL-explorer pattern); picking a to-many path prompts the aggregate-vs-explode choice
  inline, with a predicted row count when counts are available.
- **Legible errors:** Mosaic's coded filter errors (`UNKNOWN_FILTER_FIELD` with the valid-field
  list) surface verbatim in the builder — and feed the NL loop below, since an agent can
  self-correct from them.

**(c) NL box + global search** (the "default isn't useful" fix):

- **Global search as the landing surface.** One search box; heterogeneous hits grouped by
  class; each group links into its collection with the search applied; the full hit set can
  seed the graph view (§8). Served by Mosaic `searchAll` when available (§7 M4), degrading to
  client fan-out over the per-class search twins + `findByXref` on older endpoints.
- **NL → QuerySpec.** The agent path: prompt → QuerySpec JSON → dry-run validation against
  introspection → populated builder for review → run. Never generated query text. The
  literate-path prerequisite is that the schema carries its own documentation — see §7 M0:
  LinkML slot/class descriptions must propagate into GraphQL SDL descriptions so both the
  builder's tooltips and the agent's context come from one source (ADR-0005).
- **Curated escape hatch:** parameterized saved QuerySpecs (a saved spec with typed parameter
  slots) — Bloom "search phrases" — covering the tail Atlas's ~51% datum warns about, without
  ever opening a scripting layer.

Shell-wise this is content bound into `main` (+ builder in `inspector`) under the existing
`headerNavMain` layout, or a second registered layout if the builder needs real estate
(ADR-0031 either way).

## 7. Mosaic co-design — the priced capability menu

With Mosaic changeable, the right architecture is **server-first with honest degradation**,
not compensation-first: Aperture's planner compiles QuerySpec to whatever the introspected
surface advertises, and the client-side semijoin machinery from Rev 1 shrinks to a thin
fallback for version-skewed deployments (or is dropped if deployments track Mosaic releases —
capability gating handles skew either way).

The menu below is priced from Mosaic source. Shared context: the operator plumbing already
exists end-to-end for `IN` (enum → `normalize_filter` → both adapters), so extending it is
proven ground; the taxes are (i) Postgres JSONB casts for every typed comparison, (ii) the
Python-side limit/offset (pushdown pays off once and benefits M2 and cursor pagination alike),
and (iii) as-of code paths that must mirror every filter feature (`_matches_filters` exists in
four places).

**M0 — Hygiene & literacy (cheap, do first, mostly docs):**
refresh Aperture's introspection capture to ≥ v0.12.1; fix stale Mosaic docs
(`sec4_api_layer.md:732-734`, `docs/graphql.md:188`, decision-log index drift); verify/ensure
**LinkML `description`/`comments` propagate into GraphQL SDL descriptions** for types, fields,
enums, and the new filter inputs — this is what makes the builder self-documenting and the NL
path literate, per ADR-0005's "schema is the agent's primary context". Aperture side: adopt the
native `in` op, send `filterMode: OR` for OR groups, claim `asOf` on list queries.

**M1 — Typed per-class filter inputs with operators** *(Mosaic: cheap→moderate; the keystone)*:
generate `<Type>Filter` input objects — per-slot operator objects `{eq, neq, in, gt, gte, lt,
lte, contains, isNull}` selected by slot kind/range, plus `and/or/not` — as a `where:` arg
beside (initially) the flat `filters:` arg. Lands at the three existing chokepoints
(`VALID_FILTER_OPS`/`normalize_filter`, the two adapters' clause builders, a new
`_build_filter_input_types` pass copying the `CreateInput` pattern). SQLite's typed per-class
columns make comparisons trivial; the real work is PG JSONB casts driven by the slot's LinkML
range, and mirroring the as-of `_matches_filters`. `isNull` needs a semantics decision (the
read layer already treats null slightly ambiguously).
**Why keystone:** the *introspected input types become the capability contract*. Aperture
derives every operator it offers, per slot, from `__schema` — no capability side-channel, no
hardcoded operator tables (ADR-0002), and ADR-0029's gating reduces to "offer exactly what the
schema advertises." Dry-run validation becomes GraphQL validation itself.

**M2 — Aggregation + order_by, shipped together** *(Mosaic: moderate; ≙ our X1 / hippo#96)*:
`COUNT(*)`-mode queries (cheap `total` — the field exists, it just costs a full scan), facet
value counts (`facetCounts(field, where)` — the `entity_counts()` GROUP BY precedent exists on
both adapters), min/max for range facets, and `order_by` (generated per-type enum). These share
the limit/offset/order pushdown into the storage `Query`, which is why they ship together.
Two recorded traps: the existing `entity_counts()` **includes unavailable entities** while list
queries filter `is_available = 1` — a new aggregation surface must not inherit that
inconsistency; and `createdAt`/`updatedAt` are provenance-derived, not stored, so temporal
sort/filter needs the provenance-summary path, not a column sort.
**Unlocks in Aperture:** live per-criterion attrition counts (the Atlas trust-builder), facet
counts on the existing panel, range facets, predicted explode sizes, honest sort.

**M3 — Search that composes** *(Mosaic: moderate — a small rewrite, not a patch)*:
make search return a page envelope and accept `where:`/`filters:`. Implementation is an id-set
composition: ranked FTS ids (the good bm25 path already exists in the SQLite adapter) fed as an
`id IN (…)` filter into `find()` alongside the user's filters. Fixes three existing defects in
one move: the per-hit N+1, the missing `total` on search twins, and the `offset >= limit → []`
slice bug. Needs one semantics decision: bm25 rank order vs. `order_by` when both are present.
**Unlocks in Aperture:** FTS as just another criterion — search and facets stop being mutually
exclusive.

**M4 — Heterogeneous roots: `searchAll` + `neighbors`** *(Mosaic: cheap→moderate in the
JSON-envelope form)*: both follow the established house pattern (`XrefMatch`, `RelatedEntity` —
`{entityId, entityType, data: JSON, …}` envelopes with typed follow-up via per-type queries).
`searchAll(q, limit)` fans across per-class FTS with merged ranking; `neighbors(id, depth,
asOf) { nodes { entityId entityType data } edges { source target type } }` wraps the existing
depth-bounded BFS `traverse()` — which already has a full as-of variant replaying edge liveness
from provenance. **One sharp hidden cost to design for:** `traverse()` walks the link table
only, so single-valued (column-stored) references are invisible to it — a naive neighbors
endpoint returns an incomplete graph. Union column edges into the traversal, or say so loudly.
Node materialization must batch by type (the DataLoader trick) rather than get-per-node.
**Unlocks in Aperture:** the global-search landing surface in one request, and the graph view's
seed + expand-on-click primitive with time-travel for free.

**M5 — Relationship predicates (`some`/`none` sub-filters on edges)** *(Mosaic: expensive; the
headline capability)*: correlated `EXISTS` against per-class tables (to-one, via the FK column)
and against the `relationships` link table (to-many). This is the one genuinely new code path —
the SQL builders have no join/subquery machinery today, multivalued refs are deliberately
walled off from filtering, and the as-of path declares relationship-existence filters out of
scope (mosaic `sqlite_adapter.py:2674`, hippo#71). Phase it:
- **M5a — to-one nested predicates** (moderate): `where: { donor: { age: { gt: 60 } } }` — a
  single correlated subquery on an FK column, no link table. This alone powers the builder's
  Metabase-style implicit traversal.
- **M5b — to-many quantified predicates** (expensive): `where: { samples: { some: {…} } }` —
  link-table EXISTS, recursive input types (the two-pass cyclic-type trick already exists in
  the schema builder), filter-nesting depth cap (the existing `QueryDepthLimiter` guards output
  nesting, not filter nesting), and an explicit documented hole or restriction for
  `asOf × relationship predicates` until the temporal join is designed.
Until M5 lands, Aperture's planner covers RelatedCondition by **server-assisted semijoin** —
now materially cheaper than Rev 1 assumed, since the native `in` operator (shipped) replaces
the OR-mode hack: query the related class with sub-criteria, collect linking ids, filter the
anchor with one `in`. Capped, visibly gated, honest (`relationshipFilter: 'compensated'` →
`'server'` when M5 introspects).

### The wire-contract decision: typed filter inputs, not CEL

Mosaic's docs name **CEL-over-GraphQL** as the future for richer predicates (REST-side spec
only, Low priority, unimplemented). For the *Aperture-facing GraphQL contract* this exploration
recommends **against** CEL and **for** the typed nested input objects (M1/M5), on constitutional
grounds:

1. **Introspectability.** A `filter: String` CEL arg is opaque — introspection can't tell the
   builder or an agent which predicates the server supports, so ADR-0002's derive-everything
   rule and ADR-0029's capability gating would need a side-channel contract anyway. Typed
   inputs *are* the contract.
2. **ADR-0004.** CEL on the wire is an expression language one temptation away from becoming a
   user-facing scripting layer. Typed inputs are a closed noun vocabulary end to end.
3. **Validation.** Bad typed input fails GraphQL validation with a precise error before
   execution — the dry-run property both ADR-0005 and the NL loop depend on. Bad CEL fails at
   runtime, in a second grammar, with a second error vocabulary.
4. **Pushdown honesty.** Mosaic's own CEL sketch is "translate common patterns to SQL, fall
   back to in-memory" — an invisible performance cliff, which is a capability lie in ADR-0029
   terms. Typed inputs make everything advertised pushdown-able by construction.

CEL keeps its existing Mosaic role (validator conditions), and may serve *internally* as an
adapter IR if Mosaic wishes — the recommendation is only that the **GraphQL contract Aperture
derives from be typed input objects** (the Hasura/Directus-proven shape).

## 8. Results presentation

**Table (workhorse).** Anchor-grain rows in the existing TanStack table; traversal columns
labeled by path ("Sample → Processing date"); to-many columns show the aggregate or, when
exploded, the table states its grain change ("1 row per Donor × Sample — 342 rows from 128
donors"). CSV export reuses the page-through exporter (cap + `truncated`, ADR-0029);
one-row-per-anchor with aggregates is the default export, explode is opt-in per path — the
REDCap lesson (neither pure long nor pure wide satisfies everyone; make it a visible choice).
M2's count pushdown makes predicted explode sizes and honest totals cheap; M3 makes "search
within a cohort" exportable.

**Graph view (new primitive, contingent on ADR-0010).** A `graph` noun in the view catalog:

- **View description, not DOM:** a serializable `{nodes: [{type, id, label}], edges: [{source,
  target, edge}], style: derived-per-class}` document. Node/edge sets, type coverage, and style
  bindings are checkable headlessly (ADR-0009's forcing function holds: correctness is
  set-membership, not pixels).
- **Runtime realization: Cytoscape.js** (MIT, active, compound nodes + expand-collapse
  ecosystem, declarative stylesheets). sigma.js/WebGL is the named fallback past ~5k nodes; the
  view description is renderer-agnostic either way.
- **Data source: Mosaic `neighbors` (M4).** Seed from a QuerySpec result or a `searchAll` hit
  set; expand-on-click = `neighbors(id, depth: 1)`; `asOf` rides along, giving a
  **time-traveling graph explorer** almost for free (the server-side edge replay already
  exists). Fallback on older endpoints: per-entity detail queries, one hop, honestly slower.
- **Honesty at scale:** node budget with visible truncation; cluster-by-class (compound nodes)
  before dropping data; the M4 single-valued-edge gap must be closed server-side or disclosed
  in the legend ("column edges not shown").

This is deliberately the *second* result surface: never required to answer what the table can
answer; earns its place for supersession chains, provenance neighborhoods, and "what's
connected to this cohort."

## 9. Risks and open questions

1. **Payload/URL widening.** `SavedViewState.filters` and `urlState.validateFilters` both
   enforce the flat `Record<string, string|boolean>` shape; `openPayload` rejects mismatched
   envelope versions outright (`store.ts:44`). Decide explicitly: new document kind
   (`querySpec`) vs `savedView` v2 with a migration read-path. Leaning **new kind** — saved
   views keep working untouched.
2. **Version skew.** With co-design, Aperture will meet endpoints spanning Mosaic versions.
   The M1 principle absorbs this: capabilities are read off the introspected schema (presence
   of `where:`, of `facetCounts`, of `searchAll`), so gating is automatic — but the planner
   needs one fallback tier (native `in` semijoin) for pre-M5 endpoints, and the stale-capture
   lesson (§3) says our test fixtures must be re-captured per supported Mosaic version.
3. **as-of × relationship predicates.** Mosaic's temporal path filters in Python over
   reconstructed state and declares relationship-existence out of scope (hippo#71). M5 must
   either restrict (reject `asOf` + RelatedCondition with a coded error) or fund the temporal
   join. An undocumented wrong answer is the one forbidden outcome (ADR-0029).
4. **Aggregation availability semantics.** Mosaic's existing `entity_counts()` counts
   unavailable entities; list queries don't. M2 must pin "aggregates see exactly what list
   queries see" or Aperture's attrition counts will lie.
5. **Polymorphic `is_a`** (`prefab/core-loop.md` Q1.1) — "is BrainSample a collection or a
   saved filter over Samples?" — becomes acute once QuerySpecs exist (a saved parameterized
   QuerySpec *is* the "saved filter over the parent" answer), and doubly so if M4's
   heterogeneous roots ever grow real GraphQL interfaces (Mosaic deliberately exposes no
   `Entity` interface today; ADR-0005 flags union/interface polymorphism as future work). Fold
   into the ADR pair.
6. **Slot-name discipline.** The IR stores LinkML slot names; UI labels go through the rename
   mapping. Mosaic's `resolve_filter_field` now accepts three spellings — convenient, but the
   IR should stay canonical (slot names) so saved artifacts don't fork by spelling.
7. **Certification contracts.** Facet panel and table `data-testid`s are golden-path pinned;
   the builder is additive UI, and the planner must emit today's exact query shapes when a
   QuerySpec contains no RelatedCondition/OR group/operator beyond `eq`.
8. **Reel boundary.** QuerySpec is one query state. Sequencing, forking, watermark pinning
   per-version, set-ops *between* states — Reel. The clean seam: Aperture owns the noun and its
   execution; Reel composes instances of it. Cross-reference Reel ADR-0001/0003.
9. **Mosaic delivery reality.** Mosaic is Beta, weekly-release, two-adapter with a parity
   discipline — healthy, but every M-item above is roughly double-priced by PG parity, and the
   `[Unreleased]` queue is nonempty. The staging in §10 assumes M-items land as separate
   OpenSpec changes, each independently valuable.

## 10. Recommended path & ADR slate (two-sided)

Sequenced so each step is independently valuable and nothing waits on the expensive item:

| Step | Delivers | Side |
|---|---|---|
| 1. M0 hygiene: re-capture introspection, adopt `in`/OR/`asOf`, doc fixes, SDL descriptions | corrected ground truth; literate schema | both |
| 2. Global search landing (client fan-out first) | first cross-class surface; fixes the useless default | Aperture |
| 3. QuerySpec IR + validator + URL/control-plane transport | the noun everything rides | Aperture |
| 4. **M1 typed filter inputs** | operators; introspection-as-capability-contract | Mosaic |
| 5. Builder v1 over M1 (anchor, conditions, OR groups) + semijoin RelatedCondition via native `in` | "donors having samples where…" ships | Aperture |
| 6. **M2 aggregation + order_by** | attrition counts, facet counts, ranges, sort | Mosaic |
| 7. **M3 search composition**; **M4 `searchAll` + `neighbors`** | search-as-criterion; server global search; graph data | Mosaic |
| 8. Column traversal + aggregate/explode export; graph view primitive | the joined table + CSV story; exploration surface | Aperture |
| 9. **M5a → M5b relationship predicates** | planner flips semijoin → server EXISTS; no artifact changes | Mosaic |
| 10. NL → QuerySpec | the AI-native on-ramp; probe-ladder rung 2 | Aperture |

**Aperture ADRs** (next free number: 0035):

- **ADR-0035 — Cross-class queries are a typed QuerySpec artifact** (anchor/focal semantics,
  criteria vocabulary incl. quantified relationship conditions, planner with server-first
  execution + declared semijoin compensation tier, persistence & URL transport). Cross-refs:
  ADR-0002/0004/0005/0009/0015/0017/0029/0032, Reel ADR-0001/0003, Mosaic ADR-0006/0007.
- **ADR-0036 — Global search is a heterogeneous fan-out surface** (server `searchAll` with
  client fan-out degradation; seeds table/graph views).
- **ADR-0037 — `graph` view primitive** (serializable graph description; Cytoscape.js
  realization; `neighbors`-fed; node budgets and class clustering) — sequenced behind ADR-0010.

**Mosaic ADRs** (next free number there: 0006; conventions per its `design/decisions/README.md`
+ OpenSpec changes with tracking issues; note its decision-log index has drifted — 0005 missing,
0001 status stale — fix in the same PR):

- **Mosaic ADR-0006 — The GraphQL filter contract is typed per-class input objects** (M1 + M5
  semantics incl. quantifiers, the CEL-not-on-the-wire decision, `isNull` semantics, PG cast
  strategy, as-of restriction). `Related:` Aperture ADR-0035 + `portal-requirements.md` X3
  (new), mirroring the existing ADR-0001 ↔ Aperture ADR-0023 convention.
- **Mosaic ADR-0007 — Aggregation & ordering surface** (M2: count mode, facetCounts, min/max,
  order_by; availability-consistency rule; temporal-field ordering). `Related:` Aperture
  ADR-0035 + X1 (hippo#96).
- M3/M4 likely ride as OpenSpec changes under 0006/0007 rather than their own ADRs, unless the
  heterogeneous-root work grows real interfaces — that would be its own ADR (it inverts the
  deliberate `Entity` exclusion).

**Aperture X-tracker updates** (`portal-requirements.md:321-328`): promote **X1** with a
pointer to Mosaic ADR-0007; file **X3 — typed operator + relationship-predicate filter contract**
pointing at Mosaic ADR-0006; note X2 (server bulk export) is eased but not solved by M2.
