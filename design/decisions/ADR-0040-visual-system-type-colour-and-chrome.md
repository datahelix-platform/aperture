# ADR-0040: A visual system — colour carries type identity, chrome is distinct from content

- **Status:** Accepted (as built)
- **Date:** 2026-09-11 (ratified 2026-11-10, decision pass)
- **Deciders:** labadorf, design session
- **Related:** ADR-0030 (frontend stack — pinned deps), ADR-0031 (app-shell layout library), ADR-0037 (graph exploration view), ADR-0002 (generic source, no domain nouns), ADR-0029 (capability-gated honest degradation)

## Context

The portal renders correctly and reads clearly, but it reads *flat*: white surfaces on a
near-white canvas, hairline borders, one accent colour used for every emphasis, no depth and no
motion. Structure was legible; hierarchy was not. Nothing on the screen said "this is an
instrument for looking at data" rather than "this is a form".

Two facts made this cheap to fix without new dependencies (ADR-0030 pins the stack, and this pass
added nothing to it):

1. **A per-type colour already existed but was trapped.** ADR-0037's graph view hashed each type
   name to a palette entry to fill Cytoscape nodes. That colour stopped at the canvas edge, so a
   type was colour-identified in the graph and anonymous in every other surface — the nav, the
   table header, the type chip.
2. **The token layer was already the single source of colour** (`styles/tokens.css`), and
   `query/graphTheme.ts` already bridges tokens into the canvas. So a systemic change could be
   made almost entirely in tokens and CSS, leaving components and their tests untouched.

## Decision

**Colour means type identity, not decoration; and the frame the app is read *through* is visually
distinct from the surfaces data is read *on*.**

Concretely:

1. **One type-colour module, app-wide.** `data/typeColor.ts` owns the palette and the hash;
   `GraphView` imports it rather than keeping its own copy. A type wears one hue everywhere — nav
   chip and active marker, collection title rule, type chip, table header wash, row-hover edge,
   card spine, graph node. Two hashes would drift and a type showing different colours on
   different surfaces is worse than no colour at all. Derived tints are computed in CSS with
   `color-mix()` from a `--type-color` custom property set on the element, so no consumer
   hard-codes a second set of colours.
2. **Chrome vs. content.** Header, primary nav and footer are deep ink (`--chrome-*`); working
   surfaces stay light. The working canvas carries a faint 22px plotting grid — texture under the
   data, drawn with two gradients, no asset.
3. **Chrome tokens are named for their role, never for a theme.** The dark rail is a permanent
   chrome zone within the light theme, *not* the `[data-theme='dark']` follow-on that
   `tokens.css` anticipates. Keeping the namespaces separate means the real dark theme will
   re-point `--bg-*` without touching a single `--chrome-*` value.
4. **Depth and motion are systemic, not per-component.** One elevation scale (`--shadow-*`), one
   easing and duration scale (`--ease-out`, `--dur-*`), one shared `rise` entrance. A single
   global `prefers-reduced-motion` guard in `global.css` covers every animation and transition in
   the app, so a component author cannot forget it.

## Consequences

- Colour is now load-bearing information, which imposes an obligation: it must never be the
  **only** signal. Every coloured affordance keeps its text label, and the palette is small enough
  that types collide past eight — acceptable precisely because the colour is a recognition aid,
  never a discriminator the user must rely on.
- The visual layer sits almost entirely in tokens and CSS. The tests assert roles and text, not
  appearance, and all 294 continued to pass across this pass — which also means **tests cannot
  catch a regression here**; screenshots of the dense surfaces are the check.
- A tinted, textured canvas raises the floor for contrast work. Any future surface must be checked
  against the chrome as well as the canvas: `identity-error` already needed lightening, since the
  content-surface `--error` cannot carry itself against deep ink.
- Empty states became more load-bearing, not less: with a textured canvas behind them, a bare
  centred sentence reads as an unfinished render. The query blank state now draws an
  anchor→edge→match schematic in CSS — a diagram of what a run *would* produce, marked
  `aria-hidden`, inventing no data.

## Alternatives considered

- **Add a UI/component library (shadcn, Radix, Tailwind) for a modern look.** Rejected: ADR-0030
  pins the stack and the app is hand-rolled CSS on tokens. The flatness was a token and hierarchy
  problem, not a component problem — importing a library would have bought a different default
  aesthetic at the cost of the design system Aperture already owns.
- **Go fully dark.** Rejected: dense tabular data reads better on light surfaces, and a wholesale
  inversion would pre-empt the real `[data-theme='dark']` work rather than enabling it. The
  chrome/content split gets the depth a dark UI is reaching for while keeping data on paper.
- **Assign colours from config, or per collection rather than per type.** Rejected: a hash of the
  type name is stable under reordering, hiding and addition, needs no config surface, and keeps
  the source generic (ADR-0002). Config-assigned palettes are a follow-on if a deployment ever
  needs brand control.
- **Put real data in the chrome** (row counts beside each nav item) to make the app feel alive.
  Rejected: it would fire N queries on every page load to decorate a sidebar, and the honest
  count is only available where the page envelope carries a `total`. Liveliness is not worth
  buying with per-render fan-out.

## Notes / open sub-questions

- Ratify `Proposed` → `Accepted` once the visual system has been seen against a real endpoint with
  more than a handful of types — eight-plus collections is where palette collisions first become
  observable and where the recognition claim is actually tested.
- The `[data-theme='dark']` block remains the outstanding follow-on. This ADR's contribution is
  that it is now a *smaller* job: chrome is already dark-correct, so the work is confined to the
  `--bg-*` / `--text-*` / `--border` families plus a `color-scheme` flip.
- Type colour is not yet applied to reference cells (`cell-ref`) or to the entity-detail header,
  where it would also carry meaning. Deliberate: those surfaces name a *target* type, and
  colouring them needs a rule for which type wins before it is worth doing.

## Ratification note (2026-11-10)

Ratified by labadorf in the 2026-11-10 decision pass, **as built**. Checked against the code:
`web/src/data/typeColor.ts` is the single palette and hash (`typeColor`, `typeColorStyle`
setting `--type-color`), and `GraphView` imports it. `styles/tokens.css` carries the
role-named `--chrome-*` tokens, the `--shadow-*` elevation scale and the `--ease-out` /
`--dur-*` motion scale. `styles/global.css` holds the shared `rise` keyframe and the single
global `prefers-reduced-motion` guard.

The Notes condition ("ratify once seen against eight-plus collections") is waived by this
ratification. Watch for palette collisions on larger deployments, and treat them as follow-up
work rather than grounds to reopen the decision. The dark-theme follow-on and type colour on
reference cells remain open, as the Notes describe.
