import { describe, expect, it } from 'vitest';
import { demoIntrospection } from '../data/testing/fixtures';
import { deriveCollections } from '../data/schemaModel';
import { decodeColumns, encodeColumns, seedFromProposal, validateColumnsShape, wireColumns } from './columnView';

const collections = deriveCollections(demoIntrospection);
const of = (id: string) => collections.find((c) => c.id === id)!;

describe('cols URL parameter (aperture#73)', () => {
  it('leaves the URL clean in the default state', () => {
    expect(encodeColumns([], new Set())).toBeNull();
  });

  it('round-trips a to-many traversal with its grain', () => {
    const workflows = of('workflows');
    const { pathColumns } = decodeColumns(
      { paths: [{ path: ['inputSamples', 'accession'], mode: 'explode' }] },
      workflows,
      collections,
    );
    expect(pathColumns).toHaveLength(1);
    // Grain is query semantics: a link that lost it would hand the recipient
    // different rows than the sender saw.
    expect(pathColumns[0]!.many?.mode).toBe('explode');
    expect(encodeColumns(pathColumns, new Set())).toEqual({
      paths: [{ path: ['inputSamples', 'accession'], mode: 'explode' }],
    });
  });

  it('round-trips a to-one traversal without inventing a grain', () => {
    const { pathColumns } = decodeColumns({ paths: [{ path: ['donor', 'cohort'] }] }, of('samples'), collections);
    expect(pathColumns[0]!.many).toBeUndefined();
    expect(encodeColumns(pathColumns, new Set())).toEqual({ paths: [{ path: ['donor', 'cohort'] }] });
  });

  it('carries hidden anchor fields, dropping ones the anchor lacks', () => {
    const samples = of('samples');
    const real = samples.columns[0]!.field;
    const { hiddenFields } = decodeColumns({ hidden: [real, 'noSuchField'] }, samples, collections);
    expect([...hiddenFields]).toEqual([real]);
  });

  it('drops unresolvable paths instead of failing the link', () => {
    const { pathColumns } = decodeColumns(
      { paths: [{ path: ['gone', 'x'] }, { path: ['donor', 'nope'] }, { path: ['donor'] }] },
      of('samples'),
      collections,
    );
    expect(pathColumns).toEqual([]);
  });

  it('explodes every column through the exploded link together', () => {
    // "One row each" belongs to the LINK. Two columns through inputSamples are
    // one row per input sample, not a cross product -- the old per-column cap
    // demoted one of them, so the two columns described different samples.
    const { pathColumns } = decodeColumns(
      {
        paths: [
          { path: ['inputSamples', 'accession'], mode: 'explode' },
          { path: ['inputSamples', 'id'], mode: 'count' },
        ],
      },
      of('workflows'),
      collections,
    );
    expect(pathColumns.map((c) => c.many?.mode)).toEqual(['explode', 'explode']);
  });

  it('restores a two-hop column through a list, with its depth and export name', () => {
    const { pathColumns } = decodeColumns(
      { paths: [{ path: ['inputSamples', 'donor', 'cohort'], mode: 'explode' }] },
      of('workflows'),
      collections,
    );
    expect(pathColumns).toHaveLength(1);
    const [col] = pathColumns;
    expect(col!.many).toMatchObject({ mode: 'explode', depth: 1 });
    expect(col!.label).toBe('Sample → Donor → Cohort');
    expect(col!.exportName).toBe('Sample.Donor.cohort');
  });

  it('drops paths it cannot resolve rather than guessing', () => {
    const { pathColumns } = decodeColumns(
      {
        paths: [
          { path: ['inputSamples', 'donor', 'cohort', 'extra'] }, // three hops: over the cap
          { path: ['inputSamples', 'noSuchField'] },
          { path: ['nope', 'cohort'] },
        ],
      },
      of('workflows'),
      collections,
    );
    expect(pathColumns).toEqual([]);
  });

  it('rejects malformed shapes', () => {
    expect(() => validateColumnsShape('x')).toThrow();
    expect(() => validateColumnsShape({ paths: [{ path: [] }] })).toThrow();
    expect(() => validateColumnsShape({ paths: [{ path: ['a', 'b'], mode: 'bogus' }] })).toThrow();
    expect(() => validateColumnsShape({ hidden: [1] })).toThrow();
    expect(validateColumnsShape({})).toEqual({});
  });
});


describe('seedFromProposal (aperture#89)', () => {
  const workflows = of('workflows');
  const samples = of('samples');

  it('turns slot-spelled traversals into path columns with their grain', () => {
    const { pathColumns, dropped } = seedFromProposal(
      [
        { path: ['input_samples', 'accession'], mode: 'explode' },
        { path: ['input_samples', 'donor', 'cohort'], mode: 'explode' },
      ],
      workflows,
      collections,
    );
    expect(dropped).toEqual([]);
    expect(pathColumns.map((c) => [c.path.join('.'), c.many?.mode])).toEqual([
      ['inputSamples.accession', 'explode'],
      ['inputSamples.donor.cohort', 'explode'],
    ]);
  });

  it('defaults a to-many path with no mode to count, never explode', () => {
    const { pathColumns } = seedFromProposal([{ path: ['input_samples', 'accession'] }], workflows, collections);
    expect(pathColumns[0]!.many?.mode).toBe('count');
  });

  it('gives a to-one path no grain', () => {
    const { pathColumns } = seedFromProposal([{ path: ['donor', 'age_at_death'] }], samples, collections);
    expect(pathColumns[0]!.path).toEqual(['donor', 'ageAtDeath']);
    expect(pathColumns[0]!.many).toBeUndefined();
  });

  it('returns anchor slots as fields to show, not as path columns', () => {
    const field = samples.columns.find((c) => c.field !== 'id')!.field;
    const slot = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const { pathColumns, showFields } = seedFromProposal([{ path: [slot] }], samples, collections);
    expect(pathColumns).toEqual([]);
    expect(showFields).toEqual([field]);
  });

  it('drops an unresolvable path with its reason and keeps the rest', () => {
    const { pathColumns, dropped } = seedFromProposal(
      [{ path: ['publisher', 'name'] }, { path: ['donor', 'cohort'] }],
      samples,
      collections,
    );
    expect(pathColumns.map((c) => c.path.join('.'))).toEqual(['donor.cohort']);
    expect(dropped).toEqual([{ path: ['publisher', 'name'], reason: expect.stringMatching(/no field “publisher”/) }]);
  });
});

describe('wireColumns (aperture#89 round trip)', () => {
  it('spells the table back in slot names, with a mode only on to-many paths', () => {
    const workflows = of('workflows');
    const { pathColumns } = decodeColumns(
      { paths: [{ path: ['inputSamples', 'accession'], mode: 'explode' }, { path: ['inputSamples', 'donor', 'cohort'] }] },
      workflows,
      collections,
    );
    expect(wireColumns(['workflowType'], pathColumns, workflows, collections)).toEqual([
      { path: ['workflow_type'] },
      { path: ['input_samples', 'accession'], mode: 'explode' },
      { path: ['input_samples', 'donor', 'cohort'], mode: 'explode' },
    ]);
  });
});
