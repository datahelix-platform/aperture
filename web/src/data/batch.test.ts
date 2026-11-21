import { buildIngestBatch, deriveBatchModel, normalizeBatchResult } from './batch';
import { connectMosaicSource } from './mosaicSource';
import { bareSchema, capableSchema, fakeClient, realIntrospection } from './testing/fixtures';

const RESULT_SELECTION =
  'committed dryRun validation { passed results { entityId passed failures ' +
  '{ tier rule message field details } } } entities relationships';

const EXPECTED_MODEL = {
  field: 'ingestBatch',
  entitiesArgName: 'entities',
  entitiesArgType: '[BatchEntityInput!]!',
  relationshipsArgName: 'relationships',
  relationshipsArgType: '[BatchRelationshipInput!]',
  dryRunArgName: 'dryRun',
  dryRunArgType: 'Boolean!',
  validateField: 'validateBatch',
  entity: { entityType: 'entityType', data: 'data' },
  resultSelection: RESULT_SELECTION,
};

describe('deriveBatchModel (ADR-0028 / Hippo #84 — real ingestBatch shape, #15)', () => {
  it('derives the ingest surface when the shape is usable', () => {
    expect(deriveBatchModel(capableSchema())).toEqual(EXPECTED_MODEL);
  });

  it('gates ON against the live hippo 0.10.3 introspection capture', () => {
    expect(deriveBatchModel(realIntrospection)).toEqual(EXPECTED_MODEL);
  });

  it('is absent on a bare endpoint — capability off, never a name-match guess', () => {
    expect(deriveBatchModel(bareSchema())).toBeUndefined();
    // A /batch/i mutation without the {entityType, data} entity-list + dryRun
    // shape does not qualify.
    const bare = bareSchema();
    bare.mutationType = { name: 'Mutation' };
    bare.types.push({
      kind: 'OBJECT',
      name: 'Mutation',
      fields: [
        {
          name: 'ingestBatch',
          args: [{ name: 'payload', type: { kind: 'SCALAR', name: 'String', ofType: null } }],
          type: { kind: 'SCALAR', name: 'Boolean', ofType: null },
        },
      ],
    });
    expect(deriveBatchModel(bare)).toBeUndefined();
  });
});

describe('buildIngestBatch (client-id staging — no server-side ref tokens)', () => {
  const model = deriveBatchModel(capableSchema())!;

  it('pre-assigns client ids and rewrites intra-batch refs to them', () => {
    const { document, variables, clientIds } = buildIngestBatch(
      model,
      [
        { ref: 'author-step', type: 'Author', data: { name: 'A' } },
        { ref: 'book-step', type: 'Book', data: { title: 'T', author: 'author-step' } },
      ],
      true,
    );
    expect(document).toBe(
      'mutation ApertureBatch($entities: [BatchEntityInput!]!, $dryRun: Boolean!) ' +
        '{ ingestBatch(entities: $entities, dryRun: $dryRun) ' +
        `{ ${RESULT_SELECTION} } }`,
    );
    const authorId = clientIds['author-step'];
    const bookId = clientIds['book-step'];
    expect(authorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bookId).not.toBe(authorId);
    expect(variables).toEqual({
      entities: [
        { entityType: 'Author', data: { name: 'A', id: authorId } },
        // The binding's ref token resolved to the sibling's client id.
        { entityType: 'Book', data: { title: 'T', author: authorId, id: bookId } },
      ],
      dryRun: true,
    });
  });

  it('honors a pre-supplied data.id instead of generating one', () => {
    const { variables, clientIds } = buildIngestBatch(
      model,
      [{ ref: 'op-1', type: 'Author', data: { id: 'AU-fixed', name: 'A' } }],
      false,
    );
    expect(clientIds).toEqual({ 'op-1': 'AU-fixed' });
    expect(variables['dryRun']).toBe(false);
    expect(variables['entities']).toEqual([
      { entityType: 'Author', data: { id: 'AU-fixed', name: 'A' } },
    ]);
  });

  it('wires explicit relationships through the refs map', () => {
    const { document, variables, clientIds } = buildIngestBatch(
      model,
      [
        { ref: 'a', type: 'Author', data: { name: 'A' } },
        { ref: 'b', type: 'Book', data: { title: 'T' } },
      ],
      true,
      [{ sourceId: 'b', targetId: 'a', relationshipType: 'author', metadata: { k: 1 } }],
    );
    expect(document).toContain('$relationships: [BatchRelationshipInput!]');
    expect(document).toContain('relationships: $relationships');
    expect(variables['relationships']).toEqual([
      {
        sourceId: clientIds['b'],
        targetId: clientIds['a'],
        relationshipType: 'author',
        metadata: { k: 1 },
      },
    ]);
  });

  it('refuses relationships when the endpoint does not advertise the arg', () => {
    const noRels = { ...model, relationshipsArgName: undefined, relationshipsArgType: undefined };
    expect(() =>
      buildIngestBatch(noRels, [{ ref: 'a', type: 'Author', data: {} }], true, [
        { sourceId: 'a', targetId: 'a', relationshipType: 'self' },
      ]),
    ).toThrow(/does not accept batch relationships/);
  });
});

