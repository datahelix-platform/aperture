# Aperture — Prior-Art Survey (2026-06-16)

> **Companion:** [`library-survey.md`](./library-survey.md) (2026-06-25) takes this down to the
> **implementation-package** altitude — concrete libraries (JSONForms, XState, Serverless
> Workflow, TanStack Table, nuqs, Perspective) with maturity/license/fit-gap and build-vs-adopt
> verdicts, deepest on the multi-step **workflow** component.


**Status:** 🟢 Research findings (verified). Deep-research harness: 5 angles, 24 sources
fetched, 91 claims extracted, 25 verified by 3-vote adversarial check (25 confirmed, 0 killed;
mostly primary sources). Informs — does not override — the ADRs.

## Verdict: BUILD (genuinely greenfield)

**No surveyed tool unifies Aperture's pillars** — config-as-data + GraphQL-introspection-driven
binding + a typed serializable noun-catalog view vocabulary + a capability-scoped Web-Worker
component sandbox + LLM/agent-editable config. The prior art splits on two axes, and nothing
spans both (let alone the sandbox + agent pillars):

- **(a) Config-driven scientific portals** — Gen3, DataBiosphere. Real schema-derived faceted
  UIs, but bespoke REST/Elasticsearch backends, no Worker sandbox, no agent editing.
- **(b) Declarative spec-as-data viz/dashboard grammars** — Vega/Vega-Lite, Grafana JSON. The
  canonical models for a serializable, growable, typed view vocabulary, but no schema-binding
  or data-portal layer.

**Recommendation: build, reusing patterns piecemeal.** Prototype the config/binding layer
against Gen3's validation model + Hippo introspection; prototype the view layer against
Vega-Lite's compiler + view-algebra; treat Grafana's frontend sandbox as a *cautionary tale*,
not a foundation.

## Closest matches — fit / gap

| Tool | What it proves | Gap vs Aperture |
|---|---|---|
| **Gen3 Data Explorer** ⭐ | Faceted UI driven by a **serializable JSON config** (`gitops.json`/`explorerConfig`: filters/tabs/charts/table blocks) **validated so only properties in the backend ETL mapping + Data Dictionary can be surfaced** — real config-as-data + schema-derived binding, = our L1 composition + L2 binding split | Validation is **CI-time tooling** (gen3utils), not structural; backend is bespoke Guppy/Elasticsearch, **not an introspectable GraphQL transport** |
| **DataBiosphere/data-browser** | One Next.js codebase → many portals (AnVIL, HCA, LungMAP) via per-site config — **multi-portal-from-config is proven** | Config is **TypeScript *code*** (imports live React components/builders), **not serializable data**; REST/Azul backend. A *counter-example* that validates our config-as-LinkML-data choice |
| **ra-data-graphql / react-admin** | Runtime **GraphQL introspection** data provider is an established pattern | Maintainer: runtime introspection **unsuitable for production** (often disabled for security); binding is **coded** in a `buildQuery` adapter, **not derived** from schema |
| **DataHarmonizer** | **LinkML-native** UI generated from schema annotations (columns/picklists/validation from `range`/`enum`/`title`/`slot_group`; surfaced via `is_a: dh_interface`) — validates **binding-from-annotations** | Offline **spreadsheet editor** (xlsx/csv import/export); **no GraphQL**; compiles LinkML → templates, not → a live transport |
| **Vega-Lite** ⭐ | Template for a serializable, typed, **growable** noun-catalog without a bloated DSL: a **closed view algebra** (layer/concat/facet/repeat) + a **smart-defaults compiler** that absorbs complexity; cleanly separates *what to show* (declarative) from *how to compute* (compiler/runtime) | Pure viz layer — no schema binding, no data-portal, no security |
| **Vega** | "View-description is **self-contained JSON parsed by a separate runtime**" — exactly our emit-spec/render-elsewhere split | (same — viz only) |
| **Grafana dashboard-spec** | Dashboard-as-data with a **typed schema** works and is battle-tested | The externalized spec repo was **deprecated and reabsorbed into the runtime** → keep config schema **co-evolving with the runtime that consumes it** (validates config-in-Hippo) |
| **Grafana Plugin Frontend Sandbox** | Closest frontend-component-sandbox prior art | **Same-thread Proxy/realm membrane** (not Worker/iframe/WASM); **coarse isolation only — prevents UI/global interference but does NOT scope data-access authority.** Public-preview, off by default, excludes Angular/signed plugins — **unproven** |
| **Observable runtime** | Strongest model for "**components emit values, never touch the DOM**": `variable.define(name, inputs, def)` with explicit deps + headless observers that render | **No security sandbox / capability scoping** — that part is Aperture's to add via the Worker boundary |

## Design lessons mapped to our decisions

- **Config-as-LinkML-data (ADR-0003):** *strongly validated.* Gen3 proves config-as-data with
  schema-validated binding; DataBiosphere's TS-code config is the bloat/agent-hostile
  counter-example; Grafana's externalized-spec reabsorption says **keep config co-evolving with
  the runtime** — i.e. config-as-LinkML-*in-Hippo* is the right instinct.
