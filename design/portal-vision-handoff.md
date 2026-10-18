> **Reframe note (added 2026-06-17):** The top-level framing in this handoff —
> Aperture as a *"config-driven data portal"* — is **superseded by
> [`vision.md`](./vision.md)**. Aperture is now an **AI-native data & workflow
> explorer** over the DataHelix **domain graph**; the config-driven portal is its
> **substrate / MVP, not the product**. This document is retained verbatim as a
> captured artifact — read it for narrative context, but take the lead framing
> from `vision.md` and the platform [`domain-graph.md`](../../platform/design/domain-graph.md).
>
> **Decision-record note (added 2026-06-13):** This handoff is now **historical
> vision / context**, not the decision record. Its §2 settled decisions are
> backfilled as `Accepted` ADRs (0002–0009) and its §9 open questions are `Proposed`
> ADRs (0010–0013) in [`decisions/`](./decisions/). **Cite ADRs for decisions; read
> this doc for narrative context.** The §10 invariants checklist remains the
> per-change review list (its invariants are now owned by the ADRs above).
>
> **Status banner (added 2026-06-13):** This handoff captures a new, broader
> vision for Aperture as a **config-driven data portal**. It **supersedes the
> CLI-first v0.1 framing** in `sec1`–`sec6` (which remain in this directory as
> historical reference until the repo split). The plan is to extract Aperture
> into its own repository (`datahelix-platform/aperture`) on a **fresh start** that
> keeps only the reusable `src/aperture/backends/` protocol and carries these
> portal design docs forward. See `proposals/aperture-split.md` for the runbook
> and `portal-open-questions.md` for the in-progress resolution of §9.
>
> Source: pasted from an external design session ("Aperture design session"),
> reproduced verbatim below.

---

# Aperture — Design Handoff

**Component:** `aperture` (the interface layer of the DataHelix platform)
**Status:** Architecture brainstorm complete; pre-implementation.
**Audience:** A coding agent (and human reviewer) picking up the next steps.
**Backing services:** `hippo` (LinkML runtime, GraphQL + REST APIs) is the data and config store.

---

## 1. What Aperture Is

Aperture is a **config-driven data portal** that talks to `hippo`. Its scope:

- Data **browsing and searching** (faceted, schema-derived)
- Data **view construction and export** (named, saved, serializable views)
- **Visualization** (a catalog of chart types bound to query results)
- **Sharing** (deliberately last; mostly a permissions problem, not a UI problem)

The entire app layout and functionality is **configured, not coded**, for the common
cases. Custom behavior is delivered through **typed, sandboxed plugins/components**, not
through a scripting layer wedged into config.

### Guiding intent

A non-technical user should be able to point a coding agent (e.g. Claude Code) at their
Aperture instance — local or an authenticated endpoint — and ask it to add or modify
functionality. The agent edits **config** (always safe, unsupervised) and can scaffold
**components** (which run sandboxed and are validated before going live).

---

## 2. Core Architectural Decisions (settled)

These are decided. Do not relitigate without a strong reason; record any change as an ADR.

1. **Generic, not brain-bank-specific.** Aperture is generic against *any* hippo
   deployment + LinkML schema + GraphQL endpoint. The brain bank portal is simply the
   first and most-tested *instance* of the generic app.
   - **Invariant:** No brain-bank domain nouns (`Donor`, `Specimen`, `BrainRegion`,
     etc.) appear anywhere in Aperture source. Those live only in schema + config.
     Domain nouns leaking into source code is the signal that the generic abstraction
     has drifted.

2. **Config is a LinkML schema, stored in hippo.** Aperture config is itself modeled in
   LinkML and persisted in hippo. This buys validation, versioning, provenance, and
   native access via hippo's GraphQL + REST APIs for free. No bespoke Aperture
   persistence layer.

3. **Three levels of configurability.** Keep these distinct; conflating them causes bloat.
   - **Level 1 — Composition:** which blocks appear, where, in what order (nav,
     dashboards, which entities get pages, column choices). Bounded, fully declarative.
   - **Level 2 — Binding:** how blocks map to the hippo schema / GraphQL (which class,
     which slots are filterable, which relationships join). Mostly *derived* from the
     LinkML schema, with thin config overrides.
   - **Level 3 — Behavior:** custom logic, novel views, custom viz, export transforms.
     **This is NOT a config surface.** It is delivered exclusively via typed plugins.
   - **Discipline:** Levels 1 & 2 are declarative and exhaustive. Level 3 is an escape
     hatch to real (sandboxed) code. There is **no middle scripting/expression layer** —
     that middle layer is precisely what bloats low-code systems.