describe('normalizeBatchResult (BatchWriteGraphQLResult parsing)', () => {
  const clientIds = { 'author-step': 'uuid-a', 'book-step': 'uuid-b' };

  it('maps a committed run: ok + entity ids attributed back to op refs', () => {
    expect(
      normalizeBatchResult(
        {
          committed: true,
          dryRun: false,
          validation: {
            passed: true,
            results: [
              { entityId: 'uuid-a', passed: true, failures: [] },
              { entityId: 'uuid-b', passed: true, failures: [] },
            ],
          },
          entities: [
            { id: 'uuid-a', entity_type: 'Author', operation: 'insert' },
            { id: 'uuid-b', entity_type: 'Book', operation: 'insert' },
          ],
          relationships: [],
        },
        clientIds,
      ),
    ).toEqual({
      ok: true,
      ids: { 'author-step': 'uuid-a', 'book-step': 'uuid-b' },
      errors: [],
    });
  });

  it('maps a passing dry-run: ok, no ids (nothing committed)', () => {
    expect(
      normalizeBatchResult(
        {
          committed: false,
          dryRun: true,
          validation: { passed: true, results: [{ entityId: 'uuid-a', passed: true, failures: [] }] },
          entities: [{ id: 'uuid-a', entity_type: 'Author', operation: 'insert' }],
          relationships: [],
        },
        clientIds,
      ),
    ).toEqual({ ok: true, ids: {}, errors: [] });
  });

  it('maps validation failures to op refs and fields', () => {
    expect(
      normalizeBatchResult(
        {
          committed: false,
          dryRun: true,
          validation: {
            passed: false,
            results: [
              { entityId: 'uuid-a', passed: true, failures: [] },
              {
                entityId: 'uuid-b',
                passed: false,
                failures: [
                  { tier: 'schema', rule: 'required', message: 'title is required', field: 'title' },
                  { tier: 'schema', rule: 'range', message: 'out of range', field: null },
                ],
              },
            ],
          },
          entities: [],
          relationships: [],
        },
        clientIds,
      ),
    ).toEqual({
      ok: false,
      ids: {},
      errors: [
        { ref: 'book-step', field: 'title', message: 'title is required' },
        { ref: 'book-step', field: undefined, message: 'out of range' },
      ],
    });
  });

  it('tolerates a bare validation payload and garbage', () => {
    expect(normalizeBatchResult({ passed: true, results: [] }, {})).toEqual({
      ok: true,
      ids: {},
      errors: [],
    });
    expect(normalizeBatchResult(null, {})).toEqual({ ok: false, ids: {}, errors: [] });
    // A failed entity with no failure detail still yields an attributed error.
    expect(
      normalizeBatchResult(
        { passed: false, results: [{ entityId: 'uuid-a', passed: false, failures: [] }] },
        clientIds,
      ),
    ).toEqual({ ok: false, ids: {}, errors: [{ ref: 'author-step', message: 'validation failed' }] });
  });
});

describe('source.runBatch', () => {
  it('runs dry-run and commit through the derived surface', async () => {
    const client = fakeClient(capableSchema(), (query, variables) => {
      const dryRun = variables['dryRun'] === true;
      const entities = variables['entities'] as { entityType: string; data: { id: string } }[];
      void query;
      return {
        data: {
          ingestBatch: {
            committed: !dryRun,
            dryRun,
            validation: {
              passed: true,
              results: entities.map((e) => ({ entityId: e.data.id, passed: true, failures: [] })),
            },
            entities: entities.map((e) => ({
              id: e.data.id,
              entity_type: e.entityType,
              operation: 'insert',
            })),
            relationships: [],
          },
        },
        error: null,
      };
    });
    const source = await connectMosaicSource(client);
    expect(source.capabilities.batchWrite).toBe(true);

    const ops = [{ ref: 'op-1', type: 'Book', data: { title: 'T' } }];
    const dry = await source.runBatch(ops, true);
    expect(dry).toEqual({ ok: true, ids: {}, errors: [] });
    const commit = await source.runBatch(ops, false);
    expect(commit.ok).toBe(true);
    expect(commit.ids['op-1']).toMatch(/^[0-9a-f-]{36}$/); // the pre-assigned client id
  });

  it('refuses when the endpoint has no batch surface, and on an empty set', async () => {
    const bare = await connectMosaicSource(
      fakeClient(bareSchema(), () => ({ data: {}, error: null })),
    );
    expect(bare.capabilities.batchWrite).toBe(false);
    await expect(bare.runBatch([{ ref: 'x', type: 'T', data: {} }], true)).rejects.toThrow(
      /does not advertise a batch/,
    );
    const capable = await connectMosaicSource(fakeClient(capableSchema()));
    await expect(capable.runBatch([], true)).rejects.toThrow(/Nothing staged/);
  });

  it('surfaces a commit-time constraint rollback as a thrown transport error', async () => {
    const client = fakeClient(capableSchema(), () => ({
      data: null,
      error: new Error('FOREIGN KEY constraint failed'),
    }));
    const source = await connectMosaicSource(client);
    await expect(
      source.runBatch([{ ref: 'op-1', type: 'Book', data: { title: 'T' } }], false),
    ).rejects.toThrow(/Batch commit failed: FOREIGN KEY constraint failed/);
  });
});
