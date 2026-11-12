import type { HippoSource } from '../data/hippoSource';
import type { Capabilities } from '../data/capabilities';
import type { CollectionModel } from '../data/schemaModel';
import { slotName } from '../data/schemaModel';

/**
 * The graph view's two data tiers (ADR-0037). The view is the same in both;
 * only how a node's neighbors are fetched differs:
 *
 * - **server** — one `neighbors(id, depth: 1)` request per expansion, when the
 *   endpoint advertises a usable root (Mosaic v0.13.0+).
 * - **fallback** — client-side one hop: a detail read for forward reference
 *   edges plus a filtered first-page lookup per reverse reference column.
 *
 * Both write into the canvas through a `GraphSink`, which owns the node budget,
 * so the budget and its "not shown" disclosure hold in either tier.
 */

export const EXPAND_LIMIT = 25;

export type GraphTier = 'server' | 'fallback';

export function graphTier(capabilities: Capabilities, source: HippoSource): GraphTier {
  return capabilities.neighborsTraversal && source.neighbors ? 'server' : 'fallback';
}

/** The node being expanded. */
export interface ExpandTarget {
  /** The canvas node id. */
  id: string;
  entityId: string;
  collectionId: string;
  typeName: string;
}

/** The honesty line: which data tier is in use and what it means (ADR-0029). */
export function tierLegend(
  tier: GraphTier,
  nodeCount: number,
  budget: number,
  busy: boolean,
): string {
  const count = `${nodeCount}/${budget} nodes${busy ? ', loading…' : ''}`;
  return tier === 'server'
    ? `Server-side \`neighbors\` traversal (${count}) — each expansion is one request ` +
        `for the node's one-hop neighborhood; the server discloses any bound it hits.`
    : `Client-side one-hop expansion (${count}) — the endpoint does not advertise a ` +
        `server-side \`neighbors\` traversal, so edges appear as you expand nodes, ` +
        `first pages only.`;
}

export interface GraphSink {
  /** Adds (or finds) a node; null when the node budget refused it. */
  addEntity(collection: CollectionModel, entityId: string, row?: Record<string, unknown>): string | null;
  addEdge(from: string, to: string, label: string): void;
  /** A user-visible disclosure (truncation, unresolved types, server notices). */
  note(message: string): void;
}

export interface ExpandContext {
  source: HippoSource;
  collections: CollectionModel[];
  byType: Map<string, CollectionModel>;
  byId: Map<string, CollectionModel>;
}

export async function expandNode(
  tier: GraphTier,
  ctx: ExpandContext,
  node: ExpandTarget,
  sink: GraphSink,
): Promise<void> {
  if (tier === 'server') await expandViaNeighbors(ctx, node, sink);
  else await expandViaFallback(ctx, node, sink);
}

/** Server tier: one `neighbors` call, rendered as returned. */
async function expandViaNeighbors(
  { source, byType }: ExpandContext,
  node: ExpandTarget,
  sink: GraphSink,
): Promise<void> {
  const hood = await source.getNeighbors(node.entityId);
  const nodeIds = new Map<string, string>([[node.entityId, node.id]]);
  const typeOf = new Map<string, CollectionModel>();
  const center = byType.get(node.typeName);
  if (center) typeOf.set(node.entityId, center);

  let unresolved = 0;
  for (const n of hood.nodes) {
    if (n.id === node.entityId) continue;
    const collection = n.type ? byType.get(n.type) : undefined;
    if (!collection) {
      unresolved += 1;
      continue;
    }
    typeOf.set(n.id, collection);
    const added = sink.addEntity(collection, n.id, rowFromData(collection, n.data));
    if (added) nodeIds.set(n.id, added);
  }
  for (const e of hood.edges) {
    const from = nodeIds.get(e.source);
    const to = nodeIds.get(e.target);
    if (!from || !to) continue;
    sink.addEdge(from, to, edgeLabel(typeOf.get(e.source), e.type));
  }

  const notes = [...hood.notices];
  if (unresolved > 0) {
    notes.push(
      `${unresolved} neighbor${unresolved === 1 ? '' : 's'} of a type this endpoint does not ` +
        `expose as a collection ${unresolved === 1 ? 'is' : 'are'} not shown.`,
    );
  }
  if (notes.length > 0) sink.note(notes.join(' '));
}

/**
 * A server node's `data` is keyed by LinkML slot name; the canvas reads rows
 * by GraphQL field name (for the node label), so re-key onto the collection's
 * columns.
 */
function rowFromData(
  collection: CollectionModel,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of collection.detailColumns) {
    const value = data[column.field] ?? data[slotName(column.field)];
    if (value !== undefined) row[column.field] = value;
  }
  return row;
}

/** The referencing column's label when the source type has it, else the slot name. */
function edgeLabel(sourceCollection: CollectionModel | undefined, slot: string): string {
  const column = sourceCollection?.detailColumns.find(
    (c) => c.field === slot || slotName(c.field) === slot,
  );
  return column?.label ?? slot;
}

/** Fallback tier: forward reference edges + reverse lookups, first pages only. */
async function expandViaFallback(
  { source, collections, byType, byId }: ExpandContext,
  node: ExpandTarget,
  sink: GraphSink,
): Promise<void> {
  const collection = byId.get(node.collectionId);
  if (!collection) return;
  // Forward: the entity's own reference fields, from a detail read.
  if (collection.detail) {
    const entity = await source.getEntity(collection.id, node.entityId);
    if (entity) {
      for (const column of collection.detailColumns) {
        if (column.kind !== 'ref' && column.kind !== 'refList') continue;
        const target = column.targetType && byType.get(column.targetType);
        if (!target || !column.targetIdField) continue;
        const raw = entity[column.field];
        const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        for (const v of values) {
          const targetId = (v as Record<string, unknown>)?.[column.targetIdField];
          if (targetId == null) continue;
          const added = sink.addEntity(target, String(targetId));
          if (added) sink.addEdge(node.id, added, column.label);
        }
      }
    }
  }
  // Reverse: collections whose reference column points at this type
  // (full field set — the table budget truncates reference columns).
  for (const other of collections) {
    for (const column of other.detailColumns) {
      if (column.kind !== 'ref' || column.targetType !== node.typeName) continue;
      const result = await source.listEntities(other.id, {
        page: 1,
        pageSize: EXPAND_LIMIT,
        conditions: [{ field: slotName(column.field), value: node.entityId }],
      });
      if (result.mayHaveMore) {
        sink.note(
          `${other.label} referencing this ${node.typeName} exceed ${EXPAND_LIMIT} — ` +
            `showing the first page only.`,
        );
      }
      for (const row of result.rows) {
        const id = row[other.idColumn ?? ''];
        if (id == null) continue;
        const added = sink.addEntity(other, String(id), row);
        if (added) sink.addEdge(added, node.id, column.label);
      }
    }
  }
}
