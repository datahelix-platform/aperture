# ADR-0041: A result table's referenced-class values are two decisions, not one — traversal/grain is query, visibility/order is view

- **Status:** Proposed
- **Date:** 2026-09-22
- **Deciders:** labadorf (pending); clandaverde (investigation)
- **Related:** **ADR-0035** (cross-class queries are a typed `QuerySpec`; this ADR resolves the
  `columns` field ADR-0035 reserved and never built, and is the amendment vehicle Reel ADR-0006 §3
  requires for a change to the noun) · ADR-0002 (derived, never enumerated) · ADR-0004 (no middle
  scripting layer — a column selection is a noun, not a projection expression) · ADR-0009/0010
  (views emit view descriptions from a typed noun catalog) · ADR-0015 (cross-links name logical
  targets) · ADR-0029 (capability-gated honest degradation) · ADR-0037 (graph view primitive) ·
  **Mosaic ADR-0005** (edge-only reference emission — the raw FK is `strawberry.Private`, so a
  referenced value is reachable *only* through a nested selection) · **Mosaic ADR-0006** (typed
  filter contract; M5a relationship predicates) · **Mosaic ADR-0009** (the MCP boundary validates
  `QuerySpec`; its validator mirrors this decision) · **Mosaic ADR-0011** (inverse slots as virtual
  reverse edges — *implemented and merged*, see Context) · **Reel ADR-0005** (View Contract is the
  renderer seam) · **Reel ADR-0006** (Reel's v1 `State` *is* the `QuerySpec`; `pivot-grain` is
  listed blocked on mosaic#204) · `datahelix:platform/design/view-contract.md` (stub; the eventual
  home of the presentation half) · `design/cross-class-query.md` §5, §8 · `mosaic-demo-small`
  `APERTURE_EXON_CONTRACT.md` "Open questions" (explode-vs-`RelatedCondition` scoping)
- **Tracking issue:** [#65](https://github.com/datahelix-platform/aperture/issues/65); cross-component
  umbrella [datahelix#93](https://github.com/datahelix-platform/datahelix/issues/93) (sequence across
  aperture/mosaic/reel/certification), with mosaic#217 (ratify ADR-0011), mosaic#218 (cut the
  release carrying it), datahelix#92 (certification fixture v1.1.0), reel#2 and
  mosaic-demo-small#1

## Context

Aperture's result table shows one row per anchor entity, over the anchor's own columns. A user who
queries Samples filtered by donor cohort cannot see the cohort: the reference renders as a UUID.
The requirement is to show slot values from *referenced* classes, joined into the same table, with
repeated anchor values where a reference is to-many, and a user-controlled include/exclude set.

**The premise this started from was wrong in a load-bearing way, and the correction sets the
scope.** It is not "the server returns the data, the client cannot display it." Two things are
true instead, both verified:

1. **`QuerySpec` cannot express column selection at all.** Mosaic's parser hard-rejects it —
   `core/query_spec.py:223`, `COLUMNS_NOT_SUPPORTED`: *"'columns' (aggregate-vs-explode selection,
   ADR-0035) has no Mosaic-side compiler yet — omit it, or request full envelopes and project
   client-side."* The conversational path (ADR-0039) round-trips every spec through that same
   parser, so a `columns` key added to the artifact today would break the chat panel.
2. **Referenced values never cross the wire.** `web/src/data/hippoSource.ts:154` (`selectionFor`) emits
   `field { targetIdField }` for every `ref`/`refList`. `renderCell`'s `ref` branch can only ever
   print an id and its `refList` branch only a count, because nothing else was ever requested.

So this is a data-layer + planner + UI change, and the interesting question is not *how to render*
but **what kind of decision a column is**, because three repos have been calling two different
things by one name. ADR-0035 sketched `columns: [ColumnSpec]` carrying both a traversal `path` and
an `aggregate`/`explode` choice; Mosaic ADR-0009 lists `columns` among the fields its boundary
accepts; Reel ADR-0006 lists it in the `QuerySpec` shape it adopts wholesale. None of them built
it, and the reason they could not is that the field conflates two decisions with different owners,
different validators, and different blast radii.

