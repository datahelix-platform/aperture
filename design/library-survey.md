# Aperture — Implementation Library & Package Survey (2026-06-25)

**Status:** 🟢 Research findings. Companion to [`prior-art.md`](./prior-art.md) and
[`gen3-comparison.md`](./gen3-comparison.md) — those survey **whole-product prior art** (Gen3,
Vega-Lite, Grafana, Observable, react-admin); this surveys **concrete implementation
libraries** we could adopt or learn from, at the package level, with **multi-step workflows**
as the centerpiece. Informs — does not override — the ADRs.

**Provenance:** deep-research harness, 2026-06-25. 5 search angles → 25 sources fetched → 77
claims extracted → 25 adversarially verified (3-vote; **24 confirmed, 1 killed**). All
confirmed findings rest on **primary sources** (GitHub repos, npm, official docs). Version/star
facts are accurate as of the survey date and **will drift**. ⚠️ Several requested angles
produced **no verified claims this round** — they are flagged *Not covered* below and remain open
(don't read absence as a negative verdict).

---

## Build-vs-adopt summary (per component area)

| Area | Verdict | Lead pick | Why / caveat |
|---|---|---|---|
| Schema → form + wizard | **ADOPT** | **JSONForms** (EclipseSource, MIT) | Form *and* stepper-wizard are **serializable JSON** (schema + UI-schema) — the only surveyed lib whose wizard definition is config-as-data. RJSF / Formily are alternates. |
| Workflow-as-config model | **STEAL pattern** | **CNCF Serverless Workflow DSL** | Best serializable declarative workflow DSL (switch/listen/emit/for). A *server orchestration* DSL, not a UI-form-flow spec → steal the model, don't adopt wholesale. |
| Wizard runtime engine | **ADOPT (as interpreter target)** | **XState** (MIT) | Mature statechart engine; hierarchical/parallel/**history** states map to multi-step/branching/resume. ⚠️ **code-not-data** — we interpret *our* config and drive XState; XState machines are **not** our serialization format. |
| Data grid | **ADOPT** | **TanStack Table** (headless, MIT) | Headless + framework-agnostic core → fits "view-description" render layer, no framework lock-in. |
| URL / query-state | **ADOPT** | **nuqs** (MIT) | Type-safe URL search-param state → shareable facet/grid state (R3.9). ⚠️ React-oriented; pattern transfers if we're not React. |
| Client-side aggregation | **ADOPT (capability-gated)** | **FINOS Perspective** (Apache-2.0) | Arrow + WASM pivot/aggregation engine; runs in a worker. Softens the **X1 facet-count gap** *for data the client holds* — trades a capability gap for a **data-volume** gap, still gate it. |
| Introspection-driven binding | **BUILD** | — (greenfield) | Codegen-time introspection tools (urql-introspection) are **schema-coupled at build time**, not runtime-generic. Our generic-over-any-endpoint binding is ours to build. |
| Component sandbox runtime | **ADOPT (libraries), BUILD (the seam)** | Comlink + SES/Endo | *Extracted, not yet adversarially verified — see ⚠️ below.* |

---

## Detailed findings

### 1. Schema → form + wizard generation

- **JSONForms** ⭐ — *EclipseSource · MIT · v3.8.0 (2026-06-16) · ~2.7k★ · 72 releases · React/Angular/Vue.*
  Generates forms from a **JSON Schema (data shape) + a separate UI Schema (layout)**, both
  serializable JSON. A wizard is a UI-Schema layout of `type: "Categorization"` (an `elements`
  array of `Category` = steps) with stepper behavior via `options: {variant: "stepper",
  showNavButtons: true}`. **This is the only surveyed library whose *wizard* is config-as-data**,
  matching L3/L4 and the config-as-LinkML-data invariant. **Gap:** custom renderers/widgets are
  framework *code* — the form definition is data, but bespoke widgets need a code escape hatch
  (consistent with our typed-component-as-escape-hatch model, ADR-0010/0011).
- **RJSF (react-jsonschema-form)** — *rjsf-team · Apache-2.0 · v6.6.2 (2026-06-06) · 15.8k★.*
  Declarative React forms from JSON Schema + `uiSchema` (serializable, named-widget
  registration). **Gap:** React-only; custom widgets are code. Solid alternate if we commit to React.
- **Formily** — *Alibaba · v2.3.6 (2025-05-15).* JSON Schema / JSchema (inter-convertible) +
  a **Form Builder**; strong **reactive conditional/dependent-field** linkages
  (`onFieldReact`/`onFieldValueChange`, MobX-like reactivity) — the best surveyed answer for
  dependent fields (W4 forms). **Gap:** its JSChema also has a non-serializable JSX/Markup form;
  only the JSON-Schema paradigm is config-as-data.
- **Already covered (delta only):** **DataHarmonizer** remains the LinkML-native reference
  (binding-from-annotations), but is an offline spreadsheet editor — see `prior-art.md`.

**Implication for Step 4 (W4.1–W4.2):** strongest validation yet that schema-derived *and
serializable* forms are off-the-shelf viable. JSONForms' schema+UI-schema split maps cleanly
onto our LinkML-schema (data shape) + view-description (layout) separation. Conditional fields
(Formily) and ref-pickers (W4.5) are the differentiators to evaluate in a spike.

### 2. Workflow — the multi-step component (deepest angle)

- **CNCF Serverless Workflow DSL** ⭐ (steal, don't adopt) — *serializable JSON/YAML; stable
  v1.0.0 (2025-01-27); ~900★.* Declarative workflow language with normative `switch`
  (branching), `listen`/`emit` (events), `for` (looping), JQ expressions. **Best serializable
  workflow-as-config prior art** — the conceptual template for modeling our steps + per-step
  validation + drafts **as data**. **Caveat:** a *server orchestration* DSL with modest
  adoption, **not** a UI-form-flow spec → steal the model (declarative step graph as data),
  pair it with JSONForms for per-step form rendering.
- **XState** ⭐ (runtime engine) — *Stately.ai · MIT · v5.32.2 (2026-06-23) · framework-agnostic,
  zero-dep core · very active.* Hierarchical + parallel + **history** states → directly model
  multi-step/branching wizards and **returning to / resuming prior steps**. Ideal as the wizard
  **execution engine inside the worker**. ⚠️ **Critical distinction:** XState machines are
  authored in **code, not serializable JSON**. To honor config-as-data we **interpret our own
  serialized workflow config** and drive an XState (or hand-rolled) interpreter — XState is the
  *engine*, not the *config format*. Do not conflate "good wizard runtime" with "satisfies
  config-as-data."
- **robot3** — *single-maintainer · BSD-2-Clause · react-robot@1.2.1 (2025-11-28) · ~2.2k★.*
  Smaller functional/immutable FSM. Same **code-not-data** limitation as XState, plus
  **single-maintainer risk** → weaker fit for a load-bearing component.
- **Zag.js** — *chakra-ui · headless FSM-driven UI machines.* Headless aligns with avoiding DOM
  coupling, **but** it emits **prop-getters onto a consumer's own DOM**, not a serializable
  view-description → fails the Vega-style emit-a-description constraint (ADR-0009). *(The narrower
  claim that Zag is "too low-level for wizards" was **refuted 0-3** — scope isn't the
  disqualifier; the prop-getter-not-description mismatch is.)*
- **Demonstrated composition pattern:** XState + a form lib (Formik/Yup in the cited example) is
  an established multi-step-wizard recipe (per-step validation, step transitions). For us:
  **XState (engine) + JSONForms (per-step form) + our config interpreter (the data layer).**

**Not covered this round (no verified claims — still open):**
- **Saga / compensation patterns** for multi-entity writes when the backend has only per-entity
  transactions. ← directly the **Step-4 atomicity question (W4.7)**. **✅ Resolved** in a focused
  follow-up pass (2026-06-25): saga *orchestration + compensation via supersede/availability-flip*,
  hand-rolled in our workflow interpreter (no load-bearing TS saga lib). See
  [`portal-requirements.md`](./portal-requirements.md) §Step 4 "Research basis" and decisions
  L9/L10.
- **Durable/server-side engines as prior art** (Temporal, Camunda/Zeebe+BPMN, Conductor,
  Prefect, Airflow, Windmill, n8n, Argo). Worth a focused follow-up for conceptual lessons.
- **Declarative form-flow specs** beyond Serverless Workflow (BPMN/DMN, SurveyJS, Form.io).

### 3. Data grid + faceted browse + URL/query-state

- **TanStack Table** ⭐ — *headless; framework-agnostic core (React/Vue/Solid/Svelte/Angular/Lit/Qwik
  adapters); v8.* Sorting, filtering, grouping/aggregation, selection, expansion with **no
  built-in markup/styles** — consumer renders. Fits the description-driven render layer and avoids
  framework lock-in. Strong pick for the browse/grid surface (R3.2/R3.5).
- **nuqs** ⭐ — *47ng · ~10.6k★ · 1M+ weekly downloads (Sentry/Supabase/Vercel/Clerk) · recent
  releases.* Type-safe **URL search-param state** ("useState stored in the URL") → inherently
  shareable/bookmarkable → directly enables **R3.9 (query-state ⇄ URL)**. ⚠️ React-oriented; the
  *pattern* transfers even if we aren't React.
- *(AG Grid, MUI Data Grid, Glide, dedicated faceted-search UI libs — not verified this round.)*

### 4. GraphQL client + introspection-driven binding — **greenfield (BUILD)**

- **urql-introspection** (the surveyed introspection tool) only minifies a `__schema` result into
  a static client-schema artifact for urql Graphcache — a **build-time graphql-codegen plugin
  coupled to one fixed schema**, **not** a runtime component adapting to any introspected
  endpoint. **Verdict: BUILD.** Aperture's "generic over any LinkML+GraphQL endpoint **at
  runtime**" requirement (Layer D, ADR-0002/0017) is not served by codegen-time tooling — consume
  `__schema` (or Mosaic's `mosaicSchema`) **live at runtime**. Reconfirms the `prior-art.md`
  finding: derived runtime binding is our novel bet.
- *(Apollo vs urql vs Relay vs graphql-request comparison for the live-introspection client —
  not verified this round; open question.)*

### 5. Client-side aggregation (the X1 facet-count gap)

- **FINOS Perspective** ⭐ — *FINOS/Linux Foundation · Apache-2.0.* Streaming pivot/aggregation +
  grid + charts; engine in **C++/Rust → WebAssembly**, runs in-browser (worker-friendly). Uses
  **Apache Arrow** + a columnar expression language (ExprTK); **pluggable Data Model API**
  (in-browser WASM *or* remote engine, and can translate view configs into native queries against
  e.g. DuckDB). **Fit:** the WASM engine fits the worker sandbox (architecture Layer C/D, the
  "DuckDB-WASM-as-adapter-compensation" role) and gives **real** aggregation — never a faked facet
  count over a partial page (honors **L7**). ⚠️ **Caveat:** client aggregation only sees data the
  client *has* → it trades a capability gap for a **data-volume** gap, which must **still be
  capability-gated**. Gen3's lesson stands: facet counts *at scale* want the server index (X1),
  not client compute.
- **DuckDB-WASM** (⚠️ extracted, **not** verified): browser WASM memory is **capped per tab (~4GB
  in Chrome)** → a hard ceiling on client-side dataset size / non-trivial joins. Reinforces:
  client aggregation is a small-/mid-scale compensation, not the X1 answer.
- *(Arquero, Arrow JS, Polars-WASM — not verified this round.)*

### 6. Component sandbox runtime ⚠️ *(extracted, NOT adversarially verified — treat as leads)*

These came from primary-source fetches but were dropped from final verification by the round's
budget; do not cite as confirmed without a follow-up pass.

- **Comlink** (GoogleChromeLabs) — RPC over `postMessage` + ES6 Proxies; lets the main thread call
  a Worker's exposed object as if local, with transferable/proxy passing. Natural fit for the
  **capability-scoped data client injected across the Worker boundary** (ADR-0008/0011) — pass the
  scoped client in as a Comlink proxy, no ambient network.
- **SES / Hardened JS (Agoric Endo)** — `lockdown()`, `harden()`, `Compartment` APIs to confine
  untrusted JS. Candidate for **in-Worker** hardening of component code (defense-in-depth *inside*
  the Worker boundary the architecture already mandates).
- **Verdict (provisional):** **adopt the libraries** (Comlink for the RPC seam, SES/Endo for
  in-Worker hardening) but **build the capability-scoped seam itself** — `prior-art.md` already
  found no prior art that scopes *data authority* per viewer at the sandbox boundary; that remains
  our differentiator and our risk.

### 7. Admin / low-code re-evaluation — **Not covered this round**

Refine, Directus, PostGraphile, Hasura DDN v3, Retool/Budibase/Appsmith/ToolJet, Forest Admin,
Strapi, Amplication produced **no verified claims** this round. The key question — *does any
consume GraphQL introspection to emit **serializable config (not code)**, and does any have a
serializable workflow model worth stealing?* — is **still open** (it was also a `prior-art.md`
coverage gap). Recommended as the next focused search.

---

## How this lands against the locked decisions

| Touches | Library finding | Effect |
|---|---|---|
| **L3/L4, R-W (Step 4 forms)** | JSONForms (wizard-as-data), Formily (conditional fields) | De-risks schema-derived **serializable** forms + wizard — off-the-shelf viable; spike candidate. |
| **L4, W4.6 (workflow component)** | Serverless Workflow (model) + XState (engine) + JSONForms (steps) | Concrete build recipe: interpret *our* workflow config; XState is engine not format. |
| **W4.7 (atomicity)** | saga/compensation **Not covered** | Step-4 atomicity stays a **design decision**; schedule the focused follow-up. |
| **L7, X1 (facet counts)** | Perspective (client agg) + DuckDB-WASM cap | Client-agg is a **gated small-scale** compensation; X1 server index still the at-scale answer. |
| **R3.9 (query ⇄ URL)** | nuqs | Direct off-the-shelf fit. |
| **Layer D (ADR-0002/0017)** | introspection tools are build-time only | **Confirms BUILD** for runtime generic binding. |
| **ADR-0008/0011 (sandbox)** | Comlink + SES/Endo (leads) | Adopt libs for the seam; **build** the capability scoping. |

---

## Recommended follow-ups (ordered)

1. **Focused workflow-engine + saga search** — durable engines (Temporal/Camunda/Conductor) +
   compensation patterns, aimed squarely at the **W4.7 atomicity** decision. *(Highest value —
   it unblocks the paused Step 4.)*
2. **Admin/low-code re-eval** (angle #7) — the standing coverage gap from both surveys.
3. **GraphQL-client comparison** for **runtime** live-introspection binding (Apollo/urql/Relay).
4. **Verify the sandbox leads** (Comlink/SES-Endo/QuickJS/Pyodide) in a proper adversarial pass.
5. **Spike:** JSONForms + XState + a hand-rolled config interpreter on a real LinkML type, to
   pressure-test "interpret our config, drive the engine" vs. authoring engine code.

## Sources (primary, verified unless noted)

- Workflow: `github.com/statelyai/xstate`, `github.com/matthewp/robot`, `zagjs.com` /
  `github.com/chakra-ui/zag`, `serverlessworkflow.io` / `github.com/serverlessworkflow/specification`,
  `github.com/TheWidlarzGroup/multistep-form-xstate-formik` (secondary)
- Forms: `github.com/eclipsesource/jsonforms`, `jsonforms.io/examples/categorization`,
  `github.com/rjsf-team/react-jsonschema-form`, `github.com/alibaba/formily`
- Grid/URL: `github.com/TanStack/table`, `nuqs.dev` / `github.com/47ng/nuqs`
- GraphQL binding: `the-guild.dev/graphql/codegen/plugins/other/urql-introspection`
- Aggregation: `github.com/finos/perspective`; DuckDB-WASM (`duckdb.org/2021/10/29/duckdb-wasm`,
  blog — *unverified*)
- Sandbox (*extracted, unverified*): `github.com/GoogleChromeLabs/comlink`, `github.com/endojs/endo`
