/**
 * The typed capability set the Layer-D adapter negotiates with the active
 * endpoint (ADR-0017/0029, N5.1). Every flag is derived from what the endpoint
 * actually advertises via introspection — never assumed, never faked. The UI
 * gates features on these and degrades honestly when they are absent.
 */
export interface Capabilities {
  /** 'hippo' = `hippoSchema` enrichment available; 'graphql' = standard `__schema` only. */
  schemaIntrospection: 'hippo' | 'graphql' | 'none';
  /** Collection list fields accept limit/offset args. */
  offsetPagination: boolean;
  /** Collection list fields accept an equality filter arg. */
  equalityFacets: boolean;
  /** A full-text-search arg/field is advertised. */
  fullTextSearch: boolean;
  /** Server-side ordering (order_by/sort arg) — Hippo X1; gated off until it lands. */
  sort: boolean;
  /**
   * Per-value counts for equality facets are derivable — a genuine
   * `<collection>FacetCounts(field: String!) -> [{value count}]` Query field
   * is advertised (Mosaic ADR-0007/X1), not just a name match (ADR-0029).
   */
  aggregation: boolean;
  /**
   * Numeric/date range facets are derivable — a genuine
   * `<collection>FieldRange(field: String!) -> {min max}` Query field is
   * advertised (Mosaic ADR-0007/X1, issue #61), not just a name match
   * (ADR-0029). Independent of `aggregation` (facetCounts) — an endpoint may
   * advertise one without the other.
   */
  rangeFacets: boolean;
  /** Entity types expose resolved relationship fields. */
  relationshipTraversal: boolean;
  /** An entityHistory-style query is advertised (detail-view history, R3.7). */
  entityHistory: boolean;
  /** Batch unit-of-work mutations (whole-set dry-run + atomic commit; Hippo #84). */
  batchWrite: boolean;
  /**
   * The flat-filter operator vocabulary the endpoint advertises — the member
   * names of its `FilterOp` enum (Mosaic ADR-0006: the introspected schema is
   * the capability contract). `["EQ"]`-era endpoints predate the enum;
   * v0.12+ advertises `EQ`/`IN`; the typed-filter increments add
   * `NEQ`/`GT`/`GTE`/`LT`/`LTE`/`CONTAINS`/`IS_NULL`.
   */
  filterOps: readonly string[];
  /** Generated `where: <Type>Filter` inputs advertised (Mosaic ADR-0006 inc. 2). */
  whereFilter: boolean;
  /**
   * A usable conversational query mutation is advertised (ADR-0039). The
   * endpoint hosts the planning service; Aperture only sends turns and renders
   * what comes back, so absence simply means no chat affordance at all.
   */
  conversationalQuery: boolean;
  /**
   * A usable server-side `neighbors(id, depth)` traversal root is advertised
   * (ADR-0037 server tier; Mosaic v0.13.0+). Absent → the graph view expands
   * through the client-side one-hop fallback.
   */
  neighborsTraversal: boolean;
}

export const NO_CAPABILITIES: Capabilities = {
  schemaIntrospection: 'none',
  offsetPagination: false,
  equalityFacets: false,
  fullTextSearch: false,
  sort: false,
  aggregation: false,
  rangeFacets: false,
  relationshipTraversal: false,
  entityHistory: false,
  batchWrite: false,
  filterOps: [],
  whereFilter: false,
  conversationalQuery: false,
  neighborsTraversal: false,
};
