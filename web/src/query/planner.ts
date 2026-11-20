import type { Capabilities } from '../data/capabilities';
import type { FilterCondition, MosaicSource } from '../data/mosaicSource';
import type { CollectionModel } from '../data/schemaModel';
import { slotName } from '../data/schemaModel';
import type { Criterion, FieldCondition, QuerySpec } from './querySpec';
import { deriveEdges, edgeByKey, filterOpMember, resolveAnchor } from './querySpec';
import { compileWhere } from './whereCompiler';
import type { PathColumn } from '../data/selection';
import { selectionForPaths } from '../data/selection';

/**
 * The QuerySpec planner (ADR-0035): server-first execution with one declared
 * compensation tier. Field conditions compile to the flat typed `filters:`
 * list; RelatedConditions compile to a **server-assisted semijoin** — query
 * the related collection with the sub-criteria, collect the linking ids, and
 * filter the anchor with one native `in` — until the endpoint advertises
 * relationship predicates (Mosaic ADR-0006 M5), at which point only this
 * planner changes, never the artifact. Every cap is visible (ADR-0029).
 */

/** Semijoin id budget — one capped related-side page (ADR-0035, visible cap). */
export const SEMIJOIN_CAP = 500;

export interface QueryRunResult {
  rows: Record<string, unknown>[];
  total?: number;
  mayHaveMore: boolean;
  /** Honesty notes: caps hit, compensation tier, empty semijoins. */
  notes: string[];
  /**
   * How relationship criteria executed. 'server' — compiled to the typed
   * `where:` input and pushed down whole; 'compensated' — at least one ran as
   * a client-planned semijoin; null — the spec had none.
   */
  relationshipTier: 'server' | 'compensated' | null;
  /** The compiled anchor conditions (for export page-through re-use). */
  anchorConditions: FilterCondition[];
  filterMode: 'AND' | 'OR';
  /** The typed filter sent, when the spec compiled to one (for export re-use). */
  where?: Record<string, unknown>;
  /** The compiled traversal selection, so the export asks for the same fields. */
  pathSelection?: string;
}

function toFilterCondition(c: FieldCondition): FilterCondition {
  return {
    field: c.slot,
    value: c.value,
    op: c.op === 'eq' ? undefined : filterOpMember(c.op),
  };
}

