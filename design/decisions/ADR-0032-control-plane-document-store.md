# ADR-0032: Control-plane state = versioned documents on a structurally-recognized Hippo collection, with an honest local fallback

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** labadorf (via Phase-4 review/merge, PR #14), dev sprint
- **Related:** ADR-0017 (data plane vs control plane — refines its reference impl), ADR-0003/0004 (config-as-data), ADR-0029 (honest degradation), N5.4; aperture#17 (recipe), aperture#19 (removal affordance); ownership amendment: aperture#56, datahelix-platform/mosaic#178 (enforcement)

## Context

Phase 4 needs a concrete shape for the control-plane store ADR-0017 mandates: where saved
views, workflow drafts (L10), and config-as-data actually live, how Aperture finds the store,
and what happens when a deployment's Hippo doesn't (yet) carry it. The temptations to avoid:
a bespoke sidecar service (violates the LinkML-on-Hippo reference stance), silent
browser-local persistence (users can't tell what survives their machine), and a hard-coded
type name the adapter trusts blindly (violates the derive-don't-assume discipline every other
surface follows).

## Decision

Aperture persists its own state as **`{kind, name, payload}` documents** on a Hippo
collection it recognizes **structurally** — an entity type with text-ish `kind`/`name`/
`payload` fields, kind+name equality filters, and create+update mutations — reached through
the same Layer-D source machinery as domain data. Specifics:

- **Versioned payload envelopes.** Every payload is `{v, data}` JSON; readers validate
  structurally on open and **skip** documents they can't validate. Saved views and drafts pin
  the schema fingerprint (interim) / `schema_version` (once enrichment lands) for drift
  detection on open/resume.
- **Upsert by `(kind, name)`; no hard delete.** Removal retires a document by clearing its
  payload (W4.4 discipline applied to Aperture's own state); retired documents read as absent
  everywhere.
- **Co-located by default, splittable by config.** The control plane defaults to the data
  plane's endpoint (N5.4); `VITE_HIPPO_CONTROL_PLANE_URL` connects a separate one.
- **Honest local fallback.** No document type advertised → persistence falls back to
  browser localStorage, and the shell's footer states which backend is live. The fallback is
  labeled, never silent (ADR-0029).
- **Reads bypass the client document cache** (`fresh`/network-only): read-after-write over
  possibly-empty lists is the store's core access pattern, and an empty cached list has no
  typename association for mutations to invalidate.

The document type itself ships as an Aperture-owned Hippo recipe (aperture#17).

## Consequences

- The control plane inherits Hippo's transactions, provenance, and transport for free, and
  the store works against any endpoint that carries the document type — including a split
  control-plane Hippo — with zero Aperture changes (the ADR-0017 promise, kept).
- Drafts and saved views are server-side: they survive browsers and machines. Deployments
  without the recipe still function, visibly degraded to browser-local persistence.
- Structural recognition means the recipe can evolve names/prefixes as long as the shape
  holds; it also means a domain type that coincidentally matches the shape would be adopted
  as the store — acceptable at MVP, revisit if it ever bites (an explicit marker slot is the
  escape hatch).
- Envelope versioning gives upgrade-testing leverage (old documents against new app) and a
  forward-compatible migration point.

## Amendment (2026-08-28 — document ownership; multi-user control plane)

**Context.** ADR-0032 was decided under ADR-0016's premise that "near-term deployments are
single-user / local." Introducing authentication in front of a deployment (an OIDC reverse
proxy in the recipe's nginx position; PIV/CAC at VA, htpasswd for testing) invalidates that
premise while changing nothing about the store — so `(kind, name)` becomes a **shared global
namespace across every authenticated user**. Two researchers who both save "PTSD cohort v2"
silently overwrite each other, and every user's workflow drafts appear in every other user's
resume list. The latter is a data-integrity problem, not an untidiness problem.

**Decision.** Control-plane documents carry an **`owner`** and a **`visibility`**, and the
upsert key becomes **`(owner, kind, name)`**. Policy is per document kind:

| Kind | Owner-stamped | Default visibility | Non-owner write |
|---|---|---|---|
| `savedView` | yes | `shared` — listed for everyone | **refused** |
| `workflowDraft` | yes | `private` — listed only for its owner | refused |
| `config` | **no** | deployment-scoped | allowed (unchanged) |

- **`config` is deliberately not owner-scoped.** It is deployment state, not user state;
  governing who may edit it is an admin-role question that belongs to Bridge. Treating it as
  user-owned would silently make deployment config editable by exactly one person.
- **Saved views default to `shared`, not `private`.** The deployment stance this serves is
  "every authenticated user may read all data" (§ below); making views private by default
  would restrict *less* sensitive artifacts than the data they describe, and would leave the
  shared-read path dead on arrival.
- **Forking replaces editing.** A non-owner who wants a shared view changed applies it and
  saves under a new name — which produces an owned copy through the existing save path. No
  new mutation, no new affordance.
- **`owner` is immutable after create.** A writable owner is a stealable owner.
- **Retirement is covered for free.** `remove()` retires by clearing the payload, which is an
  update — so the owner-only-update rule protects deletion with no extra check.

**Read scoping is a convenience partition; write scoping is the property that matters.**
This asymmetry is deliberate and is what makes the decision affordable. Under the deployment
stance above, a saved view contains filter predicates and column choices over data every
authenticated user may already read, so view *confidentiality* is worth very little. View
*integrity* — not losing curated work to a name collision or a stray click — is worth a lot.
Read scoping therefore stays client-side and is labeled as a partition, never claimed as a
boundary; write protection is pushed to the one place that can actually hold it.

**Aperture does not enforce this, and must not.** Aperture hides the affordance and declines
to issue the mutation; that is presentation, consistent with ADR-0029, and it is not a
guarantee — a determined user can still reach the same-origin GraphQL endpoint directly.
Enforcement belongs to the store. The reference implementation is a Mosaic
`AuthMiddleware` subclass (`mosaic.core.middleware`, already an ABC with actor extraction
implemented) that stamps `owner` from the verified actor header on create and rejects updates
where `owner != actor` — datahelix-platform/mosaic#178. Until that lands, the partition is advisory
and the UI says so. **ADR-0008 and ADR-0016 are preserved: Aperture holds no
authority, and enforcement is never added to it.**

**Capability-gated, so nothing breaks.** `owner`/`visibility` are recognized structurally and
**optionally** (the ADR-0029 pattern applied to the store itself): an endpoint carrying the
fields, with `owner` and `visibility` equality-filterable, enables per-user scoping; an
endpoint without them — every deployment on the 1.0.0 recipe — keeps today's shared-namespace
behavior, labeled in the footer. A viewer identity of `null` (no auth deployed, which is every
deployment today) likewise yields exactly the current behavior. The active mode is reported in
the control-plane status line beside the backend.

**Note on platform sec6 §6.3 ("Bridge is the sole PEP").** Owner-stamping in Mosaic is a
narrow, deliberate reading of that constraint rather than an exception to it: it enforces an
integrity constraint on a record's own provenance — the category of "you cannot rewrite
`created_at`" — using an actor Mosaic already extracts and already records on every
provenance event. It carries no roles, no configurable policy, and no viewer-dependent
predicates, so it is not a PDP. Bridge, when it arrives, injects the verified actor and gains
the ability to *relax* the rule for privileged roles (a curator editing team views);
enforcement of the base rule does not move. This is flagged explicitly because it is a
platform-spec judgment, not a free consequence of this ADR.

## Alternatives considered

- **Dedicated control-plane service / non-Hippo store.** More moving parts, loses
  provenance/validation reuse, contradicts the LinkML-on-Hippo reference impl in ADR-0017.
- **localStorage only for MVP.** No cross-browser drafts (undercuts L10's resume story), and
  persistence scope would be invisible to users.
- **Hard-coded `ApertureDocument` type name.** Simpler lookup, but breaks the
  derive-from-introspection discipline and couples the SPA to a recipe naming choice.
- **Hard delete for removals.** Contradicts W4.4; retirement keeps the audit trail and needs
  no delete mutation from Hippo.
- **Owner scoping enforced in the OIDC proxy.** The proxy would have to parse GraphQL
  mutations to find the document being written. That is the beginning of writing Bridge, in
  the component least suited to hold it. Rejected.
- **Per-user control-plane endpoints (one store per viewer).** Isolates cleanly but multiplies
  deployment state per user, makes sharing impossible, and abandons the co-location stance of
  ADR-0017's N5.4 amendment. Rejected.
- **Keep `(kind, name)` and prefix the name with the owner.** No schema change, but the owner
  is then unfilterable, unvalidatable, and forgeable by anyone who can type a name with a
  colon in it. Rejected as a false economy.
