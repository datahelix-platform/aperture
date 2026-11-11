# Aperture Web (MVP portal SPA)

The TypeScript single-page app for the Aperture MVP portal — a config-driven, schema-derived
data explorer over a Hippo (LinkML + GraphQL) endpoint. Stack per **ADR-0030**: Vite + React +
TypeScript, urql (GraphQL), TanStack Table, nuqs. Talks to Hippo's GraphQL **directly**
(ADR-0014/0016).

> **All four MVP phases built.** The app introspects the endpoint, negotiates capabilities,
> and derives everything from the schema: collections nav + table (Phase 0); equality facets +
> FTS, entity detail with cross-links/relationship pivot/change history, CSV/JSON export
> (Phase 1); Tier-0 create/edit forms generated from the mutation input types, with client
> pre-validation, server-authoritative rejection surfacing, partial-merge updates, and
> ref-pickers (Phase 2); the Tier-1 guided workflow (Phase 3, ADR-0028): steps-as-data config
> interpreted by a pure engine, staging in resumable version-pinned drafts, continuous
> dry-run, and one atomic batch commit with intra-batch references; and the control plane
> (Phase 4, ADR-0017): saved views, cross-browser drafts, and workflows-config-as-data as
> versioned documents on a LinkML-on-Hippo store (co-located by default,
> `VITE_HIPPO_CONTROL_PLANE_URL` to split; localStorage fallback, labeled in the footer).
> The full query state `{collection, page, q, filters, entity, form, workflow}` lives in the
> URL. See `../design/implementation-plan.md` for the phased build and
> `../design/design-export/` + `../design/design-tokens.md` for the visual target.

## Getting started

```bash
cd web
npm install
VITE_HIPPO_GRAPHQL_URL=http://localhost:8000/graphql npm run dev
```

`VITE_HIPPO_GRAPHQL_URL` points at a running Hippo GraphQL endpoint (`hippo serve` with the
graphql extra). Without it the app starts in an honest "no endpoint configured" state. You can
also put the variable in an untracked `web/.env.local`.

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | typecheck (`tsc -b`) + production build |
| `npm run preview` | preview the production build |
| `npm run test` | run unit tests once (Vitest + Testing Library) |
| `npm run test:watch` | tests in watch mode |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |

CI runs typecheck + lint + test + build on changes under `web/` (`.github/workflows/web.yml`).

## Docker image (issue #22, DataHelix P1.4)

