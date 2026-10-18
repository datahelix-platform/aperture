# Aperture — Vision: An AI-Native Data & Workflow Explorer

**Status:** 🔵 North-star vision (2026-06-17). **Reframes** the "config-driven data portal"
framing: the portal is the *substrate and MVP*, not the product. The product is an **LLM-native
interaction layer** over the whole DataHelix platform. Honest companion to
[`prior-art.md`](./prior-art.md), [`gen3-comparison.md`](./gen3-comparison.md), and
[`../../proposals/datahelix-vs-gen3-strategic-review.md`](../../proposals/datahelix-vs-gen3-strategic-review.md)
— it directly answers that review's crux #1 ("is the deliverable just a faceted explorer?":
**no**) and raises, not lowers, the de-risking stakes.

> **Portal-first MVP (ADR-0026).** This is the **north star**, not the MVP scope. The **MVP is the
> config-driven portal** — read loop + write loop (forms + one guided workflow) over a single
> Mosaic (formerly Hippo) endpoint (see `portal-requirements.md`). The agentic surfaces described below
> (in-app agent/chat, data-stories, per-user keys, conversations-as-provenance) and the in-app
> schema editor are **deferred from the MVP** (ADR-0026; schema editor → [aperture#2](https://github.com/datahelix-platform/aperture/issues/2)).
> The substrate invariants are preserved so this vision is an additive future, not a rewrite.

## The reframe

From **"metadata browser / config-driven data portal"** → **"AI-powered data explorer."**

Conventional data portals (Gen3 and every tool in the prior-art survey) are a *solved, boring
class* — often clunky, rarely fun. The most exciting thing LLMs offer is **a new way to interact
with computers**: a natively intuitive interface that gets a computer to do sophisticated,
complicated things through natural language. Aperture's differentiator is **the interaction
paradigm**, not the feature set. Reference point: **NotebookLM** — an intuitive interface that
builds understanding ("data stories") by *talking to your sources*.

This puts Aperture in a different class than Gen3's portal. We are not building a better portal;
we are building a conversational interface for *exploring and transforming* scientific data.

## The substrate it drives: the domain graph

Aperture drives the platform's **domain graph** (see
[`platform/design/domain-graph.md`](../../platform/design/domain-graph.md)): one typed knowledge
graph whose type system is the LinkML schema and whose runtime is Mosaic — *not* a "metadata
store." Every query returns a **knowledge subgraph**; "metadata vs. data" is a query-relative
*role*, not a storage category. Structured records live in Mosaic; bulk payloads live in files
(Canon/Cappella) and enter the graph as **induced subgraphs unioned at query time** (OBDA/VKG).
This is why an LLM can drive it coherently: there is *one* uniform, typed graph surface, and the
substrate mechanics are hidden behind it.

## The through-line: our declarative work was the substrate for this all along

The modular/declarative design we did is not portal plumbing — it is **exactly what makes
natural-language control safe and reliable.** An LLM driving a system needs a surface that is
*typed, introspectable, validatable, and reversible* — otherwise it produces plausible garbage.
Our settled decisions provide precisely that surface:

| Decision | Why it's load-bearing for an LLM interface |
|---|---|
| Config-as-LinkML-data in the backend (ADR-0003) | A machine-manipulable, validated artifact the agent edits — not opaque code |
| No middle scripting layer; typed components only (ADR-0004) | The agent works in a *closed, typed vocabulary*, not freeform code that can't be checked |
| Serializable view-descriptions, headless validation (ADR-0009) | The agent's output is *checkable before it runs* — the validator is the guardrail |
| Typed noun-catalog view vocabulary (ADR-0010) | A bounded, composable grammar the LLM can reason over reliably |
| Dry-run validation + reversible, provenance-tagged apply (handoff §6) | The agent iterates against a validator until green; every change is attributed and undoable |
| Agent acts with the user's authority (ADR-0018); config & conversations are provenance (ADR-0020) | Safe, auditable agency |

**The validated declarative substrate is the de-risking mechanism for the ambitious vision.** The
LLM never touches raw DOM, raw SQL, or raw pipeline code; it manipulates typed artifacts that a
validator gates. That is what makes "talk to it and it does sophisticated things" *tractable and
safe* rather than a hallucination engine.

## Scope expansion: the conversational control plane for the whole platform

Aperture is the LLM-native interface over **all three** DataHelix domains, via one uniform pattern —
each domain exposed as typed, declarative, dry-run-validatable, provenance-tracked artifacts the
agent composes/modifies under the user's authority:

- **Mosaic (metadata):** browse, faceted explore, build views, compose data stories.
- **Cappella (workflows):** compose and modify pipelines by natural language.
- **Canon (files / reference data):** resolve and bind real tools/inputs into those workflows.

**Driving example (the north star):** *"modify workflow X to add a low-complexity sequencing
read-filtering step between adapter trimming and alignment."* This is the config-edit pattern
**generalized to workflow-as-data**: the agent locates the topological insertion point in the
DAG, binds a real filtering tool (via Canon), inserts a typed step, **dry-run-validates** that
inputs/outputs still connect, and (optionally) executes via Cappella — every change attributed
and reversible. Same discipline as editing a view; harder artifact.

## How this goes *beyond* NotebookLM

NotebookLM grounds an LLM in *your* sources and produces **understanding** (summaries, briefings,
audio). Aperture grounds an LLM in your live metadata + workflows + results (via schema/workflow
**introspection** + the capability-scoped client) and produces **understanding *and* executable,
validated, reproducible transformations** over real scientific data. A "data story" here is not
just prose — it is a composed, narrated, **re-runnable declarative artifact**. That step — from
generated text to grounded, validated, executable action over live data — is the genuine advance.

## The honest counterweight (this raises the stakes)

This vision is **more ambitious and more unproven** than the portal. It amplifies exactly the
bets the strategic review flagged ("zero verified prior art" for agent-editable config) and adds
a harder one (agentic workflow editing with correctness guarantees). So the review's discipline
matters **more**, not less:

- **Keep Mosaic; do not adopt Gen3 wholesale** — unchanged.
- **The keystone probe reframes.** It is no longer "derived binding for a portal." It is: *can an
  LLM reliably drive a typed declarative artifact through a validator to a correct change?* That
  is the whole thesis in one testable question.
- **Prove it cheaply, in order** (the probe ladder):
  1. **Agent edits a view / portal config-as-data** → dry-run validates → applies. (Type-A loop;
     scaffolding closest to hand. Cheapest decisive test of the thesis.)
  2. **Agent composes a multi-step "data story"** (a sequence of bound views/queries) from a
     prompt.
  3. **Agent edits a Cappella workflow-as-data** (the read-filter example) → validates → runs.
  Each rung tests *LLM + typed declarative surface + validator* at rising complexity. If rung 1
  fails, the vision needs rethinking before more is built; if it succeeds, the path is real.

## New platform invariant this implies

Every domain Aperture drives must expose a **typed, introspectable, dry-run-validatable,
provenance-tracked declarative representation.** Mosaic has this (LinkML + GraphQL + PROV-O).
**Cappella and Canon must grow it** for the workflow/file domains — this becomes a first-class
requirement on those components, not an Aperture-only concern.

## Net

The reframe **escapes the Gen3 comparison** (different class), **recasts our declarative work as
the enabling substrate** (it was the right bet, for a deeper reason than we stated), and makes
Aperture a *fundamental shift in how the lab works with and transforms data* rather than a
me-too portal. It does **not** repeal the strategic review — it answers crux #1 and makes
cheap, sequenced de-risking of the agentic keystone the single most important next step.
