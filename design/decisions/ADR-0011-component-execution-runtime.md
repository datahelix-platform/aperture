# ADR-0011: Component execution runtime and language

- **Status:** Proposed  — ⛔ **Deferred from MVP** (ADR-0026; decided 2026-11-10)
- **Date:** 2026-06-13 (deferred 2026-11-10, decision pass)
- **Deciders:** labadorf (deferral)
- **Related:** handoff §9.1 (open question Q1) + the technology question (JS/TS vs Pyodide/WASM); depends on ADR-0010; constrained by ADR-0006, ADR-0008, ADR-0009

## Context

Where do Type-B components execute, and in what language? Server-side (Python, sandboxed,
Langflow-like) vs. client-side (JS/TS in a Web Worker / iframe). This decision *defines what
the sandbox actually is*. It must satisfy: headless validation with no browser (ADR-0006,
ADR-0009), no ambient authority with an injected capability-scoped client (ADR-0008), and a
serializable-view-description output (ADR-0009).

A tension: a data portal with viz is a natural fit for client-side-in-worker producing a
view-spec, but that constrains components to JS/TS — potentially clashing with a
Python-centric user base who would rather write analysis in Python.

## Decision (proposed)

**Client-side, Web Worker, view-spec-emitting components** as the default sandbox.

- If ADR-0010 holds (heavy compute pushed into the query/binding layer), a component is a thin
  pure function `(data, params) → viewDescription`. A Web Worker is then the strongest,
  simplest sandbox: no DOM, no ambient network, and the `postMessage` / structured-clone
  boundary *is* the injected capability-scoped client of ADR-0008.
- One runtime serves both the render-contract check and live rendering (ADR-0009 already
  specifies "Node / Web Worker" for the headless check).
- The "Python user base" objection weakens: users write declarative bindings + thin
  view-mappers, not in-component analysis.

**Two escape valves for genuine Python need:**
1. Real analysis (e.g. a `lifelines` survival fit) belongs to a Canon/Cappella-style computed
   result whose output Aperture binds to — not the view layer.
2. If the ADR-0010 probe proves in-portal Python is genuinely needed: **Pyodide (WASM) inside
   the same Web Worker boundary** — same threat model, gives Python, at a bundle/perf cost.
   *(User reaction 2026-06-13: liked the Pyodide approach.)*

## Consequences

- Locks the sandbox to the Web Worker boundary; WASM (Pyodide and potentially other
  WASM-compiled component runtimes) is admissible only *inside* that boundary, never as a
  parallel ambient-authority path.
- Aperture ships a JS/TS component SDK and view-description types; Python authoring, if
  adopted, rides Pyodide on the same contract.

## Notes / open sub-questions

- Ratify only after ADR-0010's survival-curve probe: the runtime answer is contingent on the
  vocabulary answer.
- "General WASM compatibility for components" (raised 2026-06-13) is in scope here: decide
  whether the boundary admits arbitrary WASM modules or only the Pyodide escape hatch.
- Open: SSR/app-shell rendering of the realized view spec is a separate decision (ADR-0014).

### WASM's three distinct roles (2026-06-15 analysis)

"Should we use WASM?" conflates three unrelated roles; keep them separate:

1. **Language for components** — Pyodide is CPython-in-WASM, so "Python components" *is* WASM.
   **Verdict:** escape hatch, not baseline (Pyodide is ~10MB+, slow cold start). JS/TS by
   default; load Pyodide-in-Worker only when a component declares it needs Python.
2. **The sandbox boundary itself** — components as WASM modules for memory isolation +
   capability-by-import. **Verdict:** overkill as baseline — a Web Worker already gives
   no-DOM + no-ambient-network + the `postMessage` capability boundary (ADR-0008). Keep Worker
   as the boundary; let WASM live *inside* it (role 1). WASM-grade isolation only earns its
   keep for genuinely untrusted multi-language components.
3. **Client-side compute engine** — DuckDB-WASM / Polars-WASM for in-browser aggregation.
   **Verdict:** attractive given Hippo's thin GraphQL (equality filters, offset pagination),
   but it belongs in the **layer-D source adapter** (compensating for a thin source), hidden
   behind the capability protocol — **never** a user-facing config/scripting surface, or it
   becomes the middle layer ADR-0004 rejects.

Net: WASM rides *inside* the Web Worker boundary (roles 1 and 3); it does not replace it
(role 2).

## Deferral note (2026-11-10)

Deferred from MVP by labadorf in the 2026-11-10 decision pass, using the same pattern as
ADR-0013's deferral under ADR-0026. `implementation-plan.md` already lists the component
sandbox (ADR-0011) as deferred, and the Tier-1 workflow shipped without it: ADR-0033 builds it
as steps-as-data interpreted by a pure reducer engine, not a sandboxed Type-B component. The
earlier claim in ADR-0026 and ADR-0027 that this substrate "stays in MVP because the Tier-1
workflow needs it" is corrected by amendment notes on those ADRs. This ADR stays gated on
ADR-0010's successor (the platform View Contract).
