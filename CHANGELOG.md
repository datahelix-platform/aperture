# Changelog

Aperture's release notes. GitHub also generates a PR list for each release
(`release.yml`). This file adds what that list can't: what breaks, what each
release needs alongside it, and how to upgrade. Releases before v0.8.0 are
described only by their GitHub release pages.

## v0.8.0 — 2026-11-23 (BREAKING: needs Mosaic ≥ v0.16.0 and new config names; with the conversational panel, needs Reel ≥ v0.3.0)

**Breaking release.** Aperture follows the platform-wide `hippo` → `mosaic`
identifier rename (datahelix platform ADR-0007). It reads only the new config
names, reads only Mosaic's renamed `mosaicSchema` field, and ships control-plane
recipe 1.2.0, which needs Mosaic v0.16.0. Read **Upgrading** before deploying.

### Breaking

- **Config is `VITE_GRAPHQL_URL` / `VITE_CONTROL_PLANE_URL`** (#101). The old
  `VITE_HIPPO_GRAPHQL_URL` / `VITE_HIPPO_CONTROL_PLANE_URL` are **not read**
  (no compatibility window). This applies at build time and to the container's
  runtime config (`web/docker/40-aperture-config.sh`). The Python backend's
  default config path is `./mosaic.yaml`.
- **Needs Mosaic ≥ v0.16.0** (#101). Slot enrichment queries `mosaicSchema`.
  Against an older Mosaic it silently degrades: no slot descriptions, and the
  schema is negotiated as plain GraphQL.
- **Control-plane recipe 1.2.0** (#101). It imports `mosaic_core`, annotates
  `mosaic_index`, and requires `mosaic_version >=0.16.0`. The document type is
  unchanged.
- **With the conversational panel on, needs Reel ≥ v0.3.0** (#103). See the
  round trip below. Against Reel v0.2.0 or earlier, every refinement turn
  answers 400 once the result table holds a traversal column.

### Added

- **A proposal's columns load into the result table** (#103, closes #89;
  ADR-0041 note, mosaic#236).
  - A conversational proposal's `QuerySpec.columns` (slot-spelled, up to two
    hops, `count` / `joinIds` / `explode`) seeds the table: path columns, plus
    anchor fields it names.
  - A column that can't be shown is listed under the builder with its reason.
  - Each column keeps the mode the proposal gave it. Mosaic accepts `explode`
    beside `joinIds` / `count` on one link, and a `count` / `joinIds` column on
    the exploded link shows the record's summary on each row.
  - The cap of one exploded link still applies.
- **The round trip carries the reader's columns** (#103; ADR-0039 note).
  - Each refinement turn sends the turn-derived draft with `columns` rebuilt
    from the table, slot-spelled.
  - It is identical to the derived draft when nothing changed. Order alone is
    not a change.
  - This is why Reel ≥ v0.3.0 is needed: Reel's turn contract Amendment 2
    accepts an edited draft.
- **Families (Mosaic ADR-0014) are read-only collections** (#105, ADR-0042).
  - An abstract class with exposed kinds (a GraphQL interface) is now a
    collection, an anchor and a path target. Its kinds come from standard
    `possibleTypes`.
  - It shows only the fields every kind shares, with a hideable **Kind**
    column. Kind-only fields can be used as filters.
  - A row opens its concrete kind's record page, falling back to the family's
    own page.
  - No write or lifecycle actions are offered on a family.
  - The nav lists a family as one entry with a "family" marker. This is
    interim, pending the class browser (#104).
- **Graph view uses Mosaic's `neighbors` root** when the endpoint advertises it
  (#100, closes #95). Each expansion is one request; other endpoints keep the
  client-side fallback.
- **External cross-links work** (#99, closes #96). `VITE_XREFS` (JSON:
  field → `https://…{value}…` template) adds a link to the record page.

### Fixed

- **Lifecycle actions are matched to their own type** (#105). Availability and
  supersede mutations are now matched by their whole name. Before, a type
  could pick up another type's: Brain's "Set availability" called
  `setBankBrainAvailability`. Mosaic accepting another kind's id is
  mosaic#289.
- **A `qs` link with a malformed `columns` list keeps its query** (#103). `qs`
  never carries columns; they are dropped on load.

### Changed

- **Images publish to `ghcr.io/datahelix-platform/aperture`** (#88), and the
  repository URLs point at datahelix-platform.
- **A release dispatches `component-release` to DataHelix** with the image
  digest (#91, #92, #94), so DataHelix's lock bump is opened automatically.

### Docs

- ADR-0042 (families). Notes on ADR-0039 and ADR-0041 for #89. ADR-0041 is
  ratified (#74). The 2026-11-10 decision pass on stale Proposed ADRs is
  recorded (#97). The README acknowledges the Brain Bank (#87) and gains a
  Compatibility table.

### Upgrading

1. **Upgrade Mosaic to v0.16.0 or later first**, along with any schema that
   still uses `hippo_*` keys (Mosaic rejects them).
2. **Reinstall the control-plane recipe at 1.2.0**, if you use it.
3. **Rename the config**: `VITE_HIPPO_GRAPHQL_URL` → `VITE_GRAPHQL_URL`, and
   `VITE_HIPPO_CONTROL_PLANE_URL` → `VITE_CONTROL_PLANE_URL`. Update every
   compose file, entrypoint and env file that sets them. With the old names
   set, Aperture shows its "no endpoint" panel.
4. **With the conversational panel on, deploy Reel v0.3.0** before or together
   with this release.
5. Pull `ghcr.io/datahelix-platform/aperture:0.8.0`, pinned by the digest in
   the release's `image-digest.json`.
