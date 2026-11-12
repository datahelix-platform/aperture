import { describe, expect, it, vi } from 'vitest';
import type { HippoSource, ListOptions } from '../data/hippoSource';
import type { Neighborhood } from '../data/neighbors';
import { deriveNeighborsModel } from '../data/neighbors';
import { deriveCollections, type CollectionModel } from '../data/schemaModel';
import { certIntrospection } from '../data/testing/fixtures';
import { NO_CAPABILITIES } from '../data/capabilities';
import {
  expandNode,
  graphTier,
  tierLegend,
  type ExpandContext,
  type GraphSink,
} from './graphExpansion';

const collections = deriveCollections(certIntrospection);
const byType = new Map(collections.map((c) => [c.typeName, c]));
const byId = new Map(collections.map((c) => [c.id, c]));
const book = { id: 'Book:b1', entityId: 'b1', collectionId: 'books', typeName: 'Book' };

/** A recording sink with a node budget, like the canvas. */
function recordingSink(budget = 250) {
  const nodes = new Map<string, Record<string, unknown> | undefined>([['Book:b1', undefined]]);
  const edges: string[] = [];
  const notes: string[] = [];
  const sink: GraphSink = {
    addEntity(collection: CollectionModel, entityId, row) {
      const id = `${collection.typeName}:${entityId}`;
      if (nodes.has(id)) return id;
      if (nodes.size >= budget) {
        notes.push('budget');
        return null;
      }
      nodes.set(id, row);
      return id;
    },
    addEdge: (from, to, label) => edges.push(`${from} -${label}-> ${to}`),
    note: (m) => notes.push(m),
  };
  return { sink, nodes, edges, notes };
}

function fakeSource(hood?: Neighborhood) {
  const calls = { getNeighbors: 0, getEntity: 0, listEntities: [] as ListOptions[] };
  const source = {
    neighbors: hood ? deriveNeighborsModel(certIntrospection) : undefined,
    getNeighbors: vi.fn(async () => {
      calls.getNeighbors += 1;
      return hood!;
    }),
    getEntity: vi.fn(async () => {
      calls.getEntity += 1;
      return { id: 'b1', author: { id: 'a1' }, coAuthors: [{ id: 'a2' }] };
    }),
    listEntities: vi.fn(async (_id: string, options: ListOptions) => {
      calls.listEntities.push(options);
      return { rows: [{ id: 'r1', rating: 5 }], mayHaveMore: true };
    }),
  } as unknown as HippoSource;
  return { source, calls };
}

function ctx(source: HippoSource): ExpandContext {
  return { source, collections, byType, byId };
}

describe('graphTier', () => {
  it('uses the server tier only when neighbors is advertised and usable', () => {
    const { source } = fakeSource({ nodes: [], edges: [], notices: [] });
    expect(graphTier({ ...NO_CAPABILITIES, neighborsTraversal: true }, source)).toBe('server');
    expect(graphTier(NO_CAPABILITIES, source)).toBe('fallback');
    expect(graphTier({ ...NO_CAPABILITIES, neighborsTraversal: true }, fakeSource().source)).toBe(
      'fallback',
    );
  });

  it('names the tier in the legend', () => {
    expect(tierLegend('server', 3, 250, false)).toMatch(/^Server-side `neighbors` traversal \(3\/250 nodes\)/);
    expect(tierLegend('fallback', 3, 250, true)).toMatch(
      /^Client-side one-hop expansion \(3\/250 nodes, loading…\).*does not advertise/,
    );
  });
});

describe('server tier', () => {
  const hood: Neighborhood = {
    nodes: [
      { id: 'b1', type: 'Book', data: { title: 'T' } },
      { id: 'a1', type: 'Author', data: { name: 'Ada' } },
      { id: 'r1', type: 'Review', data: { rating: 4 } },
      { id: 'x1', type: 'Unknown', data: {} },
    ],
    edges: [
      { source: 'b1', target: 'a1', type: 'author' },
      { source: 'r1', target: 'b1', type: 'book' },
      { source: 'b1', target: 'x1', type: 'mystery' },
    ],
    notices: ['Column edges are out of scope under asOf.'],
  };

  it('expands with one neighbors call and no fallback reads', async () => {
    const { source, calls } = fakeSource(hood);
    const { sink, nodes, edges, notes } = recordingSink();
    await expandNode('server', ctx(source), book, sink);
    expect(calls).toEqual({ getNeighbors: 1, getEntity: 0, listEntities: [] });
    expect([...nodes.keys()]).toEqual(['Book:b1', 'Author:a1', 'Review:r1']);
    // Slot-keyed data re-keyed onto the collection's fields (the label reads them).
    expect(nodes.get('Author:a1')).toEqual({ name: 'Ada' });
    expect(edges).toEqual(['Book:b1 -Author-> Author:a1', 'Review:r1 -Book-> Book:b1']);
    expect(notes.join(' ')).toContain('Column edges are out of scope under asOf.');
    expect(notes.join(' ')).toContain('1 neighbor of a type this endpoint does not expose');
  });

  it('keeps the node budget', async () => {
    const { source } = fakeSource(hood);
    const { sink, nodes, notes } = recordingSink(2);
    await expandNode('server', ctx(source), book, sink);
    expect(nodes.size).toBe(2);
    expect(notes).toContain('budget');
  });
});

describe('fallback tier', () => {
  it('reads forward refs via detail and reverse refs via filtered first pages', async () => {
    const { source, calls } = fakeSource();
    const { sink, nodes, edges, notes } = recordingSink();
    await expandNode('fallback', ctx(source), book, sink);
    expect(calls.getNeighbors).toBe(0);
    expect(calls.getEntity).toBe(1);
    expect(calls.listEntities).toEqual([
      { page: 1, pageSize: 25, conditions: [{ field: 'book', value: 'b1' }] },
    ]);
    expect([...nodes.keys()]).toEqual(['Book:b1', 'Author:a1', 'Author:a2', 'Review:r1']);
    expect(edges).toEqual([
      'Book:b1 -Author-> Author:a1',
      'Book:b1 -Co authors-> Author:a2',
      'Review:r1 -Book-> Book:b1',
    ]);
    expect(notes[0]).toMatch(/exceed 25 — showing the first page only/);
  });
});
