---
name: verify
description: Verify the Aperture SPA end-to-end — stand up a stub Hippo GraphQL endpoint, run the dev server against it, and drive the app in headless Chromium.
---

# Verifying the Aperture web app

The app's surface is a browser talking GraphQL to a Hippo endpoint. Verify by driving that
surface, not by re-running CI (typecheck/lint/test/build are `.github/workflows/web.yml`'s job).

## Recipe that works

1. **Stub endpoint** (real spec-compliant execution — reuse `graphql` from `web/node_modules`):
   a small `node` http server with `buildSchema` + `graphql()` and CORS headers
   (`Access-Control-Allow-Origin: *`, `-Headers: content-type`, `-Methods: POST, OPTIONS`;
   answer `OPTIONS` with 204). Give it a generic schema with list fields taking
   `(filter, limit, offset, search)` args, an enum, a single ref, a list-of-object ref, and a
   `batchPut` mutation — that lights up the negotiated capabilities the UI gates on.
   Serve ~60 rows so pagination has 3 pages.

2. **Dev server:** `cd web && VITE_GRAPHQL_URL=http://localhost:4000/ npm run dev -- --port 5173 --strictPort`

3. **Browser:** `npm install playwright-core` in a scratch dir;
   `chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })`
   (the bare `/opt/pw-browsers/chromium` path is a directory, not the binary — check
   `ls /opt/pw-browsers` for the versioned dir).

## Flows worth driving

- Boot → nav derives collections from introspection; first collection's table renders.
- `Next`/`Prev` → URL gains `?page=N`; short last page disables Next (no faked counts).
- Nav switch → `?collection=X&page=1`; deep-link `/?collection=X&page=2` renders directly.
- `?collection=nonsense` → falls back to first collection; `?page=99` → empty state with
  "Back to first page".
- Kill the stub → boot shows the connect-error panel; mid-session death shows the table error
  state; restart stub + Retry recovers.
- No `VITE_GRAPHQL_URL` → "No data-plane endpoint configured" guidance panel.

Phase-1 read loop (give the stub `filter`/`search` args, singular `book(id)`/`author(id)`
fields, and `entityHistory(entityId)`; see `stub-hippo.mjs` in a session scratchpad or rebuild
from this list):

- Facet panel derives Search + enum/boolean/ref groups; clicking a value filters server-side
  and puts `filters={"field":"value"}` in the URL; second facet ANDs; clear-all resets.
- FTS input applies on Enter → `?q=…`.
- Id cell → detail view (`?entity=…`): fields, relationships, history rows; ref cross-link →
  target detail; "View in <collection>" pivot → filtered target with the facet input pre-filled.
- Export CSV downloads the filtered set (Playwright `page.waitForEvent('download')`), note
  reports row count/truncation.
- Probes: garbage `filters=not-json` → unfiltered table; missing entity id → "Record not
  found"; no-match search → filtered empty state → Clear filters recovers; a collection with
  no filter arg → no facet panel and the inspector column collapses; no detail path → id cells
  are plain text and `?entity=` deep links get an honest panel.

## Gotchas

- The stub must answer the standard `__schema` introspection query — `graphql()` does this
  for free; a hand-rolled JSON responder will not.
- `page.on('console'/'pageerror')` catches React errors the screenshots hide.
- A `/favicon.ico` 404 in the console is pre-existing scaffold noise (no icon link in
  `index.html`), not an app error.

Phase-2 write loop (give the stub `createBook(input: BookInput!)` / `updateBook(id, input)`
mutations with server-side validation that throws on named fields, e.g. empty title, negative
page_count):

- "New <Type>" appears only on collections with a create-shaped mutation; `?form=new` in URL.
- Empty submit → client "Required." block, nothing on the wire; server-invalid value →
  rejection banner verbatim + "See server message above." under the named field.
- Ref picker: type in a ref field → suggestions from the target collection; click fills the id.
- Create → lands on the new entity's detail; the row is then findable via FTS in the table.
- Edit → prefilled; change one field → the update mutation carries only that field
  (partial-merge); save returns to detail with the new value.
- Probes: no-mutation collections show no New/Edit buttons and `?form=new` deep links get an
  honest panel; Cancel from a dirty form persists nothing.

Phase-3 guided workflow (give the stub `batchPut(operations: [BatchOperationInput!]!, dryRun:
Boolean): BatchPutResult` with `input BatchOperationInput {ref, type, data: JSON}`, whole-set
validation, all-or-nothing commit, and intra-batch ref resolution — a data value equal to
another op's ref resolves to that entity; plus `createAuthor` so a two-type workflow is
runnable. Start vite with `VITE_WORKFLOWS='[{...steps...}]'`):

- Nav gains a Workflows section; an unrunnable workflow is disabled with reasons in its title.
- Step 1 stages via "Stage & continue" (a dry-run batch goes over the wire each stage);
  a server-invalid value (negative page_count) blocks advancing with the attributed error.
- Step 2 shows bound fields as locked ("from step … — linked on commit").
- Close mid-run → reopen → "Resumed a saved draft"; Discard resets; a draft with a stale
  schemaFingerprint shows the drift warning instead.
- Review: Commit disabled until "Validate whole set" passes clean; commit → success panel
  with per-step ids cross-linked to detail; the new book's Author relation resolves to the
  author committed in the same batch.
- Atomicity probe (direct POST): a batch with one invalid op returns ok=false and the
  books/authors counts are unchanged.
- After commit the draft is gone — reopening starts fresh.

Phase-4 control plane (give the stub an `ApertureDocument {id, kind, name, payload}` type with
`apertureDocuments(filter: {kind, name}, limit, offset)` + create/update mutations; start vite
WITHOUT `VITE_WORKFLOWS` and seed a `config/workflows` document via direct POST — config-as-data):

- Footer reads "Control plane: LinkML-on-Hippo document store" (or "this browser only" when
  the document type is absent).
- Workflows section appears from the seeded config document, no env var.
- Facet a collection → "Save view" → name it → the document lands server-side and the view
  appears under a Saved views nav section; reopening applies the full query-state.
- Stage a workflow step, then close the WHOLE browser context; a brand-new context resumes
  the draft from the server ("Resumed a saved draft") and sees the saved view too.
- Commit → the draft document is retired (payload cleared, not deleted — W4.4).
- Same-name save shows "Overwrite" and updates in place (still one document).

Gotcha (real bug found here): urql's document cache stores an EMPTY list result with no
typename association, so mutations never invalidate it — control-plane reads must pass
`fresh: true` (requestPolicy network-only). If saved views don't appear after the first save
of the session, suspect this class of bug.
