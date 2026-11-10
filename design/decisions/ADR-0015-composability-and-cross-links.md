# ADR-0015: Composability and cross-links (hrefs)

- **Status:** Accepted in part (cross-links, as built) — ⛔ **Deferred in part** (composition, from MVP with ADR-0010; ADR-0026). See the 2026-11-10 split below.
- **Date:** 2026-06-13 (split 2026-11-10, decision pass)
- **Deciders:** labadorf
- **Related:** raised 2026-06-13 ("composition composability and cross links / hrefs"); depends on ADR-0009, ADR-0010; informed by ADR-0014; Hippo sec4 §4.7, issue #48 (xref)

## Context

The portal is built from composed blocks/views (Level 1 composition, ADR-0004) bound to Hippo
entities (Level 2 binding). Two related questions need a recorded decision:

1. **Composability** — how do view primitives/blocks compose? The ADR-0010 escape hatch is
   "compose primitives, not raw render," so composition is a first-class mechanism, not an
   afterthought. What is the composition model (nesting, slots-within-slots, layout
   containers) and how does it stay within the noun-catalog discipline?
2. **Cross-links / hrefs** — how does a value rendered in one view link to another view
   (entity → detail page, relationship → related entity, external identifier → external
   system)? Links must be *derivable from the schema + config*, not hand-coded, to preserve
   the generic-not-domain-specific invariant (ADR-0002).

Hippo gives Aperture strong material to build on:
- **Internal cross-links** come from GraphQL **resolved relationship fields** — a reference
  slot exposes both the raw UUID (`donorId: ID`) and a resolved entity (`donor: Donor`) — so
  an entity-to-entity href is "route to the bound entity type's detail view for this id"
  (Hippo sec4 §4.7).
- **External cross-links / hrefs** come from Hippo's `ExternalReference` value type +
  `hippo_external_xref` (issue #48), with reverse lookup (`findByXref`, `GET
  /xref/{system}/{value}`) — the basis for "this value links out to STARLIMS/HALO/etc."

## Decision (proposed)

*To be decided in a design session.* Candidate framing:

- A cross-link is itself a **typed primitive / typed param** in the view vocabulary (ADR-0010)
  — a `link` is a noun that resolves a target *route*, never an embedded transform/expression.
- Internal links are **schema-derived** from relationship slots; the binding layer maps a
  reference slot to "the configured detail view for the target entity type." No domain nouns
  in source (ADR-0002).
- External links are derived from `hippo_external_xref` slots and a small per-deployment
  config table mapping `system` → URL template.
- Composition is **declarative nesting of primitives** within layout containers, validated
  headlessly against the manifest contract (ADR-0009); depth/shape is bounded by the
  vocabulary, not by arbitrary code.

## Notes / open sub-questions

- How is a "route" represented so it works under whichever app architecture ADR-0014 picks
  (server route vs. client-side router path)? Keep the view-spec's link target architecture-
  neutral (logical target: entity type + id, or named view + params) and let the runtime
  realize it as an href.
- Multivalued relationship slots don't persist in Hippo's v0.1 SQLite adapter (sec4 §4.7) —
  resolved list-of-links fields return `[]` until linktable support lands. Design the link
  primitive to degrade gracefully.
- Does composition need a "reference/transclude another named view" primitive, and if so does
  that stay a noun (a `view-ref` primitive) rather than becoming a macro/expression layer
  (ADR-0004 line)?

## Split (2026-11-10 — decision pass)

Decided by labadorf in the 2026-11-10 decision pass. This ADR asked two questions, and they
resolve differently. It is amended in place rather than renumbered, so existing citations of
ADR-0015 stay valid.

### Cross-links — Accepted (as built)

Cross-links are derived from the schema and config, never hand-coded (ADR-0002). Checked
against `web/src/features/collections/EntityDetail.tsx`:

- **Single-valued reference** → navigates to the target collection's detail view via
  `openIn(targetCollection, refId)`. It is a logical target (collection + id) that the
  URL-state router turns into a route, which keeps it architecture-neutral as the Notes asked.
- **Multivalued reference** → shows a count and a `View in <target>` link via
  `pivotTo(targetCollection, backRefField, entityId)`. The link appears only when the target
  is filterable by its back-reference (an equality facet). Otherwise only the count shows,
  which is how the link degrades gracefully.
- **External identifier** → links out via `xrefUrl(field, value)`, a per-deployment
  field → URL-template table (`{value}` placeholder), as proposed.

**Known defect:** the external tier is wired in code but not in config. `XREF_TEMPLATES` in
`web/src/config/xrefs.ts` is a hard-coded `{}` that nothing populates, so external links never
render. Tracked as a bug: [aperture#96](https://github.com/datahelix-platform/aperture/issues/96).
The decision stands; only its configuration is missing.

### Composition — ⛔ Deferred from MVP (with ADR-0010)

The composition model (nesting primitives in layout containers, a `view-ref` /
transclusion primitive) depends on the view-description vocabulary. That is ADR-0010, now
**Deferred from MVP** and expected to be superseded by the platform View Contract ADR.
Composition is deferred with it. **Shell-level layout is already settled** by ADR-0031 (a
library of fixed layouts selected by config, with a typed named-slot contract), so the MVP
has no open composition question. The candidate framing above is kept as the starting point
for when ADR-0010's successor lands.
