# Aperture — Portal Requirements (portal-first track)

**Status:** 🟠 Working — co-designed incrementally, one step at a time. Last updated 2026-06-25.

This document captures the **requirements for Aperture as a data portal**, under the
**portal-first, agent-aware** pivot (2026-06-25): the config-driven portal is the *product* and
the v1 deliverable; the AI-native explorer ([`vision.md`](./vision.md)) remains the north star but
its agentic stack is **deferred, not retired**. The typed/validatable substrate invariants are
kept deliberately so an agent layer can be added later without re-architecting.

Decisions here will be promoted to **ADRs** (status updates + new ADRs) once a cluster is stable —
the Decision Log in [`INDEX.md`](./INDEX.md) remains the source of truth for *what was decided*.
This doc is the working surface where requirements are drafted and locked step by step.

---

## Locked decisions (this track)

| # | Decision | Date | Becomes / touches |
|---|---|---|---|
| L1 | **Portal-first, agent-aware.** Portal is the product/v1 deliverable. Agentic ADRs (0018–0025) → *Deferred*; substrate invariants preserved so agents can be added later. `vision.md` stays as north star with a portal-first note. | 2026-06-25 | ADR status flips; `vision.md` note |
| L2 | **Pluggable single endpoint.** Source adapter is source-agnostic / capability-negotiated, but v1 talks to exactly **one active data-plane endpoint at a time** (Hippo now; Bridge or a future Cappella gateway later — a config swap, not a refactor). Cross-source **federation is deferred** and may never be needed if Cappella unifies upstream. | 2026-06-25 | Narrows ADR-0017 "N sources" → "one swappable source"; Layer D |
| L3 | **Portal is read *and* write.** Aperture provides schema-derived **data-entry / mutation** UIs, not just browse. Validation is enforced server-side by Hippo's three-tier pipeline (LinkML → CEL → Python plugin); every mutation is transactional with provenance. Aperture generates entry UI from schema + pre-validates client-side for fast feedback. | 2026-06-25 | Re-justifies component system (ADR-0009/0010/0011) for the portal track |
| L4 | **v1 write boundary = Tier 0 + one Tier 1.** v1 ships generated single-entity create/edit **forms** (Tier 0) **and one real guided multi-step workflow** (e.g. tissue banking/processing) as a proof of the component framework (Tier 1). Further workflow components ship in v1.x; agent-driven *runtime* mutation is Tier 2 (deferred). | 2026-06-25 | New keystone probe (see below) |
| L5 | ⛔ **Superseded by L13 (deferred post-MVP).** ~~Embedded schema editing in v1.~~ Aperture is the home for an admin-gated **schema-editing app** (the `linkml-modeler` idea); the schema author is a first-class *in-app* persona, not just upstream. ⚠️ Depends on a **Hippo-side mechanism to accept/apply schema changes** (Hippo recipes v1 is file/recipe-based, no live schema-edit API) — cross-component requirement to pin down (Step 5). | 2026-06-25 | Re-activates actor #5; new Hippo dependency |
| L6 | ⛔ **Superseded by L14 (agent-assist deferred post-MVP; substrate kept).** ~~Agent-assisted component authoring in v1 (build-time only).~~ Tier 1 workflow components & custom views are authored with help from an **external MCP/API coding agent** (per ADR-0021's near-term surface), used by a developer/admin at **build time** — *not* a runtime surface for researchers/wet-lab staff. Re-activates the authoring substrate: typed component contract (ADR-0010/0011), dry-run validation + reversible attributed apply (ADR-0009 + handoff §6), agent-acts-with-user-authority (ADR-0018). Runtime agent (in-app chat, data-stories, conversations-as-provenance, per-user keys) stays deferred. Refines L1. | 2026-06-25 | ADR-0021 (already Accepted); narrows L1's deferral |
| L7 | **Faceting = capability-gated honest degrade.** v1 ships what the active backend advertises (on Hippo today: equality facets + FTS + offset pages). Facet **counts, range filters, sort, `totalCount`** are *declared capabilities* surfaced only when the backend supports them; **the UI never fakes a count** over a partial page. The Hippo aggregation enhancement (X1) is filed as the top cross-component ask to bring counts in v1.x. *(Recommended default; reversible.)* | 2026-06-25 | Layer D capability protocol; Hippo req X1 |
| L8 | **Export = client-side page-through (CSV + JSON).** v1 exports the current filtered result set by paging offset results client-side, to CSV and JSON, over the configured columns. No Hippo dependency. Server-side streamed bulk export (X2) deferred to v1.x if cohort sizes demand it. *(Recommended default; reversible.)* | 2026-06-25 | Hippo req X2 (deferred) |
| L9 | **Workflow atomicity = stage → whole-set dry-run validate → atomic commit** (supersedes the earlier saga-as-default, after the §Step 4 review). A workflow stages its entities in a draft buffer; nothing enters the domain graph until the **whole related set** is validated and then committed **all-or-nothing** via a Hippo batch unit-of-work. This needs a Hippo capability (**X4**, now a committed dependency — [BU-Neuromics/hippo#84](https://github.com/BU-Neuromics/hippo/issues/84)): whole-set dry-run validation + atomic multi-entity write with intra-batch reference resolution. Hippo's storage layer already has the atomic primitive (`staged_transaction()`), so this exposes existing machinery rather than building distributed transactions. **Saga/compensation (the prior L9) is retained only as the fallback** for steps with genuinely irreversible external side-effects (can't be staged). | 2026-06-25→**rev 2026-06-30** | Step 4 W4.6/W4.7; Hippo #84 / req X4 |
| L10 | **Resumable drafts are first-class; the draft is an *inert* control-plane buffer.** In-progress forms & workflow runs persist as **draft state** in the control plane (LinkML-on-Hippo, ADR-0017) — *not* committed domain entities. Because nothing is committed until the atomic pivot (L9), resume is "reload a draft document," with **no** entity-stamping / dual-write / query-before-run reconciliation against the domain graph (the saga-era complexity is gone). The draft **pins the workflow + schema version** it began under, so an admin schema edit (L5) between save and resume is detectable rather than silently breaking. | 2026-06-25→**rev 2026-06-30** | Step 4 W4.6/W4.8; ADR-0017; L5 |
| L11 | ⛔ **Superseded by L13 (deferred post-MVP).** ~~Embedded schema editing in v1 = *additive* authoring via Hippo recipes.~~ The admin-gated editor (L5) lets a schema author **add** entity types, slots, enums, and subclasses (`is_a:`) — packaged as a **recipe** (LinkML fragment + manifest) and applied through Hippo's existing `recipe_import` (live, no-restart, single-transaction, provenance-tracked, dry-run-validatable). **In-place modify / rename / remove of existing schema elements is *not* supported in v1** — Hippo merging is bootstrap/additive-only (invariant 6: upstream `provided_by` elements can't be mutated; override is via subclassing). Breaking edits + data migration ("overlay mode") are gated on Hippo v2 (X3b). *(Recommended default; reversible.)* | 2026-06-30 | Refines L5; Hippo req X3a/X3b |
| L12 | ⛔ **Superseded by L13 (deferred post-MVP).** ~~Apply mechanism = recipe + dry-run preview; the only new Hippo ask is transport exposure.~~ The editor builds a recipe from the edits, runs a **dry-run** to preview/validate, then applies via Hippo's `recipe_import`; the gap is SDK/CLI-only `recipe_import` → **X3a** (transport exposure). *Retained as the design of record for the deferred feature.* | 2026-06-30 (superseded 2026-06-30) | Hippo req X3a (deferred) |
| L13 | **Embedded schema editing is deferred — post-MVP enhancement (supersedes L5/L11/L12).** An in-app schema-editing surface is **not** in the MVP. The MVP delivers read + write loops; schema authoring continues **upstream via Hippo's SDK/CLI `recipe_import`** for MVP. The worked-out design (Step 4b, L11/L12, S4b.1–S4b.9) is retained as the design of record and tracked in **[datahelix-platform/aperture#2](https://github.com/datahelix-platform/aperture/issues/2)**. Defers actor #5's in-app role and the Hippo deps **X3a/X3b** out of the MVP. | 2026-06-30 | Supersedes L5/L11/L12; defers X3a/X3b; aperture#2 |
| L14 | **Build-time agent-assisted component authoring deferred from MVP (refines/supersedes L6).** MVP components — the Tier-1 workflow (L4, kept in MVP) and any custom views — are **hand-authored** against the typed component contract. The substrate they need stays MVP: the typed component contract (ADR-0010/0011), the Web-Worker sandbox + capability-scoped client (ADR-0008/0011), dry-run validation (ADR-0009), and the view-description runtime. Only the **agent-assist** for authoring (ADR-0021 near-term surface, agent-acts-with-user-authority ADR-0018) recedes to **post-MVP**. | 2026-06-30 | Supersedes L6; ADR-0021/0018 → Deferred |

---

## Step 1 — Scope & Framing  *(locked 2026-06-25)*

### What Aperture is (current track)
A generic, config-driven **data portal** over the DataHelix domain graph. Its first and primary
backend is **Hippo** (via GraphQL); **Bridge** provides auth/authorization when present. The
source endpoint is **pluggable** (one active at a time, L2). The portal supports both **reading**
(browse/search/detail) and **writing** (data entry / guided workflows), with validation enforced
ultimately by the LinkML schema in Hippo.

### What the portal does (the core loop)
- **Read loop:** *browse* the typed entities in a deployment → *search and facet* to narrow a set
  → open an *entity detail* view → *traverse cross-links* (relationships + external references) →
  *export* a result set. All **derived from the LinkML schema** (ADR-0002/0003) — no
  per-deployment hand-coding.
- **Write loop:** *create / edit* an entity via a schema-derived form → client-side pre-validate →
  submit GraphQL mutation → surface the server's `ValidationResult`; or *run a guided workflow*
  component that orchestrates several validated mutations (Tier 1).

### In scope (v1)
- Schema-derived **browse / faceted search / detail** views over the active GraphQL endpoint.
- **Data entry:** generated single-entity create/edit forms (Tier 0), server-validated,
  provenance-tracked.
- **One guided multi-step workflow** component (Tier 1) as a keystone proof.
- Config-driven tailoring of views (ADR-0003/0004/0005), runtime-reloaded behind headless
  validation (ADR-0006/0009).
- Cross-links: internal (resolved relationships) and external (`ExternalReference`) (ADR-0015).
- **Capability-negotiated source adapter** (Layer D) — UI gates features (faceting, full-text,
  pagination style, aggregation, **mutation support**) to what the active backend declares.
- Auth via the **capability-scoped client seam** — no-op full-access pass-through locally
  (incl. writes), Bridge's enforcing client when present (ADR-0008/0016).

### Deferred (agent-aware — substrate kept ready, not built now)
- In-app conversational/agent interaction (ADR-0021).
- Agent-editable config loop; per-user LLM keys; conversations-as-provenance (ADR-0018–0020).
- Data-stories / instruction-path execution (ADR-0022–0025).
- Cross-source **federation** (browsing multiple heterogeneous endpoints at once) (L2).
- **Tier 2** writes (agent-driven mutation, free-form components); **further Tier 1** workflow
  components beyond the v1 proof.

### Out of scope (other components' jobs)
- **Authorization logic** itself — lives in Bridge (PEP/PDP); Aperture stays auth-unaware
  (ADR-0016).
- **Data storage, schema authoring, server-side validation** — Hippo's job. Aperture *generates
  UI from* the schema and *pre-validates*, but the schema is the validation authority.
- **Workflow execution** (pipeline runs) — Cappella's job. Aperture's "workflows" here are
  **data-entry/mutation interfaces**, not compute pipelines.

### Non-goals (this track)
- Not a NotebookLM-style conversational explorer *in this track* (that's the deferred vision).
- Not domain-specific — **generic only** (ADR-0002); no brain-bank nouns in source. The tissue
  banking workflow is a *config/component instance*, not hard-coded.

### Reframed keystone (write track)
With writes in scope, the riskiest open question shifts from "can an LLM drive the view
vocabulary" to: **can a real wet-lab workflow (tissue banking/processing) be expressed as typed
components driving schema-validated mutations through the capability-scoped client?** The v1 Tier 1
workflow (L4) *is* this probe.

---

## Step 2 — Actors & core job-to-be-done  *(locked 2026-06-25)*

Recasts [`actors.md`](./actors.md) for the portal-first track: human operators come forward, the
runtime agent recedes, a **new write persona** is added, and the **schema author** + **build-time
coding agent** become first-class in-app/authoring actors (L5/L6).

### The cast (portal-first)

1. **Researcher (data consumer) — primary *read* user.** Domain expert, not a developer.
   Browses, faceted-searches, opens detail views, follows cross-links, exports cohorts, via the
   **rendered portal UI**. Authority = whatever Bridge grants; full access locally (ADR-0016).
   *(The "direct an agent at runtime" path → deferred.)*
2. **Wet-lab staff (data producer / operator) — primary *write* user. [NEW]** Domain expert, not
   a developer. Enters/updates records via **schema-derived forms** (Tier 0) and runs **guided
   multi-step workflows** (Tier 1, e.g. tissue banking/processing). Needs field-level validation
   feedback, step-by-step guidance, and guardrails (server-side LinkML/CEL validation +
   no-hard-delete). The reason the portal is read *and* write (L3/L4); absent from old `actors.md`.
3. **Admin / portal owner.** Governs a deployment: **endpoint selection** (single active source —
   Hippo now, Bridge/Cappella later, L2), deployment/registry config, component/view **promotion**
   & visibility (ADR-0007), and **schema editing access** (L5). Maps to Bridge `admin`.
4. **Component author — developer/admin, agent-assisted at build time (L6).** Authors Tier 1
   workflow components & custom views as typed validatable artifacts, *with an external MCP/API
   coding agent* (ADR-0021), then promotes (ADR-0007). Build-time role, not a runtime surface.
5. **Schema author / data modeler — ⛔ in-app role DEFERRED post-MVP (L13).** Authors/edits the
   LinkML domain schema everything derives from. For MVP this stays an **upstream** role (Hippo
   SDK/CLI `recipe_import`); the in-app **embedded schema editor** is a tracked future enhancement
   ([aperture#2](https://github.com/datahelix-platform/aperture/issues/2)).
6. **(Boundary) Bridge / permissions owner — deferred.** Roles & enforcement live here, not
   Aperture (ADR-0008/0016). Local = max permissions.
7. **Coding agent — build-time actor (L6), not runtime.** Scaffolds components for authors via
   MCP/API. Acts with the invoking user's authority (ADR-0018). The runtime/in-app agent surface
   stays deferred (ADR-0021).

### Core jobs-to-be-done (the loops)

| Persona | Job | Loop |
|---|---|---|
| Researcher | "Find and extract the data I need" | browse → facet → detail → cross-link → export |
| Wet-lab staff | "Record what happened at the bench, correctly" | pick type/workflow → guided form(s) → pre-validate → submit → confirm |
| Admin | "Stand up and govern a deployment" | configure endpoint + views → validate → promote |
| Schema author | "Evolve the domain model" | ⛔ *post-MVP (L13)* — for MVP: author upstream via Hippo `recipe_import` |
| Component author | "Add a new view/workflow" | scaffold w/ agent → dry-run validate → promote |

Read and write are the two first-class **end-user** loops; the rest are supporting/build-time.

---

## Step 3 — Functional requirements: read loop  *(locked 2026-06-25)*

Grounded in [`prefab/core-loop.md`](./prefab/core-loop.md) and Hippo's GraphQL Query surface
(Hippo sec4 §4.7). Each requirement carries a **capability tag**: **(a)** works on Hippo today ·
**(b)** needs a Hippo enhancement (cross-component requirement, see X-table) · **(c)**
adapter-compensated client-side. Per L7, the capability-negotiated adapter (L2) **gates each
feature to what the active endpoint declares — the UI never fakes a capability** (no client-side
"facet counts" that silently describe only the loaded page).

| Req | Requirement | Tag |
|---|---|---|
| R3.1 | **Collection nav** — derive browsable collections from `hippoSchema`; admin config reorders/relabels/hides (derive-all + override). | (a) |
| R3.2 | **Collection table** — config-curated columns; cell renderers keyed by LinkML slot kind; loading/empty/error states. | (a) |
| R3.3 | **Filtering** — equality facets (enum→checklist, bool, ref-id) with AND/OR; FTS box. | (a) |
| R3.3r | **Range filters** (numeric/date facets). | (b) |
| R3.4 | **Facet counts** — counts beside facet values (the keystone gap; L7). | (b) |
| R3.5 | **Sort** — server `order_by`. Interim: client-sort current page only, clearly scoped. | (b)/(c) |
| R3.6 | **Pagination + count** — offset pages (a); `totalCount` (b); interim "page N, 25+/page" (c). | (a)/(b)/(c) |
| R3.7 | **Detail view** — single entity, typed renderers, history via `entityHistory`. | (a) |
| R3.8 | **Cross-links** — internal via resolved relationship fields; external via `ExternalID` + xref; relationship **pivot** (jump to related collection, filtered). | (a) |
| R3.9 | **Query state ⇄ URL** — serializable query-state object (collection+filters+sort+page) bound to the URL → shareable. Aperture-side; precursor to saved views & view-description-as-data (ADR-0009/0010). | (a) |
| R3.10 | **Export** — client-side page-through of the filtered set → CSV + JSON over configured columns (L8). | (a) |

**Degradation rules (from v0.1 Hippo adapter):** multivalued slots return `[]` (render as
"not available," not error); `isAvailable` always `true` on reads (availability columns/filters
moot for now); no relationship-count fields (`#samples` omitted until aggregation exists, X1).

---

## Step 4 — Functional requirements: write loop  *(locked 2026-06-25)*

Grounded in L3/L4 (read+write portal; v1 write boundary = Tier 0 forms + one Tier 1 workflow),
the implementation library survey ([`library-survey.md`](./library-survey.md)), and the
workflow-atomicity prior-art pass (saga/compensation, BPMN, durable engines — see the **Research
basis** note below). Capability tags as in Step 3: **(a)** Hippo today · **(b)** Hippo
enhancement · **(c)** Aperture-side.

### Tier 0 — generated single-entity forms

| Req | Requirement | Tag |
|---|---|---|
| W4.1 | **Form generation** — derive a create/edit form from a type's LinkML slots (mirror of the detail view): widget per slot kind (enum→select, bool→checkbox, ref→entity-picker, scalar→typed input, date→date-picker); `required`/`ifabsent` honored. Form definition is **serializable** (schema + UI-schema split, JSONForms-style — see survey). | (a) |
| W4.2 | **Client pre-validation** — fast feedback from the LinkML shape rules (required, pattern, range, enum) *before* submit; **server stays the validation authority** (Hippo LinkML→CEL→plugin). UI surfaces the server `ValidationResult` (field-attributed) on rejection. | (a) |
| W4.3 | **Submit** — `createX`/`updateX` mutation; `updateX` is partial-merge; provenance is server-tagged. | (a) |
| W4.4 | **Edit semantics** — no hard delete; availability transitions via `setXAvailability`; supersede via `supersedeX`. | (a) |
| W4.5 | **Relationship ref-pickers** — relationship slots resolved via a searchable picker reusing the read-loop search/facet. | (a) |
| W4.x | **Conditional/dependent fields** — show/require slots based on other field values (Formily-style reactive linkage is the survey reference). | (a)/(c) |

### Tier 1 — one guided multi-step workflow component (keystone proof)

| Req | Requirement | Tag |
|---|---|---|
| W4.6 | **Workflow component = staged unit-of-work (L9).** A typed component sequences several entity mutations as steps (e.g. register donor → accession sample → record processing) with cross-step state and per-step validation, **staging** entities in a draft buffer. Built as: **our serialized workflow config** (steps-as-data; CNCF Serverless Workflow is the model to steal) interpreted by an **engine** (XState is the reference runtime — engine, *not* the config format) rendering each step's form via the Tier-0 generator. Emits view-descriptions (ADR-0009); holds no authority (ADR-0008); authored build-time with agent assist (L6). | (a)+(c) |
| W4.7 | **Atomicity via stage→validate→commit (L9).** Continuous per-step dry-run for fast feedback; a **whole-set dry-run** over the staged graph before commit; then **one atomic multi-entity commit** (Hippo #84 / X4). Nothing enters the domain graph until the set is valid and complete → no partial run is ever visible (no semantic-lock juggling needed). Compensation is the **fallback** only for irreversible-side-effect steps. | (b: Hippo #84) |
| W4.8 | **Resumable drafts (L10).** Workflow runs (and long single forms) persist as an **inert** control-plane draft buffer (not committed entities); stop/resume = reload the draft. Draft pins workflow+schema version (L5 drift detection). No entity-stamping/idempotency-reconciliation needed (it was a saga-era cost, now removed). | (a)+(c) |
| W4.9 | **Cross-entity validation** — steps depending on prior entities; CEL/cross-entity rules enforced **server-side per mutation** (Aperture pre-checks for UX only). | (a) |

### Research basis — workflow atomicity (W4.6–W4.9)

Targeted prior-art pass (2026-06-25, web search; several primary pages returned HTTP 403 to
direct fetch — proxy behavior — so findings are synthesized from search-result extracts of those
same primary sources, as the prior survey did):

- **Saga is the standard answer** to a multi-step business transaction across stores **without** a
  distributed transaction: a sequence of local transactions, each with a **compensating
  transaction** that semantically undoes a prior step on failure (microservices.io; AWS
  Prescriptive Guidance; Temporal). **Orchestration** (central coordinator triggers compensations)
  is recommended **over choreography** for *complex workflows with rollback needs* — matching our
  guided-workflow shape. → **chooses option A+C over B.**
- **Compensation = inverse op, not delete.** Saga compensation is a *semantic* reversal; with a
  no-hard-delete store, that is exactly **supersede / mark-unavailable**. Hippo's existing
  availability-transition + supersede + provenance log are a clean, attributed compensation
  substrate. → **confirms C is cheap on Hippo as-is; no new Hippo capability needed.**
- **Durable engines as prior art:** definition form splits — **Temporal = code**, **Conductor =
  JSON DSL**, **Zeebe = BPMN**. Temporal's **event-sourced durable resume** (resume exactly where
  it left off, replay from any point) is the lesson behind **L10 drafts** (we persist step state,
  not arbitrary code replay). **BPMN** models human-in-the-loop **user tasks** and **compensation
  boundary events / handlers** — direct prior art for guided data-entry steps + per-step
  compensation (Flowable; Red Hat PAM; Camunda). → **steal the model; adopt none wholesale.**
- **Idempotency:** for at-least-once retries over a non-transactional backend, the **idempotency
  key wraps the saga run**, not only individual steps, else retries leave correct-but-partial
  state (idempotency literature). → **L10's run-scoped key.**
- **Honest verdict (original):** the saga *orchestration + compensation* logic would be
  **hand-rolled in our workflow interpreter** — no surveyed TS/JS saga library is
  load-bearing-grade; the engines that do it well (Temporal/Zeebe/Conductor) are heavyweight
  servers, out of scope. We steal their *models*, not their runtimes.

> **Revision (2026-06-30) — staging supersedes saga-as-default.** On review we confirmed Hippo
> *can* offer a clean **whole-set dry-run + atomic multi-entity write** (its storage layer already
> has `staged_transaction()`; the per-write boundary was a choice, not a limit). That makes
> **stage → validate-whole-set → commit-atomically** the default (L9 rev): nothing commits until
> the set is valid, so there is **no partial state to compensate or reconcile**, which deletes the
> hand-rolled saga, the semantic-lock, and the idempotency-reconciliation cost. Compensation
> survives only as the fallback for irreversible-side-effect steps. The capability is a committed
> Hippo dependency — [BU-Neuromics/hippo#84](https://github.com/BU-Neuromics/hippo/issues/84)
> (X4), filed issue-first, implemented increment-by-increment (increment 1 = whole-set dry-run).

---

## Step 4b — Functional requirements: embedded schema editing  *(⛔ DEFERRED post-MVP — L13)*

> **Status: deferred from MVP (2026-06-30, L13).** Not part of the MVP portal; tracked as a
> future enhancement in **[datahelix-platform/aperture#2](https://github.com/datahelix-platform/aperture/issues/2)**.
> For MVP, schema authoring happens **upstream** via Hippo's SDK/CLI `recipe_import`. The
> requirements below are retained as the **design of record** for when the feature is picked up;
> the Hippo deps **X3a/X3b** are deferred with it.

Re-activates actor #5 (schema author, first-class *in-app*; L5). Grounded in Hippo's actual
schema-evolution surface (sec10 recipes, sec11 schema packages): the active schema is an
in-memory `SchemaRegistry`, and the **one live, no-restart, transactional, provenance-tracked,
dry-run-validatable** way to change it is **`recipe_import`** — merging a LinkML fragment as a
content-addressed, version-pinned **recipe**. Two hard constraints shape v1: merging is
**additive/bootstrap-only** (no in-place modify/rename/remove of existing elements — invariant 6),
and `recipe_import` is **SDK/CLI-only** (no transport endpoint). Hence L11 (additive scope) and
L12 (recipe + dry-run; X3a transport ask).

| Req | Requirement | Tag |
|---|---|---|
| S4b.1 | **Schema browser** — render the active schema (entity types, slots, enums, relationships) from `hippoSchema` introspection; the editor's read side reuses the read-loop detail renderers. | (a) |
| S4b.2 | **Additive authoring (L11)** — structured UI to **add** a new entity type, add a slot to a new type, add an enum, or **subclass** an existing type (`is_a:`); slot kinds map to LinkML ranges (scalar/enum/ref/date/bool). Editing/removing existing elements is **disabled with an explanatory affordance** (gated on Hippo overlay mode, X3b). | (a)+(c) |
| S4b.3 | **Raw-LinkML escape hatch** — power users can author/paste the LinkML fragment directly; the structured editor and raw view are two views of the same fragment (Formily-style inter-convertibility, per `library-survey.md`). | (c) |
| S4b.4 | **Recipe packaging (L12)** — the editor emits a recipe (`recipe.yaml` manifest + `schema.yaml` fragment): id, version, `hippo_version` constraint, prefix. Aperture owns the UI→recipe translation. | (c) |
| S4b.5 | **Dry-run preview (L12)** — run `recipe_import(dry_run=True)` and show the would-apply result (classes/slots added, prefix-collision / no-override / version-compat / LinkML-validity outcomes) **before** committing. The same stage→validate→apply shape as the write loop (L9). | (b: X3a) |
| S4b.6 | **Apply** — on confirm, `recipe_import(dry_run=False)` applies atomically; surface the `recipe_imported` provenance event and the new `schema_version`. | (b: X3a) |
| S4b.7 | **Schema-change history** — list installed recipes (`installed_recipes`) + their provenance as an audit trail; offer lockfile export for reproducibility. | (a)/(b) |
| S4b.8 | **Admin-gating** — the whole surface is admin-only (maps to Bridge `admin` when present; local = max permissions, ADR-0008/0016). | (a)+(c) |
| S4b.9 | **Schema-drift awareness** — surfaced to dependent surfaces: a draft (L10) or saved view pinned to an older `schema_version` is flagged when the schema advances. | (c) |

**Degradation / honesty rules:** the editor never offers an edit Hippo can't apply — modify/rename/
remove are visibly **disabled** (not failing on apply) until overlay mode (X3b) lands; the
dry-run is the source of truth for what will happen, never a client-side guess.

**Research basis — Hippo schema-apply surface (2026-06-30, codebase + sec10/sec11):** active
schema = in-memory `SchemaRegistry`; live changes only via `client.recipe_import(source,
dry_run=)` → `SchemaManager.merge_fragment` → `set_registry` (no restart), schema-merge +
`recipe_imported` provenance in **one transaction**. Dry-run validates (manifest, LinkML, prefix
collision, digest, `hippo_version`, no-in-place-override) with **no writes**. `schema_version`
rides on every provenance record; `installed_recipes` + lockfile give reproducibility. **No**
`POST/PUT /schemas` and **no** `client.apply_schema()` — recipe import is the only seam, and it's
SDK/CLI-only. **Bootstrap-only/additive** merging; overlay (modify existing + 3-way merge + data
migration) is explicitly Hippo **v2**. → confirms L11/L12 and the X3a/X3b split below.

---

## Step 5 — Non-functional & platform constraints (MVP)  *(locked 2026-06-30)*

Mostly **consolidates** decisions already in the ADRs / `architecture.md` into the MVP
constraint set; the few genuine MVP stances are flagged. Each constraint cites its ADR
(authoritative) and states the **MVP stance**.

| # | Constraint | MVP stance | Source |
|---|---|---|---|
| N5.1 | **Capability negotiation (Layer D).** The source adapter **declares** what the endpoint supports (FTS, equality facets, offset pagination, sort, aggregation/counts, relationship traversal, batch write/validate, schema introspection); the UI **gates** features on it and **never fakes** a capability (L7). Baseline = GraphQL `__schema` + Hippo's `hippoSchema`/`hippoEntityType` enrichment. | In MVP. Hippo's current surface = FTS + equality facets + offset pages + relationship traversal + the #84 batch write/validate; counts/sort/range gated off until X1. | ADR-0002/0017; arch Layer D; L7 |
| N5.2 | **One active data-plane endpoint (pluggable).** Exactly one source at a time; swapping Hippo→Bridge/Cappella is a **config change**, not a refactor. No cross-source federation. | In MVP: Hippo, direct. | L2; ADR-0017 |
| N5.3 | **Auth seam = no-op pass-through for MVP (Bridge deferred).** Authorization lives in **Bridge** (PEP/PDP), not Aperture or Hippo. Aperture injects a **capability-scoped data client**; for MVP it's a transparent pass-through (local Hippo, no auth / max permissions). Bridge drops in later by swapping that client — **no Aperture change**. Aperture holds **no authority** itself. | In MVP: pass-through; admin/role gating is nominal locally. | ADR-0008/0016; arch §security |
| N5.4 | **Control plane vs data plane.** Aperture's own config + user state (saved views, query-state, **drafts L10**) live in a **control-plane store** (LinkML-on-Hippo reference impl), distinct from the browsed data plane. | In MVP: a Hippo control-plane store (may be the same instance as the data plane). | ADR-0017; L10 |
| N5.5 | **Config-as-data, no middle scripting layer.** Views/forms/the workflow are **serializable LinkML config**, structurally validated and versioned — not hand-written code; no user-facing scripting layer. | In MVP. | ADR-0003/0004 |
| N5.6 | **View-description, not DOM.** Components **emit** a serializable view-description rendered by a separate runtime (Vega/Observable-style); components never touch the DOM. | In MVP (read renderers + the Tier-1 workflow). | ADR-0009/0010 |
| N5.7 | **Typed component sandbox.** Components run in a **Web-Worker** boundary with an **injected capability-scoped client** (no ambient network/DOM); typed component contract; **dry-run-validatable**. Needed by the Tier-1 workflow (kept in MVP); **agent-assisted authoring deferred (L14)** — MVP components are hand-authored. | In MVP (runtime + contract); authoring is manual. | ADR-0008/0010/0011; L14 |
| N5.8 | **Server is the validation authority.** Hippo's three-tier pipeline (LinkML→CEL→Python) is authoritative; Aperture pre-validates client-side for fast feedback only; every mutation is transactional + provenance-tagged server-side. | In MVP. | L3; Hippo sec9 |
| N5.9 | **App shell / delivery = SPA.** Single-page app for MVP; SSR/hybrid is a later option, not an MVP requirement. | In MVP: SPA. | ADR-0014 |
| N5.10 | **Generic source — no domain nouns.** Aperture source is generic over any LinkML+GraphQL endpoint; no brain-bank (or other domain) nouns in source — domain comes from schema + config. | In MVP. | ADR-0002 |
| N5.11 | **Honest degradation & errors.** Capability-gated UI degrades visibly (never silently fakes); server `ValidationResult` (field-attributed, tier-annotated) is surfaced; client-side aggregation (Perspective) only at small scale, capability-gated. | In MVP. | L7; Step 3/4 |

**Genuine MVP stances recorded here (not pre-settled by an ADR):** N5.3 (auth = pass-through for
MVP), N5.4 (control-plane store co-located on a Hippo for MVP), N5.9 (SPA for MVP). All are
reversible and will be ratified as ADRs in Step 6.

---

## Cross-component requirements raised (tracker)

Requirements this portal track imposes on **Hippo** (or other components). Each must be
cross-referenced from the target component's spec/ADR when promoted (Step 6), per the CLAUDE.md
two-sided-dependency rule.

| ID | On | Requirement | Driven by | Priority |
|---|---|---|---|---|
| X1 | Hippo | **Aggregation primitive** — facet/group-by counts, `totalCount`, range filters, `order_by` on the GraphQL list surface. Enables real faceted browse (R3.3r–R3.6). **✅ Promoted** — designed as **Mosaic ADR-0007** ([mosaic#154](https://github.com/datahelix-platform/mosaic/issues/154), Accepted; implementation staged as OpenSpec `aggregation-and-ordering`, [mosaic#156](https://github.com/datahelix-platform/mosaic/issues/156)), with the availability-consistency rule pinned (aggregates see exactly what list queries see). Was tracked as hippo#96. | L7 | **High** — top ask; unblocks v1.x faceting |
| X2 | Hippo | **Server-side bulk/streamed export** — full-cohort export beyond client page-through. *Eased but not solved* by Mosaic ADR-0007 (cheap counts make capped page-through honest); a streamed export remains unfiled. | L8 | Low — deferred to v1.x |
| X4 | Hippo | **Whole-set dry-run validation + atomic multi-entity write** — validate a proposed set (incl. intra-batch references) without writing, then commit all-or-nothing. [BU-Neuromics/hippo#84](https://github.com/BU-Neuromics/hippo/issues/84) — **✅ DONE** (PRs #85/#86/#87: SDK `validate_batch`/`batch_put` + REST/GraphQL; atomic on SQLite + Postgres). | L9 | Delivered. |
| X3a | Hippo | **Transport-expose recipe validate + import** — REST/GraphQL over the existing `recipe_import(dry_run=)` so a browser editor can dry-run-preview and apply an **additive** schema change. Mirrors the #84 transport increment. | L13 | **Deferred (post-MVP)** with the schema editor — tracked in [aperture#2](https://github.com/datahelix-platform/aperture/issues/2). Tractable when picked up. |
| X3b | Hippo | **Overlay / breaking-change schema mode** — modify/rename/remove existing elements (3-way merge + conflict resolution) + data migration. Hippo's own deferred **v2** item (sec10 §10.9). | L13 | **Deferred (post-MVP)** — unlocks full (non-additive) editing; [aperture#2](https://github.com/datahelix-platform/aperture/issues/2). |
| X5 | Hippo | **Typed operator + relationship-predicate filter contract** — generated per-class `<Type>Filter` input objects (per-slot operator objects `eq/neq/in/gt/gte/lt/lte/contains/isNull` by slot kind/range, `and/or/not`, `where:` arg) with phased relationship predicates (to-one nesting, then to-many `some`/`none` quantifiers); explicitly **not** CEL on the wire, so the introspected schema is the capability contract. Designed as **Mosaic ADR-0006** ([mosaic#153](https://github.com/datahelix-platform/mosaic/issues/153), Accepted; implementation staged as OpenSpec `typed-filter-inputs`, [mosaic#155](https://github.com/datahelix-platform/mosaic/issues/155); search composition and heterogeneous roots ride alongside as [mosaic#157](https://github.com/datahelix-platform/mosaic/issues/157)/[mosaic#158](https://github.com/datahelix-platform/mosaic/issues/158)). Driven by [ADR-0035](./decisions/ADR-0035-cross-class-queries-typed-queryspec.md) (`cross-class-query.md` §7 names this "X3"; filed as X5 since X3a/X3b were taken). | ADR-0035 | **High** — keystone for cross-class criteria queries |

---

## Next steps (queue)
- ~~Step 1 — Scope & framing~~ ✅ · ~~Step 2 — Actors & jobs~~ ✅ · ~~Step 3 — Read loop~~ ✅ ·
  ~~Step 4 — Write loop~~ ✅ (W4.7 atomicity = stage→validate→commit, L9/L10; Hippo X4 **delivered** #84)
- ⛔ ~~Step 4b — Schema editing~~ **DEFERRED post-MVP** (L13; tracked in [aperture#2](https://github.com/datahelix-platform/aperture/issues/2)) — design of record retained.
- ~~Step 5 — Non-functional & platform constraints (MVP)~~ ✅ (N5.1–N5.11; MVP stances: auth
  pass-through, co-located control plane, SPA — L14 defers agent-assist, keeps the component substrate)
- ~~Step 6 — Promote to ADRs~~ ✅ (2026-06-30): new **ADR-0026** (portal-first MVP + deferrals,
  L1/L13/L14), **ADR-0027** (read+write portal, L3/L4), **ADR-0028** (workflow atomicity ↔ Hippo
  #84, L9/L10), **ADR-0029** (capability-gated honest degradation, L7/L8); **ADR-0017** amended
  (L2/N5.4); **ADR-0014** ratified → SPA (N5.9); **0013/0018–0025** marked ⛔ Deferred-from-MVP
  (→ ADR-0026); INDEX Decision Log + `vision.md` portal-first note updated.

**Requirements track complete (Steps 1–6).** MVP design of record now lives in the ADRs;
`portal-requirements.md` remains the working narrative + decision ledger (L1–L14). Open Hippo
dep for v1.x: **X1** (aggregation/counts). Deferred & tracked: schema editing (aperture#2),
agentic surfaces (ADR-0026).