**What the endpoint actually offers** (generated from the live 15-collection demo schema through
`GraphQLTypeBuilder`, not read off the stale `realIntrospection.json` capture, which is still the
4-class book schema and contradicts Mosaic ADR-0005):

| Path | Example | Available | Grain |
|---|---|---|---|
| Forward to-one | `Sample.donor { cohort ageAtDeath }` | yes — nested selection, `DataLoader`-batched per request per type | unchanged |
| Forward to-many | `Workflow.inputSamples { accession }`, plus a free `inputSamplesCount: Int!` | yes | **changes** |
| Reverse | `Donor` → its Samples | **only when the schema declares `inverse:`** | changes |

The reverse row is the one that moved. Mosaic ADR-0011 is still `Proposed` and Reel ADR-0006
records `pivot-grain` as *"blocked — needs reverse-edge traversal (mosaic#204)"*. **That is stale.**
mosaic#204 is merged (`7fc300c`, with `3311f98`/`999cbdf`/`9f0ab00`/`27d8bcb`/`4887d82` behind it)
and tested end to end across the QuerySpec compiler, GraphQL, MCP and both storage adapters.
Adding `inverse: donor` to a `Donor.samples` slot and regenerating the schema yields, with **no
Mosaic code change**:

```graphql
type Donor {
  samplesCount: Int!                 # free cardinality, one indexed COUNT(*)
  samples: [Sample!]!                # resolved reverse edge, nested-selectable
}
input DonorFilter { samples: SampleEdgeQuantifiers }   # { some: SampleFilter, none: SampleFilter }
```

Reverse traversal is therefore not an engineering problem on any repo. What stands between it and
use is **release and schema authoring**, not code: `7fc300c` is on `origin/main` but **carried by no
tag** (the latest is `v0.13.0`, which certification pins), it sits among 40 unreleased commits
alongside the whole MCP boundary, and no deployment LinkML on the platform declares an `inverse:`
slot yet.

The same probe sharpens the adjacent gap recorded below: Mosaic's typed filter contract is
**complete in the certified pin** — `67e1a24` (M5a, to-one predicates) and `c758d8a` (M5b, to-many
quantifiers) are both in `v0.13.0`, and the as-shipped demo schema already generates
`WorkflowFilter.inputSamples: SampleEdgeQuantifiers { some, none }`. Aperture uses none of it.

The constraint envelope is unchanged: everything offered derives from introspection (ADR-0002); the
selection is a closed typed noun, never a projection expression (ADR-0004); anything the endpoint
does not advertise gates off visibly rather than being compensated silently (ADR-0029).

## Decision

**Aperture splits the result table's referenced-class values into two artifacts, separated by one
test — *does changing it change the row set?* — and ships the forward directions now.**

**The test.** Choosing to traverse `Workflow → inputSamples` and explode it turns 128 matching
workflows into 342 table rows. That is a different answer to "what is a row", and it is exactly
Reel ADR-0001's `pivot-grain`. Hiding the `accession` column changes nothing about which rows
exist. The first is query semantics; the second is presentation. They have been sharing a name.

