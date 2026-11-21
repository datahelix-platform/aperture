# Aperture — Reference Architecture (orientation)

**Status:** 🟢 Orientation doc — ties the decisions together; the ADRs in `decisions/` are
authoritative for each choice. Last updated 2026-06-15.

This is the "how it all fits" map. Aperture is a **generic front end over any GraphQL
endpoint** (ADR-0002), config-driven (ADR-0003/0004), with novel behavior delivered by typed
sandboxed components (ADR-0009). Read this for orientation; cite the ADRs for decisions.

## Layered model

```
┌──────────────────────────────────────────────────────────────────┐
│ A. App shell / delivery            SPA | SSR | hybrid   (ADR-0014) │
├──────────────────────────────────────────────────────────────────┤
│ B. Rendering engine: view-description → pixels                     │
│      realizes the typed primitive catalog (ADR-0010); JS chart libs│
│      cross-links/hrefs as a typed primitive (ADR-0015)             │
├──────────────────────────────────────────────────────────────────┤
│ C. Component runtime / sandbox     (data,params)→viewDesc (ADR-0011)│
│      Web Worker boundary; WASM rides *inside* it (see WASM roles)  │
├──────────────────────────────────────────────────────────────────┤
│ D. Data access: capability-negotiated GraphQL source adapter(s)    │
│      generic __schema introspection + per-source enrichment        │
│      ── data plane: N sources; Mosaic now, Canon/Cappella later ──  │
│      capability-scoped client seam (ADR-0008) lives here           │
├──────────────────────────────────────────────────────────────────┤
│ E. Config & state store (control plane)   LinkML-on-Mosaic (ADR-0003)│
└──────────────────────────────────────────────────────────────────┘
```

The high-level questions map onto layers: "server vs client" is **A** (ADR-0014); "WASM"
touches **C** and possibly **D**; "composability / cross-links" is **B** (ADR-0015); "generic
over any GraphQL" + multi-source is **D** (ADR-0002, ADR-0017).

## Data plane vs. control plane (ADR-0017)

- **Data plane** — the GraphQL endpoint(s) Aperture *browses*; many, heterogeneous,
  introspection-driven. Mosaic (formerly Hippo) first.
- **Control plane** — Aperture's *own* config + user state; one store, LinkML-on-Mosaic
  reference impl (a port, not a hard dependency).
- Mosaic can be the control-plane store even when the data plane points elsewhere.

## Layer D: capability-negotiated source adapter

To be generic over "any GraphQL endpoint," the adapter **declares capabilities** (faceting,
full-text, cursor pagination, relationship traversal, aggregation) and the UI **gates
features** accordingly — the same pattern Mosaic uses for its own TUI backends. Baseline =
standard `__schema` introspection; per-source enrichment = Mosaic's `mosaicSchema` /
`mosaicEntityType`, or a Canon/Cappella adapter later. This is the natural next code artifact
(a GraphQL backend alongside the kept SDK/REST `backends/`). Internal cross-links come from
resolved relationship fields; external hrefs from a `system → URL-template` map (ADR-0015).

## Where WASM fits — three distinct roles (see ADR-0011)

WASM is not one decision. Three roles, three verdicts:

| Role | Meaning | Verdict |
|---|---|---|
| **Language for components** | Pyodide = CPython-in-WASM ⇒ "Python components" *is* WASM | Escape hatch, not baseline. JS/TS default; load Pyodide-in-Worker only when a component declares it needs Python. |
| **Sandbox boundary itself** | Components as WASM modules for memory isolation | Overkill as baseline — a Web Worker already gives no-DOM + no-ambient-network + the `postMessage` capability boundary. Let WASM live *inside* the Worker. |
| **Client-side compute engine** | DuckDB-WASM / Polars-WASM for in-browser aggregation | Attractive given Mosaic's thin GraphQL — but it belongs in the layer-D adapter (compensating for a thin source), hidden behind the capability protocol, **never** exposed as user config/scripting (preserves ADR-0004's "no middle layer"). |

## Security & the BFF (platform sec6, ADR-0016)

Authorization lives in **Bridge** (PEP/PDP), not Aperture or Mosaic. The "thin BFF in front of
Mosaic" that a multi-source, per-viewer model wants **is Bridge** — same component as the auth
gateway (so app-architecture decision ADR-0014's BFF candidate = Bridge). Aperture talks the
same GraphQL contract to Mosaic directly (local, no auth) or Bridge (enforcing); the only
variable is the injected capability-scoped client (ADR-0008). **Bridge is deferred**
(ADR-0016): Aperture is built/demoed against Mosaic directly, with the capability-scoped client
present as a no-op pass-through so Bridge later is a swap, not a retrofit. Full model:
`DataHelix/platform/design/sec6_security_model.md`.

## Sequencing

Per handoff §8 and ADR-0016: schema-derived browse + faceted search against Mosaic first
(highest-visibility, demonstrable), then the dry-run validator + Type-A agent loop, then the
typed component contract. Bridge enforcement drops in later without changing Aperture.
Keystone open decision: **ADR-0010** (view-vocabulary noun-catalog) — its survival-curve probe
gates the runtime/architecture chain.
