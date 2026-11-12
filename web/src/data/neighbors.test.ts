import { describe, expect, it } from 'vitest';
import { certIntrospection, realIntrospection } from './testing/fixtures';
import { buildNeighborsQuery, deriveNeighborsModel, normalizeNeighborhood } from './neighbors';
import { deriveCapabilities, deriveCollections } from './schemaModel';
import type { IntrospectionSchema } from './introspection';

describe('deriveNeighborsModel (ADR-0037 server tier)', () => {
  it('derives the Mosaic v0.13+ neighbors root', () => {
    const model = deriveNeighborsModel(certIntrospection);
    expect(model).toMatchObject({
      field: 'neighbors',
      idArg: 'id',
      idArgType: 'ID!',
      depthArg: 'depth',
      depthArgType: 'Int!',
      nodes: 'nodes',
      nodeFields: { id: 'entityId', type: 'entityType', data: 'data' },
      edges: 'edges',
      edgeFields: { source: 'source', target: 'target', type: 'type' },
      notices: 'notices',
    });
    expect(deriveCapabilities(certIntrospection, deriveCollections(certIntrospection)).neighborsTraversal).toBe(true);
  });

  it('is absent on an endpoint that predates it', () => {
    expect(deriveNeighborsModel(realIntrospection)).toBeUndefined();
    expect(deriveCapabilities(realIntrospection, deriveCollections(realIntrospection)).neighborsTraversal).toBe(false);
  });

  it('is not a capability on a name match alone', () => {
    const schema = structuredClone(certIntrospection) as IntrospectionSchema;
    const graph = schema.types.find((t) => t.name === 'GraphEdge')!;
    graph.fields = (graph.fields ?? []).filter((f) => f.name !== 'target');
    expect(deriveNeighborsModel(schema)).toBeUndefined();
  });
});

describe('buildNeighborsQuery / normalizeNeighborhood', () => {
  const model = deriveNeighborsModel(certIntrospection)!;

  it('asks for one hop', () => {
    const { document, variables } = buildNeighborsQuery(model, 'b1');
    expect(document).toBe(
      'query ApertureNeighbors($id: ID!, $depth: Int!) { neighbors(id: $id, depth: $depth) ' +
        '{ nodes { entityId entityType data } edges { source target type } notices } }',
    );
    expect(variables).toEqual({ id: 'b1', depth: 1 });
  });

  it('normalizes nodes, edges and notices; tolerates serialized JSON data', () => {
    const hood = normalizeNeighborhood(model, {
      nodes: [
        { entityId: 'b1', entityType: 'Book', data: { title: 'T' } },
        { entityId: 'a1', entityType: 'Author', data: '{"name":"A"}' },
        { entityType: 'Author', data: {} },
      ],
      edges: [{ source: 'b1', target: 'a1', type: 'author' }, { source: 'b1' }],
      notices: ['node budget reached'],
    });
    expect(hood).toEqual({
      nodes: [
        { id: 'b1', type: 'Book', data: { title: 'T' } },
        { id: 'a1', type: 'Author', data: { name: 'A' } },
      ],
      edges: [{ source: 'b1', target: 'a1', type: 'author' }],
      notices: ['node budget reached'],
    });
  });
});
