import { deriveCollections } from '../data/schemaModel';
import { demoIntrospection } from '../data/testing/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { NO_CAPABILITIES } from '../data/capabilities';
import type { EntityPage, MosaicSource, ListOptions } from '../data/mosaicSource';
import type { CollectionModel } from '../data/schemaModel';
import { runQuerySpec, SEMIJOIN_CAP } from './planner';

const donors: CollectionModel = {
  id: 'donors',
  label: 'Donors',
  typeName: 'Donor',
  columns: [
    { field: 'id', label: 'Id', kind: 'id' },
    { field: 'ageAtDeath', label: 'Age At Death', kind: 'number' },
  ],
  detailColumns: [
    { field: 'id', label: 'Id', kind: 'id' },
    { field: 'ageAtDeath', label: 'Age At Death', kind: 'number' },
  ],
  idColumn: 'id',
  pageShape: 'envelope',
  filterShape: 'filterList',
  filterModeArg: { name: 'filterMode', type: 'FilterMode' },
  args: { limit: 'limit', offset: 'offset', filter: 'filters' },
  argTypes: {},
  facets: [],
  filterFields: ['id', 'age_at_death'],
  write: {},
  lifecycle: {},
};

const samples: CollectionModel = {
  ...donors,
  id: 'samples',
  label: 'Samples',
  typeName: 'Sample',
  columns: [
    { field: 'id', label: 'Id', kind: 'id' },
    { field: 'tissue', label: 'Tissue', kind: 'enum', enumValues: ['brain'] },
    { field: 'donor', label: 'Donor', kind: 'ref', targetType: 'Donor', targetIdField: 'id' },
  ],
  detailColumns: [
    { field: 'id', label: 'Id', kind: 'id' },
    { field: 'tissue', label: 'Tissue', kind: 'enum', enumValues: ['brain'] },
    { field: 'donor', label: 'Donor', kind: 'ref', targetType: 'Donor', targetIdField: 'id' },
  ],
  filterFields: ['id', 'tissue', 'donor'],
};

const collections = [donors, samples];

function sourceWith(
  pages: Record<string, (options: ListOptions) => EntityPage>,
): MosaicSource & { calls: { id: string; options: ListOptions }[] } {
  const calls: { id: string; options: ListOptions }[] = [];
  return {
    calls,
    capabilities: { ...NO_CAPABILITIES, filterOps: ['EQ', 'IN', 'GT'] },
    collections,
    listEntities: vi.fn(async (id: string, options: ListOptions) => {
      calls.push({ id, options });
      return pages[id]!(options);
    }),
    getEntity: vi.fn(),
    getHistory: vi.fn(),
    createEntity: vi.fn(),
    updateEntity: vi.fn(),
    setAvailability: vi.fn(),
    supersede: vi.fn(),
    runBatch: vi.fn(),
  } as unknown as MosaicSource & { calls: { id: string; options: ListOptions }[] };
}

describe('runQuerySpec', () => {
  it('compiles field conditions to typed flat filters (eq without op)', async () => {
    const source = sourceWith({
      donors: () => ({ rows: [{ id: 'd1' }], total: 1, mayHaveMore: false }),
    });
    const run = await runQuerySpec(
      source,
      collections,
      source.capabilities,
      {
        v: 1,
        anchor: 'Donor',
        mode: 'AND',
        criteria: [
          { kind: 'field', slot: 'age_at_death', op: 'gt', value: 60 },
          { kind: 'field', slot: 'id', op: 'eq', value: 'd1' },
        ],
      },
      1,
      25,
    );
    expect(run.rows).toHaveLength(1);
    expect(run.relationshipTier).toBeNull();
    expect(source.calls[0]!.options.conditions).toEqual([
      { field: 'age_at_death', value: 60, op: 'GT' },
      { field: 'id', value: 'd1', op: undefined },
    ]);
    expect(source.calls[0]!.options.filterMode).toBe('AND');
  });

  it('runs a reverse-edge RelatedCondition as a semijoin into id IN', async () => {
    const source = sourceWith({
      samples: () => ({
        rows: [
          { id: 's1', donor: { id: 'd1' } },
          { id: 's2', donor: { id: 'd2' } },
          { id: 's3', donor: null },
        ],
        mayHaveMore: false,
      }),
      donors: () => ({ rows: [{ id: 'd1' }, { id: 'd2' }], total: 2, mayHaveMore: false }),
    });
    const run = await runQuerySpec(
      source,
      collections,
      source.capabilities,
      {
        v: 1,
        anchor: 'Donor',
        mode: 'AND',
        criteria: [
          {
            kind: 'related',
            edge: 'rev:samples.donor',
            quantifier: 'some',
            criteria: [{ kind: 'field', slot: 'tissue', op: 'eq', value: 'brain' }],
          },
        ],
      },
      1,
      25,
    );
    expect(run.relationshipTier).toBe('compensated');
    // Sub-query hit samples with the sub-criteria…
    expect(source.calls[0]).toMatchObject({
      id: 'samples',
      options: { conditions: [{ field: 'tissue', value: 'brain', op: undefined }] },
    });
    expect(source.calls[0]!.options.pageSize).toBe(SEMIJOIN_CAP);
    // …and the anchor got one IN over the linked donor ids.
    expect(source.calls[1]!.options.conditions).toEqual([
      { field: 'id', value: ['d1', 'd2'], op: 'IN' },
    ]);
  });

  it('runs a forward-edge RelatedCondition against the reference slot', async () => {
    const source = sourceWith({
      donors: () => ({ rows: [{ id: 'd9' }], mayHaveMore: false }),
      samples: () => ({ rows: [{ id: 's1' }], total: 1, mayHaveMore: false }),
    });
    await runQuerySpec(
      source,
      collections,
      source.capabilities,
      {
        v: 1,
        anchor: 'Sample',
        mode: 'AND',
        criteria: [
          {
            kind: 'related',
            edge: 'donor',
            quantifier: 'some',
            criteria: [{ kind: 'field', slot: 'age_at_death', op: 'gt', value: 60 }],
          },
        ],
      },
      1,
      25,
    );
    expect(source.calls[1]!.options.conditions).toEqual([
      { field: 'donor', value: ['d9'], op: 'IN' },
    ]);
  });

  it('surfaces the semijoin cap honestly', async () => {
    const source = sourceWith({
      samples: () => ({
        rows: Array.from({ length: SEMIJOIN_CAP }, (_, i) => ({
          id: `s${i}`,
          donor: { id: `d${i}` },
        })),
        mayHaveMore: true,
      }),
      donors: () => ({ rows: [], total: 0, mayHaveMore: false }),
    });
    const run = await runQuerySpec(
      source,
      collections,
      source.capabilities,
      {
        v: 1,
        anchor: 'Donor',
        mode: 'AND',
        criteria: [
          { kind: 'related', edge: 'rev:samples.donor', quantifier: 'some', criteria: [] },
        ],
      },
      1,
      25,
    );
    expect(run.notes.some((n) => n.includes('may be incomplete'))).toBe(true);
  });

  it('an empty semijoin matches nothing, with a note', async () => {
    const source = sourceWith({
      samples: () => ({ rows: [], mayHaveMore: false }),
      donors: (options) => {
        // The anchor must receive an empty IN (matches nothing server-side).
        expect(options.conditions).toEqual([{ field: 'id', value: [], op: 'IN' }]);
        return { rows: [], total: 0, mayHaveMore: false };
      },
    });
    const run = await runQuerySpec(
      source,
      collections,
      source.capabilities,
      {
        v: 1,
        anchor: 'Donor',
        mode: 'AND',
        criteria: [
          { kind: 'related', edge: 'rev:samples.donor', quantifier: 'some', criteria: [] },
        ],
      },
      1,
      25,
    );
    expect(run.rows).toEqual([]);
    expect(run.notes.some((n) => n.includes('matched no related records'))).toBe(true);
  });
});