export async function runQuerySpec(
  source: MosaicSource,
  collections: CollectionModel[],
  capabilities: Capabilities,
  spec: QuerySpec,
  page: number,
  pageSize: number,
  /** Result columns reached through a reference (ADR-0041). */
  paths?: PathColumn[],
): Promise<QueryRunResult> {
  const anchor = resolveAnchor(spec, collections);
  if (!anchor) throw new Error(`This endpoint exposes no type “${spec.anchor}”`);
  const edges = deriveEdges(anchor, collections);
  const notes: string[] = [];
  let relationshipTier: QueryRunResult['relationshipTier'] = null;

  /**
   * Server-first (ADR-0035): compile as much of the spec as the endpoint's
   * typed `where:` input can express, and compensate only the remainder.
   *
   * **Mixing is legal only under AND.** The server composes `filters` with
   * `where` by AND — its own documented contract — so an AND-mode spec can
   * push some criteria down and compensate the rest. Under OR the two would
   * not mean what the spec says, so a partially-compilable OR spec falls back
   * to the legacy path entirely rather than running a subtly wrong query.
   */
  const compiled = compileWhere(spec, anchor, collections);
  const canMix = spec.mode === 'AND' || compiled.uncompiled.length === 0;
  const usingWhere = compiled.where != null && canMix;
  const toCompensate: Criterion[] = usingWhere ? compiled.uncompiled : [...spec.criteria];

  if (usingWhere && compiled.uncompiled.length === 0) {
    relationshipTier = spec.criteria.some((c) => c.kind === 'related') ? 'server' : null;
  }

  const anchorConditions: FilterCondition[] = [];
  for (const criterion of toCompensate) {
    if (criterion.kind === 'field') {
      anchorConditions.push(toFilterCondition(criterion));
      continue;
    }

    // Compensated semijoin tier (ADR-0035): related-side query → id set →
    // one `in` condition on the anchor.
    const edge = edgeByKey(edges, criterion.edge);
    if (!edge) throw new Error(`Unknown relationship “${criterion.edge}”`);
    relationshipTier = 'compensated';
    const related = collections.find((c) => c.id === edge.relatedCollectionId);
    // Reverse edges extract linking ids from the related side's reference
    // column, which the curated table selection may not include — request it.
    const refColumn =
      edge.direction === 'reverse'
        ? related?.detailColumns.find((col) => col.field === edge.refField)
        : undefined;
    const relatedPage = await source.listEntities(edge.relatedCollectionId, {
      page: 1,
      pageSize: SEMIJOIN_CAP,
      conditions: criterion.criteria.map(toFilterCondition),
      filterMode: 'AND',
      extraColumns: refColumn ? [refColumn] : undefined,
    });

    const ids = new Set<string>();
    for (const row of relatedPage.rows) {
      const value =
        edge.direction === 'forward'
          ? // Anchor's reference points at the related row: link by its id.
            row[related?.idColumn ?? 'id']
          : // The related row's reference points back at the anchor.
            (row[edge.refField] as Record<string, unknown> | null)?.[edge.refTargetIdField];
      if (value != null) ids.add(String(value));
    }
    if (relatedPage.mayHaveMore) {
      notes.push(
        `Relationship criterion on ${edge.label} matched ≥${SEMIJOIN_CAP} related ` +
          `records — results may be incomplete (semijoin cap; server-side ` +
          `relationship predicates lift this).`,
      );
    }
    if (ids.size === 0) {
      notes.push(`Relationship criterion on ${edge.label} matched no related records.`);
    }
    anchorConditions.push({
      field: edge.direction === 'forward' ? slotName(edge.refField) : 'id',
      value: [...ids],
      op: 'IN',
    });
  }

  // Compiled here rather than in the source adapter: resolving a path needs the
  // whole collection graph, which that layer never holds.
  const pathSelection = paths?.length
    ? selectionForPaths(paths, anchor, collections) || undefined
    : undefined;

  const result = await source.listEntities(anchor.id, {
    page,
    pageSize,
    pathSelection,
    conditions: anchorConditions,
    // A mixed query ANDs the compensations onto `where`; the spec's own mode
    // already lives inside the typed input, so re-applying it here would
    // double-count it.
    filterMode: usingWhere ? 'AND' : spec.mode,
    where: usingWhere ? compiled.where ?? undefined : undefined,
  });

  if (relationshipTier === 'compensated') {
    notes.push(
      'Some relationship criteria ran as a client-planned semijoin (compensated tier) — ' +
        'exact but capped. This endpoint exposes no predicate for that edge; declaring the ' +
        'inverting slot in the schema (Mosaic ADR-0011) moves it to the server.',
    );
  }
  if (usingWhere && compiled.uncompiled.length > 0) {
    notes.push(
      `${compiled.uncompiled.length} of ${spec.criteria.length} criteria compiled to the ` +
        'server’s typed filter; the rest were compensated client-side and combined with AND.',
    );
  }
  if (!usingWhere && compiled.where != null) {
    notes.push(
      'This query mixes OR with a criterion the endpoint cannot express, so all of it ran ' +
        'through the flat filter list — the typed filter and a client compensation cannot be ' +
        'combined under OR without changing what the query means.',
    );
  }
  void capabilities;

  return {
    rows: result.rows,
    total: result.total,
    mayHaveMore: result.mayHaveMore,
    notes,
    relationshipTier,
    anchorConditions,
    filterMode: usingWhere ? 'AND' : spec.mode,
    where: usingWhere ? compiled.where ?? undefined : undefined,
    pathSelection,
  };
}