1. **Traversal and grain stay in the `QuerySpec`, under its reserved `columns` field.** A
   `ColumnSpec` names a `path` (anchor slot, or a schema-derived reference edge followed by a slot,
   depth-capped at **2 hops** client-side — well inside Mosaic's `DEFAULT_MAX_QUERY_DEPTH = 10`) and,
   for any to-many hop, an explicit `count | joinIds | explode`. It is schema-validated by the same
   total, introspection-driven validator every other part of the artifact is, and it is
   server-compilable — the eventual Mosaic compiler changes only *where* it executes.
   **The field keeps the name `columns`.** It is already reserved in ADR-0035, named in Mosaic
   ADR-0009 and Reel ADR-0006, and carried by a shipped error code, an MCP prompt and four repos'
   prose. Renaming it would be vocabulary churn with no functional payoff.
2. **Visibility, order and labelling are a separate view-side artifact** — a **`ColumnView`** —
   which never reaches a server, never affects the row set, and is not part of the noun. Aperture
   owns it as interim view state; it is the natural occupant of the View Contract's `table`
   `encoding` when `platform/design/view-contract.md` stops being a stub.
3. **The user manipulates one control; the two artifacts are derived from it.** `QuerySpec.columns`
   is the union of the paths the user has **chosen**; the `ColumnView` carries each chosen path with
   a **visibility flag**. One affordance, two artifacts, one derivation rule — and the flag is what
   keeps them separate: hiding a column must never narrow `columns`, because that would mutate `qs`,
   re-run the query, and silently change what a shared link means. A path leaves `columns` only by
   being *unchosen*, which is a query edit and is presented as one.
4. **Aperture ships `columns` client-side now, unchanged in shape when it compiles server-side
   later.** Nothing is added to the wire artifact until Mosaic's validator accepts it (§Consequences);
   until then the projection is executed exactly as `COLUMNS_NOT_SUPPORTED` prescribes — full
   envelopes plus a merged nested selection, projected in the client.
5. **Forward to-one and forward to-many ship; reverse is offered and disabled until the deployment
   schema declares it.** A reverse edge the endpoint does not advertise is *listed* in the picker
   and gated off with its reason named (ADR-0029) — silence would read as "this data does not
   exist". The planner's capped `rev:` semijoin is **never** repurposed to fetch display values: a
   500-row cap that silently truncates a filter is bad, and one that silently truncates *displayed
   data* is worse.
6. **A grain change is always stated on screen and in the export.** An exploded table says
   *"1 row per Workflow × Sample — 342 rows from 128 workflows"*, and the export's cap message names
   its unit. Without this, the result total sits above a table it does not describe.

## Consequences

- **The ADR-0035 blocker dissolves without touching the artifact's version.** `v` stays 1;
  `columns` was reserved from the start. This is the field ADR-0035 wrote down and deferred, now
  given an owner boundary that lets it be built incrementally instead of all at once.
- **Aperture obligations.** A path-aware, sibling-merging selection builder replacing
  `selectionFor` (two chosen donor fields must emit one `donor { … }`, and every nested object must
  carry its id field for row-click and `joinIds`); a row flattener producing the explode grain; the
  picker enumerating `detailColumns` (budget 50), **not** `columns` (budget 8) — `deriveEdges`
  already documents that resolved reference edges *"sit after the computed fields … so the curated
  table budget routinely truncates them away"*, which is to say the edges this feature is about are
  outside the table budget; `renderCell` / `isRightAligned` / `toCSV` / `toJSONExport` re-keyed off
  `column.field` onto paths — `toJSONExport`'s `f in row` guard will otherwise *silently* drop every
  path key, which is the one failure here that leaves no trace.
- **Mosaic obligations (proposed on its side, not decided here).** Amend ADR-0009 so its validator
  accepts `columns` under this split and lift `COLUMNS_NOT_SUPPORTED` when the compiler lands; keep
  `construct-query-spec`'s prompt truthful in the interim (`mcp/server.py:736` already is). Ratify
  ADR-0011 — the code merged, the status did not — **cut a release carrying it**, since reverse
  traversal is otherwise unreachable from any pinned, certifiable server; and declare `inverse:`
  slots in the deployment schemas, which is what actually unblocks reverse traversal for every
  consumer at once.
- **Reel is a downstream consumer, and one of its blockers is already gone.** Reel ADR-0006's
  `pivot-grain` row should move off "blocked on mosaic#204": an `explode` `ColumnSpec` *is* a
  declared grain change, and reverse anchoring works wherever `inverse:` is declared.
  `render-as-primitive` is where `ColumnView` eventually lands. No Reel deliverable is required for
  Aperture to ship this.
- **Certification cannot test the interesting half today.** `certification/fixtures/bootstrap/
  schema/portal_schema.yaml` (v1.0.0) is the Book/Author/Review schema: no multivalued reference,
  no `inverse:` slot. Explode and reverse traversal are therefore uncertifiable against the current
  fixture, and the fixture must gain both. Ledger facts are about immutable artifacts, so a
  `fixture_version` bump appends new facts rather than invalidating existing entries (platform
  ADR-0001).
- **The stale capture is a test blocker, not a detail.** `web/src/data/testing/realIntrospection.json`
  is the 4-class book schema and carries `Book.authorId` *alongside* `Book.author`, contradicting
  Mosaic ADR-0005's edge-only emission, with zero entity-level list-of-object fields. Every test
  below the flattener needs a re-capture against a live serve. ADR-0035 names this failure mode by
  its own name — the stale-capture lesson.
- **Adjacent — and it should ship in the same pass.** Mosaic's typed `where:` surface is complete on
  the *certified* pin: `SampleFilter.donor: DonorFilter` (M5a), `WorkflowFilter.inputSamples:
  SampleEdgeQuantifiers` (M5b), plus `and`/`or`/`not`. Aperture's planner still compiles to the flat
  `filters:` list and still runs every `RelatedCondition` through the capped client semijoin.
  Adopting it lifts that cap and makes `quantifier: none` real, which `validateQuerySpec` currently
  hard-errors on. It is a *separate decision*, but not a separate pass: it rewrites
  `buildListQuery`'s **filter** path while this ADR rewrites the same function's **selection** path.
  Split across two changes, that query builder is rewritten twice, its contract tests re-baselined
  twice, and the composition re-certified twice, for no gain.

## Status corrections (2026-09-25)

Two sweeps' worth of drift, recorded rather than edited into the text above, per the
repo's convention (`decisions/README.md`: supersede, don't edit history). The Context
section describes what was true when this was written on 2026-09-22; these are what has
changed since, and one place where the Decision overstates what was built.