describe('runQuerySpec — server-first execution (ADR-0035/0041)', () => {
  const demo = deriveCollections(demoIntrospection);

  function recordingSource(): { source: MosaicSource; calls: ListOptions[] } {
    const calls: ListOptions[] = [];
    const source = {
      capabilities: NO_CAPABILITIES,
      collections: demo,
      listEntities: async (_id: string, options: ListOptions) => {
        calls.push(options);
        return { rows: [], mayHaveMore: false, total: 0 };
      },
    } as unknown as MosaicSource;
    return { source, calls };
  }

  it('pushes a fully-compilable spec down and issues one query', async () => {
    const { source, calls } = recordingSource();
    const result = await runQuerySpec(
      source,
      demo,
      NO_CAPABILITIES,
      { v: 1, anchor: 'Workflow', mode: 'AND', criteria: [
        { kind: 'related', edge: 'input_samples', quantifier: 'some', criteria: [
          { kind: 'field', slot: 'sample_type', op: 'eq', value: 'tissue' },
        ] },
      ] },
      1,
      25,
    );
    // One round trip, no semijoin pre-query, and the tier says so.
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ inputSamples: { some: { sampleType: { eq: 'tissue' } } } });
    expect(calls[0].conditions).toEqual([]);
    expect(result.relationshipTier).toBe('server');
  });

  it('compensates only the criterion the endpoint cannot express', async () => {
    const { source, calls } = recordingSource();
    const result = await runQuerySpec(
      source,
      demo,
      NO_CAPABILITIES,
      { v: 1, anchor: 'Donor', mode: 'AND', criteria: [
        { kind: 'field', slot: 'age_at_death', op: 'gte', value: 60 },
        // The demo schema declares no inverse slot, so this edge has no
        // server-side predicate and must still compensate.
        { kind: 'related', edge: 'rev:samples.donor', quantifier: 'some', criteria: [] },
      ] },
      1,
      25,
    );
    const main = calls[calls.length - 1];
    expect(main.where).toEqual({ ageAtDeath: { gte: 60 } });
    expect(main.conditions?.some((c) => c.op === 'IN')).toBe(true);
    expect(result.relationshipTier).toBe('compensated');
  });

  it('refuses to mix a typed filter with a compensation under OR', async () => {
    const { source, calls } = recordingSource();
    const result = await runQuerySpec(
      source,
      demo,
      NO_CAPABILITIES,
      { v: 1, anchor: 'Donor', mode: 'OR', criteria: [
        { kind: 'field', slot: 'age_at_death', op: 'gte', value: 60 },
        { kind: 'related', edge: 'rev:samples.donor', quantifier: 'some', criteria: [] },
      ] },
      1,
      25,
    );
    const main = calls[calls.length - 1];
    // The server ANDs `filters` onto `where`, so mixing under OR would run a
    // query that is not the one the spec describes. All of it falls back.
    expect(main.where).toBeUndefined();
    expect(main.filterMode).toBe('OR');
    expect(result.notes.some((n) => n.includes('cannot be'))).toBe(true);
  });
});
