import { describe, expect, it } from 'vitest';
import { deriveCollections, KIND_COLUMN, recordCollection } from './schemaModel';
import { familyIntrospection } from './testing/fixtures';
import { selectionForPaths } from './selection';
import type { PathColumn } from './selection';
import { translateColumns } from '../query/querySpec';
import { resolvePath, seedFromProposal, toPathColumn, wireColumns } from '../query/columnView';

// Families (Mosaic ADR-0014, Aperture ADR-0042), against a live mosaic v0.16.0 capture.
const collections = deriveCollections(familyIntrospection);
const of = (id: string) => collections.find((c) => c.id === id)!;

describe('a family is a read-only collection (ADR-0042)', () => {
  it('derives the family page as a collection, with its kinds', () => {
    const samples = of('samples');
    expect(samples).toBeDefined();
    expect(samples.typeName).toBe('Sample');
    expect(samples.family).toEqual({ kinds: ['Blood', 'Brain'] });
    // Ordinary collections are not families, a concrete parent included.
    expect(of('processes').family).toBeUndefined();
    expect(of('brains').family).toBeUndefined();
  });

  it('carries only the fields every kind stores alike, after a Kind column', () => {
    const fields = of('samples').detailColumns.map((c) => c.field);
    expect(fields[0]).toBe('__typename');
    expect(fields).toEqual(expect.arrayContaining(['id', 'label', 'producedBy']));
    // Kind-only fields are not selectable on the interface.
    expect(fields).not.toContain('hemisphere');
    expect(fields).not.toContain('volumeMl');
    expect(of('samples').columns[0]).toEqual(KIND_COLUMN);
  });

  it('never offers the Kind column as a filter, facet or sort key', () => {
    const samples = of('samples');
    expect(samples.filterFields).not.toContain('__typename');
    expect(samples.facets.map((f) => f.field)).not.toContain('__typename');
    expect(samples.detailColumns[0]!.orderField).toBeUndefined();
  });

  it('filters on kind-only fields, which Mosaic reads as NULL for other kinds', () => {
    expect(Object.keys(of('samples').whereFields ?? {})).toEqual(
      expect.arrayContaining(['label', 'hemisphere', 'volumeMl']),
    );
  });

  it('has a record lookup through sample(id:) and no write surface', () => {
    const samples = of('samples');
    expect(samples.detail).toMatchObject({ kind: 'field', field: 'sample' });
    expect(samples.write.create).toBeUndefined();
    expect(samples.write.update).toBeUndefined();
  });

  it('turns a reference ranged on a family into a reference column', () => {
    const sample = of('measurements').detailColumns.find((c) => c.field === 'sample');
    expect(sample).toMatchObject({ kind: 'ref', targetType: 'Sample', targetIsFamily: true });
    const inputs = of('assays').detailColumns.find((c) => c.field === 'inputs');
    expect(inputs).toMatchObject({ kind: 'refList', targetType: 'Sample', targetIsFamily: true });
  });
});

describe('recordCollection: where a row links (ADR-0042)', () => {
  it('opens a family row on its concrete kind\'s page', () => {
    expect(recordCollection(of('samples'), { id: 'br1', __typename: 'Brain' }, collections)?.id).toBe('brains');
  });

  it('falls back to the family page when the kind is unknown or unnamed', () => {
    expect(recordCollection(of('samples'), { id: 'x', __typename: 'Mystery' }, collections)?.id).toBe('samples');
    expect(recordCollection(of('samples'), { id: 'x' }, collections)?.id).toBe('samples');
  });

  it('leaves any other collection alone', () => {
    expect(recordCollection(of('brains'), { id: 'br1', __typename: 'Brain' }, collections)?.id).toBe('brains');
    expect(recordCollection(undefined, {}, collections)).toBeUndefined();
  });
});

describe('selections through a family carry __typename', () => {
  it('asks a family member for its kind, so its link can open the kind\'s page', () => {
    const label = of('samples').detailColumns.find((c) => c.field === 'label')!;
    const path: PathColumn = { path: ['sample', 'label'], column: label, label: 'Sample → Label' };
    expect(selectionForPaths([path], of('measurements'), collections)).toMatch(/sample \{[^}]*__typename/);
  });
});

describe('proposal columns through a family (aperture#89 review, ADR-0042)', () => {
  it('translates, seeds and round-trips a path through a family range', () => {
    const measurements = of('measurements');
    // Before ADR-0042 this was dropped as "Measurement has no field “sample”".
    expect(translateColumns([{ path: ['sample', 'label'] }], 'field', measurements, collections)).toEqual({
      columns: [{ path: ['sample', 'label'] }],
      dropped: [],
    });
    const seeded = seedFromProposal([{ path: ['sample', 'label'] }], measurements, collections);
    expect(seeded.dropped).toEqual([]);
    expect(seeded.pathColumns.map((c) => c.label)).toEqual(['Sample → Label']);
    expect(wireColumns([], seeded.pathColumns, measurements, collections)).toEqual([{ path: ['sample', 'label'] }]);

    // A to-many hop into a family, exploded.
    const assays = of('assays');
    const inputs = seedFromProposal([{ path: ['inputs', 'label'], mode: 'explode' }], assays, collections);
    expect(inputs.pathColumns.map((c) => [c.path.join('.'), c.many?.mode])).toEqual([['inputs.label', 'explode']]);
  });

  it('keeps the family Kind column off the wire', () => {
    const measurements = of('measurements');
    const kind = toPathColumn(resolvePath(['sample', '__typename'], measurements, collections)!);
    expect(wireColumns([], [kind], measurements, collections)).toEqual([]);
    expect(translateColumns([{ path: ['sample', '__typename'] }], 'field', measurements, collections).dropped).toHaveLength(1);
  });
});