**The split is currently semantic, not structural.** Decision items 1–3 describe two
artifacts — `QuerySpec.columns` for traversal and grain, a separate `ColumnView` for
visibility and order. **The implementation has neither.** There is one `PathColumn[]` held
in component state (`QueryBuilderView`), where `many.mode` carries the grain decision and
membership of the list carries the display decision. No `ColumnView` type exists, and
`QuerySpec` has no `columns` field.

That is consistent with Decision item 4 ("nothing is added to the wire artifact until
Mosaic's validator accepts it") and with the test the whole ADR turns on — the code does
keep grain separate from visibility, and hiding a column still cannot change the row set.
What it does not do is *reify* the separation, because nothing yet persists either half:
the `columns` field has no server compiler, and whether `ColumnView` rides the URL is still
open below. Reifying two artifacts to serve a persistence layer that does not exist would
be speculative structure.

**The two separate when either half first needs to persist** — a `cols` URL parameter, or
Mosaic accepting `columns` on the wire. Until then, read items 1–3 as *where each decision
belongs*, not as a description of types that exist today.

**Facts the Context section states that have since moved:**

| Stated | Now |
|---|---|
| `7fc300c` "carried by no tag", among 40 unreleased commits | **mosaic v0.14.0** released; certification pins it |
| Typed filter contract "complete in the certified pin — `v0.13.0`" | still complete; the pin is now **v0.14.0** |
| Certification fixture has no multivalued reference and no `inverse:` slot, so explode and reverse traversal are "uncertifiable" | **fixture 1.1.0** carries both, and `fixture 1.1.0 · aperture0.5.0+mosaic0.14.0` is a passing ledger entry |
| No deployment LinkML declares an `inverse:` slot | `mosaic-demo-small` declares four (`Donor.samples`, `Donor.diagnoses`, `Sample.aliquots`, `Workflow.datasets`), verified against its existing database with no re-ingest |
| Anchor-field toggles are "in flight on `fix/discovery-turn-chrome` (`12cf637`, not yet on `main`)" | merged (aperture#69); `FieldsPanel` is on `main` and is where the traversal picker was built |

None of these changes the decision. The reverse-edge gating in particular behaves exactly as
designed: the same derivation code offers reverse columns where a schema declares the
inverting slot and gates them off where it does not, deciding from introspection and never
from a version number.

## Alternatives considered

- **Put everything in `QuerySpec.columns`, visibility included** (ADR-0035's literal sketch). Makes
  hiding a column a query edit: it re-runs the query, invalidates a shared URL's meaning, and forces
  Mosaic's validator and Reel's op catalog to care about presentation. It is also what stalled the
  field for a year — the aggregate/explode half needs a server compiler, and the visibility half
  needs nothing, so binding them meant neither shipped. Rejected.
- **Put everything in view state, including explode.** Explode changes the row set, so a saved or
  shared query would reproduce a different table than the one it names, and Reel's `pivot-grain` —
  defined as a *State* transition — would have no artifact to attach to. Rejected.
- **Rename `columns` to `projection` to mark the narrowing.** Four repos, a shipped error code, an
  MCP prompt and an evals file carry the name; the churn buys nothing the ADR text cannot say.
  Rejected.
- **Fetch reverse columns through the planner's existing `rev:` semijoin.** Available immediately
  and requires no schema change — but it caps displayed data at 500 related records and its `rev:`
  keys are already flagged provisional Aperture-local dialect by ADR-0035's own amendment. Declaring
  `inverse:` costs less and is correct. Rejected.
- **Wait for the Mosaic `columns` compiler before shipping anything.** The client-side projection is
  the remedy `COLUMNS_NOT_SUPPORTED` itself prescribes, and the artifact does not change when the
  compiler lands — only the planner does, which is precisely ADR-0035's server-independence payoff.
  Rejected.

## Notes / open sub-questions

- **Does an `explode` show all members, or only those matching a `RelatedCondition` on the same
  edge?** Recorded as unresolved in `APERTURE_EXON_CONTRACT.md` and in ADR-0035 itself.
  *Recommended resolution to pressure-test:* **all members by default**, with an explicit per-explode
  "only the ones matching my criteria" toggle, and the active choice stated. Criteria select
  *anchors*, not members; silently narrowing the exploded rows would make the table disagree with
  the total above it. Both readings are cheap — the sub-criteria are already in hand client-side and
  are the same predicate server-side — so this is a defaults question, not a capability one.
- **A wart this split produces, stated rather than discovered at ratification.** Hide the last
  visible column on an exploded path and the table still shows duplicated anchor rows with nothing
  on screen explaining the duplication. Making visibility collapse the grain would re-couple the two
  artifacts this ADR just separated. *Recommended:* keep them separate and keep the grain note
  visible, so the duplication is always explained even when its cause is hidden.
- **Cap explode to one path per query in v1?** Two exploded to-many paths is a cartesian product
  with no user model behind it. Leaning yes, stated as a cap rather than an omission.
- **Does the `ColumnView` ride the URL?** `qs` does; the anchor-field visibility toggles in flight
  on `fix/discovery-turn-chrome` (`12cf637`, not yet on `main`) hold `hiddenFields` in `useState`,
  which dies with the tab. A link that reproduces a table but not its columns is a half-share; a
  `cols` parameter with its own nuqs validator is small. Leaning yes — confirm at ratification.
- **Depth cap of 2 hops** is a client choice inside a server cap of 10, chosen to match ADR-0035's
  nesting discipline. Revisit if a real schema needs 3.
- Confirm the `ColumnView` → View Contract `encoding` landing at the point
  `platform/design/view-contract.md` stops being a stub; this ADR decides Aperture's interim
  ownership, not the platform artifact's shape.
