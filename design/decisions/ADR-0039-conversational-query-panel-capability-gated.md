# ADR-0039: A conversational query panel, gated on an endpoint-advertised capability

- **Status:** Accepted
- **Date:** 2026-09-11 (ratified 2026-09-17; see aperture#60)
- **Deciders:** labadorf, design session
- **Related:** ADR-0021 (defer in-app chat), ADR-0026 (portal-first MVP), ADR-0029 (capability-gated honest degradation), ADR-0031 (app-shell layout library), ADR-0035 (typed `QuerySpec`), ADR-0017 (data plane vs control plane); Mosaic `converse_query_spec` (`datahelix-platform/mosaic#186`, shipped PR #199) and the `mosaic-demo-small` change `add-aperture-chat-panel`

## Context

Aperture ships a working cross-class query builder (ADR-0035): `QueryBuilderView` composes a
typed `QuerySpec`, `planner.ts` executes it, results render and export. Building a spec is
manual — pick an anchor, add criteria, pick edges.

A second way to produce the same artifact now exists *outside* Aperture. Mosaic hosts a
`converse_query_spec` capability (shipped, `mosaic` PR #199) that delegates to a conversational
planning service (Exon), taking `{utterance, query_spec, turns, edit_turn_id}` and returning a
turn whose status is `proposal` (carrying an updated `QuerySpec`), `clarification`, or
`suspended`. Mosaic re-validates every candidate spec in-process before labelling it a proposal,
so an invalid spec never reaches a client. A terminal reference client (`exon/chat.py`) already
drives the whole loop end to end.

The question this ADR settles: **may Aperture surface that capability as an in-app chat panel,
given ADR-0021 and ADR-0026 explicitly deferred in-app chat from the MVP?**

The tension is real but narrower than it first looks. What ADR-0021 deferred was an *in-app
conversational agent*: Aperture hosting an agent loop, holding per-user LLM provider keys
(ADR-0019), doing prompt/skill engineering, and letting a chat **edit config** with delegated
authority (ADR-0018/0020). Every one of those remains deferred and absent here. This panel hosts
no agent loop, holds no provider key, sends no system prompt, and cannot mutate config or data —
it is a thin client for one read-only, server-side capability whose entire output is a `QuerySpec`
the user must then explicitly run, exactly like a spec they built by hand.

## Decision

**Aperture will surface a conversational query panel as an additive, capability-gated surface
over the existing `QuerySpec` artifact — never as a new foundation, and never as a capability
Aperture itself supplies.**

Concretely:

1. **The gate is introspection, not config.** A `conversationalQuery` capability is negotiated in
   `deriveCapabilities` from the endpoint actually advertising a usable `converseQuerySpec`
   mutation — a name match alone is not a capability (ADR-0029, matching how `batchWrite` and
   `whereFilter` are derived). No `VITE_*` flag can force the panel on; an endpoint without the
   mutation renders no chat affordance at all, with no dead chrome.
2. **The panel occupies a composer column in the query context's own layout**, alongside the
   artifact it feeds, and only while the cross-class query view is open (see the amended
   consequence below on why this is a layout and not the existing inspector slot).
3. **Aperture owns no conversation state beyond the session.** The turn list is the wire
   contract's own `turns` array, replaced wholesale from each response (the server is
   authoritative — it recomputes downstream turns after an edit). Nothing is persisted; a refresh
   loses the transcript, and the `QuerySpec` survives in the URL as it already does.
4. **The chat never executes.** A proposal populates the builder's spec; running it stays the
   user's explicit action through the existing execution path (ADR-0035). "Model plans,
   deterministic code executes."

## Consequences

- Aperture gains a second producer of `QuerySpec` without gaining a second *executor*, a second
  artifact, or an agent loop. If the capability disappears from the endpoint, the panel
  disappears; nothing else changes.
- ADR-0021/0026 are **not** reversed and need no supersession: their deferral covers the hosted
  agent loop, provider keys, and config-mutation authority, none of which this adds. When the
  in-app agent surface is eventually built, this panel is one more client of it, not a competing
  foundation.

  **Correction (2026-09-11):** the ADR-0026 half of that sentence was loosely worded. ADR-0026 is
  not a live Aperture deferral this ADR could leave standing — it was **already superseded on
  2026-06-22**, moved to Reel as **Reel ADR-0005** in the data-story-engine split, and what
  remains here is a tombstone. The load-bearing citation is **ADR-0021**, which is Accepted and
  still Aperture's own (its "⛔ Deferred from MVP" marker merely points at 0026 for the reason).
  The argument is unchanged — this panel adds no agent loop, provider key, or config-mutation
  authority, so nothing in either decision is reversed — but the reader should not be sent to a
  tombstone for a live constraint.

  **Reel boundary (2026-09-11).** Reel's design refresh (`reel#1`) lands three `Proposed` ADRs
  that touch this panel's seam, and they agree with it rather than contest it: **Reel ADR-0006**
  adopts the `QuerySpec` as Reel's v1 `State` and cites Aperture ADR-0035's seam verbatim —
  "Aperture owns the noun and its execution; Reel composes instances of it" — which is exactly
  where this panel sits (it produces a `QuerySpec` and hands it to Aperture's existing executor).
  **Reel ADR-0008** claims the conversational turn model as Reel's `Instruction`, seeded from
  Exon. That does not change this ADR, but it does sharpen the forward-compatibility sentence
  above: the agent surface this panel will eventually be "one more client of" is most likely
  **Reel**, not an Aperture-hosted loop. Nothing here needs to change until Reel exists; when it
  does, the swap is the wire adapter (`data/conversation.ts`), not the panel.
- **The proposal's `headerNavMainInspector` layout is not needed, but a workbench is.** Scoping
  found that `headerNavMain` already declares and renders `inspector`
  (`shell/layouts/HeaderNavMain.tsx`), `App.tsx` already binds it, and `FacetPanel` already
  vacates it whenever a cross-class view is open (`FacetPanel.tsx:26` — `if (urlState.view !=
  null) return null`). So a variant of the browse shell that merely adds an inspector — what
  `add-aperture-chat-panel`'s Decision 4 assumed was missing — would be redundant chrome, and
  that proposal's task 4.2 should be struck on this finding.

  **Amended after building it:** the inspector column (264px) is the wrong *shape* for a
  transcript, which is a different objection from the one above. Composing a query and browsing a
  collection are genuinely different screens, which is the case ADR-0031 was written for ("one
  screen can't serve master-detail browse, a dashboard landing, and full-bleed views without
  contortions"). So this adds `queryWorkbench` — nav, a bounded composer column, and a wide main
  for the artifact and its results — and the portal selects it by name for the query context
  (`shell/contexts.ts`). Selection stays data: a table of layout names resolved through the
  registry, never composition. `queryWorkbench` does not support `inspector`, since collection
  facets have no meaning against a cross-class query.
- An obligation lands on Mosaic: the capability must be reachable over GraphQL, since a browser
  cannot speak MCP without transport work Aperture's thin-client posture (ADR-0014/0016) rules
  out. Tracked in `mosaic-demo-small`'s `add-aperture-chat-panel` Phase 1 and cross-referenced
  there; until it ships, the panel is exercised against a stub endpoint the way every other phase
  of this app was (`web/.claude/skills/verify`).
- A spelling dependency was explicit and **sequenced before the panel could run a spec it
  receives**: Exon emits LinkML names (`anchor: "Sample"`, `edge: "donor"`), while Aperture's
  `QuerySpec` carried collection ids and derived `fwd:`/`rev:` edge keys. **Resolved in
  `e0064aa`**: `QuerySpec` now speaks LinkML names, and `canonicalizeQuerySpec()`
  (`web/src/query/querySpec.ts`) provides a tolerant read of the legacy spelling for existing
  saved views, discriminating by content rather than by a version field. A received proposal now
  runs. Reverse edges remain the exception — they keep the Aperture-local
  `rev:<collectionId>.<field>` key, because no LinkML name exists for them until Mosaic ADR-0011
  (`mosaic#204`) lands inverse slots.

## Alternatives considered

- **A mode toggle inside `QueryBuilderView`.** Rejected: welds an app-level surface into one
  view, the opposite direction from ADR-0021's eventual end state (chat editing config from
  inside Aperture generally), and makes the panel expensive to relocate later.
- **A separate `Ask` nav route.** Rejected: cheapest to build, but hides the `QuerySpec` the chat
  is producing behind a disclosure and creates two query surfaces to reconcile — when the whole
  value is watching the spec assemble next to the builder.
- **Speak MCP from the browser.** Rejected: needs an MCP client in the SPA bundle, SSE handling,
  a new proxied path, and CORS — to preserve a "one wire protocol" purity ADR-0017 does not
  actually require (it constrains *endpoints*, not protocols). Aperture is a thin GraphQL
  pass-through by design (ADR-0014/0016).
- **Aperture hosts the planning loop itself** (its own LLM calls against the schema). Rejected
  outright: that *is* the thing ADR-0021 deferred, it would put a provider key in Aperture's
  hands (ADR-0019 unbuilt), and it would duplicate a validated capability the endpoint already
  offers — with Aperture's copy lacking Mosaic's in-process re-validation.
- **Wait for the GraphQL mutation before building any UI.** Rejected: the wire contract is
  already pinned by a shipped MCP tool and its reference client, and every prior phase of this
  app was built and verified against a stub endpoint first. Waiting buys no design certainty.

## Notes / open sub-questions

- Ratify `Proposed` → `Accepted` once the panel has been driven end to end against a real
  `converseQuerySpec` mutation, not only the stub.
- The three UI-feel behaviors specified in `add-aperture-chat-panel`'s design (suspended-turn
  inline + banner treatment, in-flight typing indicator + elapsed timer + cancel, and the
  builder-lock/reset affordance) are implementation detail under this decision, not separate
  decisions — but the builder lock is load-bearing for correctness, not taste: Mosaic rejects a
  request whose wire `query_spec` disagrees with what it derives from `turns`.
- Conversation-as-provenance (ADR-0020) is deliberately out of scope: a chat-produced saved view
  keeps the resulting `QuerySpec` and loses the conversation that produced it. Revisit if
  conversations become provenance events in practice.