- **Derived binding from schema annotations:** **this is our novel bet — nobody surveyed
  auto-derives GraphQL binding from schema.** GraphQL providers *code* binding (`buildQuery`);
  DataHarmonizer derives UI from LinkML annotations but only offline. → **De-risk with a Hippo
  introspection → derived-binding prototype**, and **do not depend on live standard `__schema`
  in production** (commonly gated); Mosaic's *custom* `mosaicSchema` query sidesteps this if it
  can be auth-gated rather than disabled.
- **Noun-catalog view vocabulary (ADR-0010):** Vega-Lite is the **design template** — a closed
  set of typed primitives + a smart-defaults compiler is exactly how to grow the catalog
  (table/faceted-list/KM-curve/heatmap) **without** a middle scripting layer (ADR-0004). Its
  layer/facet/repeat algebra models view composition; its noun-vs-verb split validates pushing
  computation to the GraphQL query layer.
- **View-description-not-DOM (ADR-0009):** validated by Vega (serializable spec + separate
  runtime) and Observable (emit-values-to-observer, explicit-dependency recompute).
- **Worker sandbox + capability-scoped client (ADR-0008, ADR-0011):** Grafana's sandbox is the
  closest prior art **and the key cautionary tale** — it stops the DOM-tampering/ambient-UI
  trap but **does not scope data authority per viewer.** Our Worker boundary + injected
  **capability-scoped data client** is a **genuine advance and our core differentiator** — but
  it is **unproven prior art** (nobody does it), so it carries real design risk.
- **Capability-negotiated adapter (architecture Layer D):** **no prior art** — no surveyed tool
  gates UI features by negotiated GraphQL source capability. **Design from first principles.**
- **Agent-editable config (ADR-0018, ADR-0021):** **zero verified prior art surfaced** for
  agent-driven editing of config-as-data via MCP with dry-run + user-authority. Consistent with
  being novel, but **unconfirmed** — leads worth a follow-up: A2UI (`a2ui.org`, "AI agent for
  UI"), Retool 2025 AI features, "Grafana dashboards via AI CLI."

## Caveats & coverage gaps (absence ≠ evidence)

- **No surviving verified claims** for several area-1 frameworks (**Refine, Directus,
  PostGraphile, Retool/Appsmith/Budibase/ToolJet, Forest Admin, Strapi, Amplication**) or
  several area-4 portals (**cBioPortal, OHDSI ATLAS, i2b2/tranSMART, Beacon v2, CZ CELLxGENE,
  HuBMAP**). Their absence here is *not* a finding about them.
- **GraphQL introspection-disabled-in-prod is configurable**, not absolute — Hasura/PostGraphile
  can gate it behind auth. Design for both gated and open.
- **Grafana's sandbox is public-preview** (>=11.5, Jan 2025), not a hardened boundary; weaker
  than our intended Worker boundary.
- Current Grafana schema work (CUE/kindsys/K8s-style kinds, V2) was **not** deeply surveyed —
  may hold fresher dashboard-as-data lessons.

## Recommended follow-ups

1. **De-risk the novel bet:** prototype Mosaic `mosaicSchema` introspection → **derived binding**
   (the thing nobody has done) — directly feeds core-loop Step 2/3.
2. **Prototype config validation** against **Gen3's `gitops.json` model** (config-as-data
   validated against the backend schema), translated to LinkML-validated config.
3. **Prototype the view layer** against **Vega-Lite's compiler + view-algebra** as the
   noun-catalog reference.
4. **Dedicated follow-up search** on agent-editable config-as-data (A2UI / MCP-over-config) —
   the one pillar with no verified prior art.
5. **Quick prototype-fit eval** of the unsurveyed frameworks (esp. **Refine, Directus,
   PostGraphile, Hasura DDN v3**) for whether any consumes GraphQL introspection to emit
   serializable config (not code).

## Sources (verified, primary unless noted)

- Gen3: `docs.gen3.org/.../customize-search/`, `github.com/uc-cdis/data-portal` (portal_config), `github.com/uc-cdis/gen3utils`
- DataBiosphere: `github.com/DataBiosphere/data-browser`, `github.com/DataBiosphere/azul`
- react-admin GraphQL: `github.com/marmelab/react-admin` (ra-data-graphql README; issue #6639); Hasura introspection docs
- DataHarmonizer: `github.com/cidgoh/DataHarmonizer`; `linkml.io/linkml/generators/`
- Vega-Lite: `idl.cs.washington.edu/files/2017-VegaLite-InfoVis.pdf`; Vega: `vega.github.io/vega/`
- Grafana: `github.com/grafana/dashboard-spec`; frontend-sandbox docs + 2025-01-14 what's-new
- Observable: `github.com/observablehq/runtime`
- Agent-UI leads (unverified): `a2ui.org`, Grid Dynamics A2UI blog, Retool 2025 features, Quesma "Grafana dashboards via AI CLI"