4. **Config is equally accessible to humans and LLMs.** One canonical, fully-qualified,
   validated LinkML instance is the source of truth (stored in hippo). Humans edit it
   through the `linkml-modeler-app` ERD editor or narrow admin UI; agents edit the
   canonical form directly. Both converge on the same validated document.
   - Every default is declared **in the LinkML schema**, never buried in render logic,
     so default-resolution is inspectable by both humans and agents.
   - Schema `description` / `comments` / `examples` on every slot are **mandatory** —
     the schema *is* the agent's primary context / spec.

5. **Plugins/components are runtime-reloaded.** No rebuild/redeploy to add or change a
   component. A reloaded component must pass headless validation before going live; on
   failure the previous version stays. (Langflow's load model is the reference; see §4.)

6. **User-space and system-space components are the same artifact at different
   visibility scopes.** Requirements are identical; only *access* differs. "Promote to
   portal-wide" is a pure ACL/visibility change that touches **no code** and grants **no
   new capability**.
   - **Consequence (critical):** the sandbox and all safety constraints are **universal
     from the first keystroke**. Safety is never "added at promotion." Every component,
     including an unprivileged user's first experiment, already runs under the
     constraints required of portal-wide code.

7. **Components never hold authority.** A component's data reach is conferred by the
   **context it runs in**, resolved against the **current viewer** at call time, via an
   **injected, capability-scoped client**. A component never captures or carries its
   author's credentials or visibility.
   - This is what makes promotion safe: same component, run by any viewer, sees only
     what that viewer is permitted to see. Without this rule, promotion is a
     privilege-escalation vector.

8. **Components produce a serializable *view description*, not direct DOM manipulation.**
   The runtime decides how to realize the description. This single rule:
   - makes **headless validation** possible (no browser / Playwright needed),
   - makes the **sandbox enforceable** (component can't reach around the runtime),
   - lets an **LLM reason** about component output,
   - bounds the blast radius of a bad-but-passing component to **one slot's view**.

---

## 3. Two Stores of Config Data (same hippo store, same permission model)

We are NOT splitting persistence. Both live in hippo under one permission model. The
distinction below is a **modeling** opinion (different shapes/lifecycles), not a safety
or isolation claim — weigh it lightly.

- **Deployment / registry config:** block catalog, layout, bindings, component registry
  entries (each with a `scope`/`visibility` slot). Admin-write, agent-editable,
  versioned, change-controlled (commits / revisions).
- **User state:** saved views, filters, dashboards, a user's component instances and
  parameters. User-write, high-churn, disposable.

Model these as **distinct LinkML classes** even though they share the store and
permission model.

---

## 4. Borrowed from Langflow (and what NOT to borrow)

**Borrow:**
- The **typed contract is the validation surface** — declared, typed inputs/outputs let
  most errors be caught by checking the declaration before anything renders.
- **Per-component load isolation** — a component that fails to load logs an error and is
  skipped; the rest of the app keeps working. This is the minimum bar for "doesn't
  endanger the portal."

**Do NOT borrow:**
- Langflow components run server-side with **ambient process reach**. Their isolation is
  *load-time*, not *runtime*. Aperture needs **both**: load-time graceful degradation
  AND a runtime sandbox with no ambient authority (see §2.7, §2.8). Langflow's
  "component is trusted code" model does not fit Aperture's threat model
  (non-technical user + agent-authored code in a shared, possibly authenticated portal).

---

## 5. The Component Contract — Three Independently-Checkable Layers

Designed so validation requires **no browser**. Each layer is checkable on its own.

1. **Manifest (LinkML-validated, zero execution):**
   name, scope/visibility, declared typed inputs, the hippo query/binding it depends on,
   the slot it renders into, and the **capabilities it requests**. Validates against the
   meta-schema with no execution.

2. **Data-contract check (headless, no browser):**
   given the manifest's declared query, run it against the bound hippo schema via
   GraphQL introspection / dry-run; confirm referenced slots exist, types line up, and
   the requested capabilities are grantable to the running context.

3. **Render-contract check (headless component runtime):**
   execute the component's render function in a non-DOM environment (Node / Web Worker)
   with a fake slot and a **mocked capability-scoped client**; assert it returns a
   **valid view description** without throwing, given representative and empty data.
   - **Forcing function:** if a component's correctness can only be confirmed by
     inspecting rendered pixels, the contract is wrong.

**Hot-reload flow:** agent writes/edits component → three checks run headless → on green,
the registry entry updates in hippo → live instances re-fetch and re-render their slot.
A broken reload fails at check time; the old version stays live. No rebuild, no
redeploy, no browser.

---

## 6. Instance Requirements for Agent-Driven Development

For an agent pointed at an instance (local or authenticated endpoint) to work reliably:

- **Introspect current state:** read live config + block catalog + plugin/component
  registry (not a stale file). GraphQL introspection covers the *data* schema; provide
  an equivalent "describe my config + catalog + registry" capability.
- **Validate without applying (dry-run):** an endpoint/command that runs LinkML
  validation + the data-contract and render-contract checks and returns
  **LLM-readable error messages**. This is the highest-leverage reliability investment —
  it converts "agent guesses, you find out in prod" into "agent iterates against the
  validator until green."
- **Apply as a reversible, attributed change:** the write path creates a versioned,
  **provenance-tagged** (PROV-O) config/registry revision answering who/what/when, and
  reverts cleanly.

---

## 7. Request Types the Agent Loop Must Distinguish

- **Type A — composition/binding** ("add a page showing donors by brain region"):
  pure config. Tractable and **safe to do unsupervised today**. Build and prove this
  loop end-to-end first.
- **Type B — novel behavior** ("a survival-curve view stratified by genotype"):
  a **plugin/component**. Runs sandboxed, validated via the three-layer contract, data
  reach scoped to the viewer. Runtime-reloaded once green.

Do not collapse A and B. A is config; B is sandboxed code. Both are governed, but by
different machinery.

---

## 8. Sequencing (de-risk in this order)

The generic approach, the agent loop, and config-in-hippo are three stacked bets.
Sequence so each de-risks the next; do not build them in parallel.

1. **Schema-derived browse + faceted search for the brain bank, with config-in-hippo.**
   Proves: config-in-hippo + generic abstraction + data binding, all at once.
2. **Add the dry-run validate endpoint + a config skill; prove the Type-A agent loop**
   on that working portal.
3. **Design the typed component contract (shaped for the sandbox); hand-build ONE
   Type-B component** (e.g. the survival-curve view) to learn the interface before any
   agent touches component authoring.
4. **View construction + export**, then **visualization catalog**, then **sharing**.

Capability-by-capability config tractability (highest → lowest): browse/search →
view-construction/export → visualization → sharing.

---

## 9. Open Questions (load-bearing — resolve before/while building §8.3)

1. **Component execution runtime:** server-side (Python, sandboxed, Langflow-like) vs.
   client-side (JS/TS in a Web Worker / iframe). For a data portal with viz,
   client-side-in-worker producing a view-spec is the more natural fit, but it
   constrains components to JS/TS — possibly clashing with a Python-centric user base
   who would rather write analysis in Python. This decision *defines what the sandbox
   actually is*.
2. **Richness of the view-description vocabulary:** too thin and components can't express
   real visualizations (pressure to allow raw rendering returns); too rich and it
   becomes the bloated DSL we explicitly rejected. Calibrate against 2–3 concrete target
   components (the survival-curve view is a good probe: can it be expressed as catalog
   primitives + bound data, or does it genuinely need escape-hatch rendering?).
3. **Local vs. remote agent loop:** should "agent points at a local instance" and "agent
   points at an authenticated remote endpoint" be the *same* loop (always talk to a
   running Aperture API) or genuinely different (local = edit files in a repo; remote =
   call config-mutation endpoints)? Picking one now avoids building both.
4. **Config layering:** single config document per deployment, or layered
   (base defaults → schema-derived → admin overrides → user-accessible subset)? Layering
   is more powerful but each layer is a place bugs hide.

---

## 10. Invariants Checklist (for review of any future change)

- [ ] No domain nouns in Aperture source (generic abstraction intact).
- [ ] All config is LinkML, validated, stored in hippo.
- [ ] No middle scripting/expression layer between declarative config and typed plugins.
- [ ] Every config default declared in schema, not in render logic.
- [ ] Sandbox + safety constraints universal from first keystroke; promotion is ACL-only.
- [ ] Components hold no authority; data reach resolved against current viewer via
      injected capability-scoped client.
- [ ] Components emit serializable view descriptions, never direct DOM manipulation.
- [ ] All three contract layers checkable headlessly (no browser in the validation loop).
- [ ] Config/registry writes are versioned, provenance-tagged, reversible.
