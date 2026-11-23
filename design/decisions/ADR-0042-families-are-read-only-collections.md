# ADR-0042: A family (an abstract class, Mosaic ADR-0014) is a read-only collection whose rows open their own kind's record page

- **Status:** Accepted
- **Date:** 2026-11-23 (amended the same day after the #105 review: read-only enforced for lifecycle, kind-only filter fields, `mosaic_anchor: false` references)
- **Deciders:** labadorf (the four UI choices and the interim nav, 2026-11-23, in the aperture#103 review)
- **Related:** **Mosaic ADR-0014** (polymorphic references; abstract classes as GraphQL interfaces and read-only anchors), ADR-0017 (standard introspection is the baseline), ADR-0029 (honest degradation), ADR-0041 (traversal columns), ADR-0035 (QuerySpec); [aperture#104](https://github.com/datahelix-platform/aperture/issues/104) (the class-browser page that replaces the sidebar's class list); aperture#103 / #89 (proposal columns through a family range)

## Context

Mosaic v0.16.0 implements Mosaic ADR-0014. An abstract class with exposed kinds (a **family**:
`Sample` with kinds `Brain` and `Blood`) is emitted as a GraphQL **interface**, implemented by
each kind's object type. It has:

- a read-only collection: `samples` (a `SamplePage` of interface items), `searchSamples`,
  `samplesCount`, facet counts and field range;
- a by-id lookup: `sample(id:)`, which returns the interface;
- the fields every kind stores alike, and only those, as interface fields (`id`, `label`,
  `producedBy`);
- a typed filter and order enum that also take the **kind-only** fields (`hemisphere`,
  `volumeMl`), read as NULL for kinds without them;
- no create, update or lifecycle mutations (Decision 6).

References ranged on a family (`Measurement.sample`, `Assay.inputs`) return the interface.
`__typename` names the concrete kind.

Aperture derived only OBJECT types. `columnFor` dropped every reference into an interface,
`pageEnvelope` skipped every family page, and `deriveDetailPath` skipped `sample(id:)`. A family
was invisible: no collection, no anchor, and no column or path through it. The aperture#103 review
found the visible symptom: a proposal column `[prize, label]` that Mosaic accepts was dropped as
"Book has no field “prize”".

## Decision

**Aperture will treat a family as an ordinary, read-only collection, derived from standard
introspection, and open each of its rows on that row's own kind's record page.** Concretely:

1. **Derivation accepts interfaces.** `columnFor`, `pageEnvelope` and `deriveDetailPath` accept
   INTERFACE types wherever they accepted OBJECT types. A reference into one is a `ref`/`refList`
   column flagged `targetIsFamily`. A family's page becomes a `CollectionModel` with
   `family: { kinds }`, the kinds read from the standard `possibleTypes` (added to
   `INTROSPECTION_QUERY`; ADR-0017, no Mosaic enrichment required). It appears wherever
   collections do: nav, record links, query anchor, traversal paths (ADR-0041) and the
   conversational round trip.
2. **What a family carries follows Mosaic ADR-0014.** Its columns are the interface's fields,
   i.e. only the slots every kind stores alike. Its **filter fields are built from its filter
   input type**: the columns' fields plus every kind-only field the input takes, which Mosaic
   reads as NULL for other kinds (#278 ruling). A kind-only field has no column, so its kind
   (`CollectionModel.filterKinds`) is read from its ops type: `FloatFilterOps` gives `number`,
   a nested `<Type>Filter` gives `ref`. Aperture adds no semantics of its own.
   - **`mosaic_anchor: false`** removes the family's own page and lookup, so no collection
     derives. References into it remain (Mosaic keeps it as an edge target), and they are
     handled: a value still opens its kind's page by `__typename` (`referenceTarget`). A path
     through it can't be followed yet, because path resolution steps through collections. A
     proposal column through it is dropped with a reason that says so (aperture#103).
   - **`mosaic_manifest: false`** affects only the planner.
3. **Read-only.** A family derives **no write and no lifecycle actions** (Mosaic ADR-0014
   Decision 6). Edits happen on the kind's page (item 4). Writes need no special case: create
   and update match on the mutation's return type, and no mutation returns the interface.
   Lifecycle actions are matched by name, so they are set to none for a family explicitly. Their
   names are now matched **whole** (`set<Type>Availability`, `supersede<Type>`), case-insensitive
   only for Mosaic's camel-casing (`ExternalID` → `setExternalIdAvailability`). The earlier
   substring match let a type borrow another's mutations. `Prize` took
   `setLiteraryPrizeAvailability`, which reported success on the family page and changed
   nothing. `Brain` took `setBankBrainAvailability`, on main as well. Mosaic accepting a
   mismatched id is [mosaic#289](https://github.com/datahelix-platform/mosaic/issues/289).
4. **A row opens its concrete kind's record page.** A family value is selected with
   `__typename`. `recordCollection` maps it to the collection of that type, which shows every
   field and the kind's own edit and lifecycle actions. If the kind has no collection with a
   record lookup, or the row has no `__typename`, the row falls back to the family's own record
   page (`sample(id:)`, shared fields only). This applies to the table's id column, reference
   cells, the record page's reference links, and query-result row clicks.
5. **A "Kind" column.** A family's table leads with a synthetic `Kind` column read from
   `__typename`. It can be hidden and exported like any column. It is not a slot, so it is never
   a filter, facet, sort key, form field or QuerySpec path (`ColumnModel.synthetic`).
6. **Nav: one flat entry, marked (interim).** A family is listed like any collection under its
   list name ("Samples"), with a small "family" marker whose tooltip names its kinds. Each kind
   stays its own entry. **This is interim.** The maintainer has asked for the sidebar's class list
   to be replaced by a class-browser page that groups the hierarchy by family
   ([aperture#104](https://github.com/datahelix-platform/aperture/issues/104), after v0.8.0, with
   its own ADR). How families nest is decided there, not here.

## Consequences

- Paths through a family resolve and translate (`[sample, label]`, `[inputs, label]` with
  `explode`). aperture#103's `[prize, label]` case is fixed by this ADR, not by #103's
  translation code.
- A family can be a query anchor (Mosaic ADR-0014 Decision 3), so `anchor: "Sample"` from a
  planner (reel#10) now resolves in the builder.
- Every selection of a family value adds `__typename`: one extra leaf per family reference.
- A concrete parent (`Process` with subclass `BankBrain`) is **not** a family. It stays an
  object type whose rows render as the base type. Its `entityType` field (Mosaic ADR-0014
  Decision 1) shows as an ordinary column. Linking such a row to its subclass's page is not
  decided here.
- An endpoint without interfaces is unaffected: nothing derives differently (ADR-0029).
- `possibleTypes` is a new introspection field. Every conformant GraphQL server answers it.

- **Known follow-up: kind-only fields get no facets or sorting.** Mosaic facets, ranges and
  orders on them over the family, but Aperture derives facets and sort keys from columns only.
  Tracked in [aperture#106](https://github.com/datahelix-platform/aperture/issues/106). They
  filter (Decision 2).

## Alternatives considered

- **Family-only path resolution** (resolve a hop into an interface's fields without making it a
  collection). Rejected: a second resolution path beside `deriveEdges`/`resolvePath`, and
  families would stay invisible everywhere else.
- **Drop a family hop with an accurate reason, defer support.** Rejected 2026-11-23: it leaves
  Mosaic-valid proposals unshowable.
- **Always open the family's own record page.** Rejected: it shows only the shared fields and has
  no edit or lifecycle actions, so the reader would have to find the kind by hand.
- **Nest kinds under their family in the nav now.** Deferred to aperture#104, which replaces the
  sidebar list altogether. Building nesting into a list that is being replaced would be wasted.

## Notes / open sub-questions

- Verified against a live mosaic v0.16.0 (the released wheel) on Mosaic's closure fixture
  (`tests/support/closure_fixture.py`) plus `Measurement.sample: Sample`, captured as
  `web/src/data/testing/familyIntrospection.json`. Results:
  - `samples` lists `br1:Brain` and `bl1:Blood`; each opens `brains`/`bloods` with its kind-only
    fields.
  - `sample(id:)` serves the fallback page.
  - `Measurement.sample` opens the kind's page.
  - `[sample, label]` and an exploded `[inputs, label]` render.
  - A `Sample`-anchored QuerySpec on kind-only `hemisphere = L` returns `br1` only. After the
    review fix it also passes Aperture's own `validateQuerySpec` (it was rejected as "not
    filterable", which disabled Run). So does `volume_ml > 1`, which returns `bl1`.
  - Live lifecycle: `samples` has none, `brains` gets `setBrainAvailability` / `supersedeBrain`,
    and `bankBrains` gets its own.
- Whether a concrete parent's rows should link to their subclass's page (via `entityType`) is
  open, and is not needed for v0.8.0.
