# ADR-0035: Cross-class queries are a typed QuerySpec artifact

- **Status:** Accepted
- **Date:** 2026-08-19 (ratified same day; see #46)
- **Deciders:** labadorf
- **Related:** ADR-0002 (derived-never-enumerated — every class/edge/operator/traversal comes
  from introspection), ADR-0004 (no middle scripting layer; relationship joins are Level-2
  binding), ADR-0005 (config accessible to humans and LLMs — one typed artifact for both),
  ADR-0009/0010 (views are nouns emitting view descriptions), ADR-0015 (composability &
  cross-links), ADR-0017 (one endpoint — cross-class, never cross-source), ADR-0029
  (capability-gated honest degradation), ADR-0032 (persistence rides the control plane);
  **Reel ADR-0001/0003** (op vocabulary & grain discipline; QuerySpec is the single
  query-state Reel's stories build on — composition/sequencing stays with Reel); **Mosaic
  ADR-0006** (typed GraphQL filter contract, mosaic#153) and **Mosaic ADR-0007** (aggregation
  & ordering surface, mosaic#154) — the server capabilities this artifact compiles to, both
  carrying reciprocal `Related:` lines per the two-sided convention (ADR-0001 ↔ Aperture
  ADR-0023 model); `design/cross-class-query.md` (the exploration this ADR distills, Rev 2 —
  co-designed against mosaic @ 502991c/v0.12.1); `design/portal-requirements.md` X1 and
  **X5** (the typed-filter-contract requirement this ADR drives).
- **Tracking issue:** [#46](https://github.com/datahelix-platform/aperture/issues/46)

## Context

The portal's default surface is a nav list of every derived collection — honest but not
useful: the first question a researcher brings is rarely "show me all X"; it is a *criteria*
question that spans classes ("donors over 60 with samples of type X processed after date Y").
Aperture cannot express that at all today. The gap has three parts: cross-class query
expression, a joined anchor-grain table with CSV export, and (optionally) heterogeneous
graph exploration.

The constraint envelope is fixed by Accepted ADRs: everything offered must derive from
introspection (ADR-0002); the query cannot be an expression box or DSL (ADR-0004 — it must be
a closed, typed, declarative *noun*); every operator/traversal/aggregate must map to a
declared capability and visibly gate off otherwise (ADR-0029); arbitrary join semantics are
rejected (Reel ADR-0003 — grain-typed set-ops and pivots are the sanctioned convergence);
persistence is a control-plane document (ADR-0032). Prior art converges on the same shape:
field/op/value rows in shallow groups (nesting capped at 3), quantified relationship criteria
("having ≥1 / exactly 0 [Samples] where …" — Hasura/Directus wire conventions, OHDSI
Atlas/i2b2 cohort semantics), and anchor-grain flat export with explicit aggregate-vs-explode
choices.

The exploration (`design/cross-class-query.md`, Rev 2) co-designed the server side with
Mosaic rather than treating the endpoint as fixed. The Mosaic half is now recorded: **Mosaic
ADR-0006** makes the introspected GraphQL schema itself the query-capability contract (typed
per-class `<Type>Filter` inputs with per-slot operator objects and phased relationship
predicates — explicitly *not* CEL on the wire), and **Mosaic ADR-0007** adds the aggregation
& ordering surface (counts, `facetCounts`, min/max, `order_by`), with implementation staged
as Mosaic OpenSpec changes (mosaic#155–#158). The question for Aperture: what artifact and
execution model rides on top?

## Decision

**Aperture's cross-class query is a typed, serializable, introspection-validated artifact —
working name `QuerySpec` — executed by a server-first planner with declared, capability-gated
compensation.** In Reel ADR-0001 terms it is an intensional subgraph state restricted to a
single focal lens — the "cohort/query-state foundation" Reel's stories build on.

**The artifact** (normative shape; field-level schema lives with the implementation):

- `anchor` — the focal type; defines what a result row *is*. Anchor semantics answer the
  export question: one row per anchor entity by default.
- `asOf` — optional graph-level watermark (rides Mosaic's `asOf` per its ADR-0001).
- `criteria` — a `CriteriaGroup` (`mode: AND|OR`, nesting capped at **3**) of:
  - `FieldCondition` — `{slot, op, value}` where `slot` is always the **LinkML slot name**
    (never the camelCase rename; saved artifacts must not fork by spelling) and `op` ∈
    `eq | neq | in | gt | gte | lt | lte | contains | isNull`, each offered only when the
    introspected filter input advertises it for that slot (Mosaic ADR-0006).
  - `RelatedCondition` — ≙ Reel ADR-0001's `exists-related-filter`: `{edge, quantifier:
    some|none, criteria}`, conditions holding on the *same* related record. Quantifiers, not
    joins — semi/anti-join expressiveness without join semantics.
  - nested `CriteriaGroup`s (within the depth cap).
- `columns` — `ColumnSpec` paths over anchor slots and to-one traversals; a **to-many path
  requires an explicit per-column choice** between `aggregate` (count/joinIds/min/max — keeps
  anchor grain, the default) and `explode: true` (a grain change ≙ Reel's pivot-grain; always
  explicit, with the grain change stated in the UI and export).
- `sort` — gated on server `order_by` (Mosaic ADR-0007).

**Execution — server-first planner with one declared compensation tier:** the planner
compiles a QuerySpec to whatever the introspected surface advertises (presence of `where:`,
`facetCounts`, `orderBy`, `searchAll` — capability gating is automatic because capabilities
*are* schema features, per Mosaic ADR-0006's introspection-as-contract principle). For
endpoints predating Mosaic's relationship predicates (M5), `RelatedCondition` is covered by a
**server-assisted semijoin**: query the related class with the sub-criteria, collect linking
ids, filter the anchor with one native `in` — capped, visibly declared
(`relationshipFilter: 'compensated'` → `'server'` when M5 introspects), never silent
(ADR-0029). When a QuerySpec contains no RelatedCondition, no OR group, and no operator
beyond `eq`, the planner emits today's exact query shapes (certification contracts hold).

**Validation and dry-run:** every legal value of `anchor`, `edge`, `slot`, and `op` is
enumerable from introspection, so the validator is total; a QuerySpec built against Mosaic
ADR-0006's typed inputs additionally fails GraphQL validation with precise errors before
execution. This is what makes the artifact LLM-emittable (ADR-0005): NL → QuerySpec JSON →
validation → populated builder for review — never generated query text.

**Transport & persistence:** one artifact, three transports — URL state (shareable),
control plane (ADR-0032 versioned envelope; **new `querySpec` document kind**, leaving
`savedView` and its flat-filter validators untouched), and agent I/O. The existing facet
panel becomes a *degenerate QuerySpec* (anchor = current collection, flat AND field
conditions) — no regression, no test-id changes. Parameterized saved QuerySpecs (typed
parameter slots) are the curated escape hatch for the expressiveness tail — never a
scripting layer.

## Consequences

- **Server-independence is the payoff of IR-first design:** Mosaic upgrades (M1→M5b) change
  *how* a QuerySpec executes — which parts compile to server args vs. gate off or compensate —
  but never the artifact. Saved queries, URLs, and NL tooling survive every server version;
  only the planner moves. Version skew is absorbed by reading capabilities off `__schema`,
  with test fixtures re-captured per supported Mosaic version (the stale-capture lesson).
- **Obligations on Aperture:** the planner + validator; the builder UX (anchor picker,
  criteria rows with to-one fields nested under the edge, Atlas-idiom relationship rows,
  column/export picker with aggregate-vs-explode); operator menus and relationship offerings
  derived per-slot from introspection; Mosaic's coded filter errors surfaced verbatim (they
  also feed the NL loop's self-correction).
- **Obligations on Mosaic (recorded on its side):** Mosaic ADR-0006 (typed filter contract;
  mosaic#153, OpenSpec mosaic#155) and ADR-0007 (aggregation & ordering; mosaic#154, OpenSpec
  mosaic#156); search composition and heterogeneous roots ride as Mosaic OpenSpec changes
  mosaic#157/#158. Tracked in `portal-requirements.md` as **X5** (filter contract) and the
  promoted **X1** (aggregation).
- **Live per-criterion counts** (the Atlas trust-builder) light up when Mosaic ADR-0007's
  `facetCounts`/count-mode introspect; until then the result total is the only number shown —
  never a client-computed count over a partial page (ADR-0029).
- **The Reel seam stays clean:** Aperture owns the noun and its execution; Reel composes
  instances of it (sequencing, forking, watermark pinning per story-version, set-ops between
  states — Reel ADR-0001/0003). One query state here, stories there.
- **Export inherits anchor semantics:** default CSV is one-row-per-anchor with aggregates;
  explode is opt-in per path with the grain change and predicted row counts (once counts are
  cheap) stated visibly; the existing capped page-through exporter is reused.

- **Amendment (2026-09-11) — the artifact is spelled in platform LinkML vocabulary, and `v` stays
  1.** As first built, Aperture addressed the `anchor` by its own collection id (`"samples"`) and
  prefixed forward edges `fwd:<graphqlField>`. That was a **local dialect of a shared artifact**,
  and it had a concrete cost: a `QuerySpec` produced by the conversational planning service
  (ADR-0039) names its anchor by LinkML class (`"Sample"`) and its edges by slot, so a proposal
  could be displayed but never run. `anchor` is now the class name and a forward `edge` is the
  reference slot's name; `slot` was already LinkML-spelled and is unchanged.

  **The version is deliberately not bumped.** `v: 1` is the *platform* wire version, not
  Aperture's to change: Mosaic's parser hard-requires it and re-validates every candidate spec
  through that parser, and the planner's own tool schema declares "Always 1." A `v: 2` would come
  back `INVALID_QUERYSPEC_SHAPE`. Since both dialects therefore carry `v: 1`, the version cannot
  discriminate them and `canonicalizeQuerySpec` reads **content** instead, in a stated precedence:
  an anchor matching a typeName is already canonical (checked first), one matching a collection id
  is legacy, and a `fwd:` prefix marks a legacy edge anywhere it appears (LinkML slot names contain
  no colon). An anchor matching neither yields `null` and the caller degrades honestly (ADR-0029)
  rather than running a half-translated query.

  Two scope notes, stated rather than implied. **Reverse edges keep the Aperture-local
  `rev:<collectionId>.<field>` key**, because a reverse edge has no LinkML name until the schema
  declares the inverting slot — which Mosaic ADR-0011 (`mosaic#204`) adds. Naming one now would
  invent a vocabulary upstream has already settled differently, and
  stripping the prefix would be wrong regardless: `rev:samples.donor` reduces to `donor`, a slot on
  `Sample` rather than on the `Donor` anchor, colliding with the forward edge of the same name.
  These keys never reach a server; they drive the client-side semijoin. And Aperture's shape
  remains a documented **subset** of Mosaic's `QuerySpec`, which also carries `as_of` and `sort` —
  a pre-existing gap this amendment does not close.

  **Correction (2026-09-22, ADR-0041): `mosaic#204` has merged.** The sentence above read "and
  which has not merged", which was true when written and is not now — `7fc300c` is on Mosaic's
  `main`, tested across the QuerySpec compiler, GraphQL, MCP and both storage adapters, and a
  deployment that declares `inverse: donor` gets `Donor.samples: [Sample!]!` plus
  `DonorFilter.samples: SampleEdgeQuantifiers` with no Mosaic code change. The `rev:` key's
  *rationale* survives intact, because it was never "upstream has not built this" but "upstream
  will name it, so do not invent a name": the LinkML `inverse` slot name is now that name, and a
  `rev:` key still reduces ambiguously (`rev:samples.donor` → `donor`, a slot on `Sample`, not on
  the `Donor` anchor). What changed is only the horizon — the key is now a *migration* target
  rather than a placeholder for something unbuilt. Two caveats keep it in place for now: no tag
  contains `7fc300c` (Mosaic's latest is `v0.13.0`, which certification pins), and no deployment
  LinkML declares an `inverse:` slot yet.

- **Amendment (2026-09-22) — `columns` is built by ADR-0041, split in two.** The `columns` field
  this ADR reserved is two decisions with different owners, separated by the test *does changing
  it change the row set?* Traversal and grain (`explode`) stay here, in the artifact; visibility
  and order become a view-side `ColumnView` that never reaches a server. See
  [ADR-0041](./ADR-0041-referenced-class-slots-projection-vs-presentation.md), which also records
  why the field went unbuilt for a year: bound together, the explode half needed a server compiler
  (Mosaic still answers `COLUMNS_NOT_SUPPORTED`) and the visibility half needed nothing, so
  neither shipped.

  The only persisted specs are URLs. Saved views (ADR-0032) carry `collection/page/q/filters/sort`
  and never a `QuerySpec`, so the migration surface is bookmarked and shared links, not stored
  documents — narrower than `add-aperture-chat-panel` task 4.1 assumed when it called for "a
  tolerant v1 read for existing saved views."

## Alternatives considered

- **Client-side join/filter compensation as the primary strategy** (Rev 1 of the
  exploration): with Mosaic changeable, compensation-first inverts the platform's
  push-computation-down through-line and bakes in scale caps. Rejected; the semijoin survives
  only as the single declared fallback tier.
- **A CEL/expression argument on the wire:** rejected on Mosaic's side (Mosaic ADR-0006) and
  independently unacceptable here — an expression string is invisible to introspection
  (breaks ADR-0002/0029) and one temptation from a scripting layer (ADR-0004).
- **An open query-builder DSL for users:** violates ADR-0004 directly. The QuerySpec is a
  closed noun vocabulary; the escape hatch is parameterized *saved* specs, not expressions.
- **Arbitrary join semantics / a general join builder** (Metabase-style): rejected by Reel
  ADR-0003 already; quantified relationship criteria + explicit grain pivots cover the
  scientist-facing need (Atlas/i2b2 precedent) without join semantics.
- **Extending `savedView` (v2 + migration) instead of a new document kind:**
  `SavedViewState.filters` and its URL validators enforce the flat shape, and `openPayload`
  rejects mismatched envelope versions outright; a new kind leaves saved views untouched and
  avoids a migration read-path. Leaning new kind — confirm at ratification.
- **Waiting for Mosaic M5 before shipping any cross-class capability:** M5b is the one
  expensive server item and nothing else waits on it; the semijoin tier (now cheap via the
  native `in` operator) delivers "donors having samples where…" against the shipped v0.12
  surface. Rejected.

## Notes / open sub-questions

- The rest of the exploration's ADR slate is filed separately when its features are picked
  up: **ADR-0036** (global search as heterogeneous fan-out, over Mosaic `searchAll` /
  mosaic#158) and **ADR-0037** (`graph` view primitive, sequenced behind ADR-0010).
- Polymorphic `is_a` (prefab core-loop Q1.1) becomes acute once QuerySpecs exist — a saved
  parameterized QuerySpec *is* the "saved filter over the parent" candidate answer; fold into
  ratification.
- bm25-rank vs. `order_by` precedence when search composes with criteria is pinned on the
  Mosaic side (OpenSpec `search-composition`, mosaic#157); the builder mirrors whatever ships.
- Confirm the `querySpec` document-kind choice (vs. `savedView` v2) at ratification.
- Depth-cap value (3) matches the industry ceiling (Airtable/Notion) and Mosaic ADR-0006's
  planned filter-nesting cap; keep the two aligned when M5b lands.