`web/Dockerfile` builds the SPA and serves it with nginx. Pushing a `vX.Y.Z` tag publishes a
digest-addressed image at `ghcr.io/bu-neuromics/aperture` with an `image-digest.json` release
asset for the DataHelix certification ledger (`.github/workflows/release.yml`; the tag must
match `web/package.json`'s version).

The published image is **deployment-agnostic**: endpoint config is injected at container
start, not baked at build. The entrypoint (`docker/40-aperture-config.sh`) writes recognized
env vars (`VITE_HIPPO_GRAPHQL_URL`, `VITE_HIPPO_CONTROL_PLANE_URL`, `VITE_WORKFLOWS`,
`VITE_NAV`, `VITE_XREFS`, and the `VITE_AUTH_*` set below) into `config.js`, which `index.html` loads before
the bundle
(`src/config/runtime.ts`); runtime values override build-time ones.

```bash
docker build -t aperture-web web/
docker run -p 5173:80 -e VITE_HIPPO_GRAPHQL_URL=http://hippo:8001/graphql aperture-web
```

`VITE_HIPPO_GRAPHQL_URL` may also be a **relative path** (e.g. `/graphql`): the SPA hands it
to `fetch`, which resolves it against the page origin. Same-origin deployments that
reverse-proxy the GraphQL endpoint next to the SPA (the DataHelix `solo` recipe) use this to
avoid CORS configuration entirely.

## Authentication (ADR-0038)

Aperture **never authenticates**. It holds no token, runs no OAuth flow, and enforces nothing.
An authenticating reverse proxy in front of it (DataHelix platform ADR-0006 — PIV/CAC via VA
SSOi in production, htpasswd for testing) establishes the session; Aperture reads a same-origin
identity endpoint and *presents* the result.

Off by default. With `VITE_AUTH_MODE` unset the capability renders nothing and the app behaves
exactly as it did before it existed.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_AUTH_MODE` | `none` | `proxy` turns the capability on. Any other value is `none`. |
| `VITE_AUTH_IDENTITY_URL` | `/oauth2/userinfo` | Same-origin JSON endpoint returning the viewer's claims. |
| `VITE_AUTH_LOGIN_URL` | `/oauth2/start` | Top-level navigation target to start a sign-in. |
| `VITE_AUTH_LOGOUT_URL` | `/oauth2/sign_out` | Sign-out route. Empty hides the affordance. |
| `VITE_AUTH_IDENTITY_CLAIM` | *(probe)* | Claim holding the viewer's stable id. |
| `VITE_AUTH_DISPLAY_CLAIM` | *(probe)* | Claim holding the display name. |

### Pin `VITE_AUTH_IDENTITY_CLAIM` before you accumulate data

The identity claim becomes the `owner` on every control-plane document (ADR-0032). **Changing it
later orphans every saved view and workflow draft in the deployment**, because ownership matches
by exact string.

The default probe order is `preferredUsername` → `upn` → `edipi` → `sub` → `user`. **`email` is
deliberately excluded**: addresses change, and a changed address silently orphans that user's
documents. If no candidate claim is present the app shows "Sign-in unavailable" and names the
fix, rather than guessing — a silent fallback to `email` is the worst outcome available here.

Set the claim explicitly for any deployment you intend to keep.

## Nav composition config (issue #18, R3.1)

The nav derives every collection from introspection (derive-all), then applies a **nav
config**: a control-plane `config/nav` document (versioned envelope, like `config/workflows`),
falling back to the `VITE_NAV` env var. The config is data — `{ "order": [...], "labels":
{id: label}, "hide": [...], "defaultCollection": id }` (`src/nav/config.ts`). Without config,
the only change from pure derive-all is that Aperture's own control-plane document collection
is hidden from browse; listing it in `order` opts it back in. Hidden collections stay
deep-linkable (hidden ≠ inaccessible), and config referencing unknown collection ids is
surfaced in the nav, never swallowed (ADR-0029).

## External cross-link config (ADR-0015)

The detail view renders a field as an external link when a **cross-link template** names it:
a control-plane `config/xrefs` document (versioned envelope, like `config/nav`), falling back
to the `VITE_XREFS` env var. The config is data — `{ "<field>": "https://…/{value}" }`
(`src/config/xrefs.ts`); each template must be an absolute http(s) URL containing the
`{value}` placeholder, which is replaced with the URL-encoded field value. An invalid
document falls back to the env config and the error is shown on the detail view (ADR-0029).

## Layout (current)

```
web/
├── index.html
├── src/
│   ├── main.tsx                  # entry (fonts, nuqs adapter)
│   ├── App.tsx                   # composition: provider + shell + slot bindings
│   ├── shell/                    # step 0.1a — layout library (ADR-0031)
│   │   ├── slots.ts              # typed named-slot contract
│   │   ├── registry.ts           # layout registry (one entry: headerNavMain)
│   │   ├── AppShell.tsx          # config selects layout; honest degradation
│   │   └── layouts/HeaderNavMain.tsx
│   ├── data/                     # steps 0.2–0.4, 0.7 — the Layer-D data spine
│   │   ├── endpoint.ts           # VITE_HIPPO_GRAPHQL_URL → EndpointConfig
│   │   ├── scopedClient.ts       # capability-scoped client seam (urql pass-through)
│   │   ├── introspection.ts      # standard __schema baseline
│   │   ├── schemaModel.ts        # collections + column models + Capabilities derivation
│   │   ├── hippoSource.ts        # the source adapter (ADR-0017)
│   │   └── DataSourceContext.tsx # useDataSource() / useCapabilities() (ADR-0029)
│   ├── features/collections/     # nav, table, facets, detail, export, URL state
│   ├── styles/                   # tokens.css (from design/design-tokens.md) + global.css
│   └── test/setup.ts             # jest-dom matchers for Vitest
└── (config: vite / tsconfig / eslint / prettier)
```

## Notes

- **Design tokens** live in `src/styles/tokens.css`, extracted from the Claude Design export.
  A dark theme (`[data-theme='dark']`) is a follow-on.
- **Fonts:** IBM Plex Sans/Mono are self-hosted via `@fontsource` imports in `main.tsx`
  (the design export loaded them from Google Fonts — not carried over).
- **Capabilities are negotiated, never faked (ADR-0029):** every flag derives from what the
  endpoint's introspection actually advertises. Sort/aggregation stay off until Hippo X1 lands;
  the pager hides entirely when offset pagination isn't advertised.
- **Hippo enrichment:** `hippoSchema` presence is detected as a capability; the richer
  enrichment query (slot kinds beyond GraphQL types) is a Phase-1 follow-on to confirm against
  a live `hippo serve`.
- **Sort + facet counts:** deliberately absent until Hippo X1 (aggregation) advertises them —
  the UI never fakes a count or a server sort (ADR-0029).
- **External xrefs:** `src/config/xrefs.ts` maps field names to URL templates per deployment;
  empty by default.
- **Write loop:** entry points gate on derived mutation paths (`New <Type>` needs a
  create-shaped mutation, `Edit` an update-shaped one). Updates are partial-merge; clearing a
  field to null is a later affordance. Field attribution of server rejections is heuristic
  until Hippo's structured `ValidationResult` shape over GraphQL is confirmed.
- **Next:** Phase 3 — the Tier-1 guided workflow (stage → whole-set validate → atomic commit
  via Hippo's batch unit-of-work); see issue #8.
