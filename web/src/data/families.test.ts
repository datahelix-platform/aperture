import { describe, expect, it } from 'vitest';
import { deriveCapabilities, deriveCollections, KIND_COLUMN, recordCollection, referenceTarget } from './schemaModel';
import type { IntrospectionSchema } from './introspection';
import { filterSlots, validateQuerySpec } from '../query/querySpec';
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

describe('a family has no lifecycle actions, and types never borrow mutations (review B1)', () => {
  // The Mutation type with one more mutation that names the family.
  const withFamilyMutations: IntrospectionSchema = {
    ...familyIntrospection,
    types: familyIntrospection.types.map((t) =>
      t.name !== familyIntrospection.mutationType?.name
        ? t
        : {
            ...t,
            fields: [
              ...(t.fields ?? []).filter((f) => f.name === 'setBrainAvailability' || f.name === 'supersedeBrain').map((f) => ({
                ...f,
                name: f.name.replace('Brain', 'Sample'),
              })),
              ...(t.fields ?? []),
            ],
          },
    ),
  };

  it('derives no lifecycle actions for a family, even when the Mutation type names it', () => {
    const samples = deriveCollections(withFamilyMutations).find((c) => c.id === 'samples')!;
    expect(samples.lifecycle).toEqual({});
  });

  it('matches the whole mutation name, so Brain does not pick up BankBrain\'s', () => {
    // `setBankBrainAvailability` sorts before `setBrainAvailability` and
    // contains "brain": the substring match handed it to Brain.
    expect(of('brains').lifecycle.setAvailability?.field).toBe('setBrainAvailability');
    expect(of('brains').lifecycle.supersede?.field).toBe('supersedeBrain');
    expect(of('bankBrains').lifecycle.setAvailability?.field).toBe('setBankBrainAvailability');
  });
});

describe('kind-only fields filter on the family (review B2, Mosaic #278)', () => {
  it('lists them as filter fields, with kinds from their ops type', () => {
    const samples = of('samples');
    expect(samples.filterFields).toEqual(expect.arrayContaining(['label', 'hemisphere', 'volume_ml', 'drawn_from']));
    const kinds = Object.fromEntries(filterSlots(samples).map((s) => [s.slot, s.kind]));
    expect(kinds).toMatchObject({ hemisphere: 'text', volume_ml: 'number', drawn_from: 'ref' });
    // A concrete collection keeps its column-derived filter fields only.
    expect(of('brains').filterKinds).toBeUndefined();
  });

  it('accepts a family QuerySpec filtering on a kind-only field', () => {
    const spec = {
      v: 1 as const,
      anchor: 'Sample',
      mode: 'AND' as const,
      criteria: [
        { kind: 'field' as const, slot: 'hemisphere', op: 'eq' as const, value: 'L' },
        { kind: 'field' as const, slot: 'volume_ml', op: 'gt' as const, value: 1 },
      ],
    };
    expect(validateQuerySpec(spec, collections, deriveCapabilities(familyIntrospection, collections)).errors).toEqual([]);
  });
});

describe('a family without a collection (mosaic_anchor: false, review item 1)', () => {
  // Drop the family's own roots, as Mosaic does for `mosaic_anchor: false`;
  // references into it still resolve to the interface.
  const queryName = familyIntrospection.queryType.name;
  const noAnchor: IntrospectionSchema = {
    ...familyIntrospection,
    types: familyIntrospection.types.map((t) =>
      t.name !== queryName ? t : { ...t, fields: (t.fields ?? []).filter((f) => !/^(sample|samples|searchSamples|samples\w+)$/.test(f.name)) },
    ),
  };
  const cols = deriveCollections(noAnchor);
  const sampleRef = cols.find((c) => c.id === 'measurements')!.detailColumns.find((c) => c.field === 'sample')!;

  it('derives no family collection, but keeps the reference', () => {
    expect(cols.find((c) => c.typeName === 'Sample')).toBeUndefined();
    expect(sampleRef).toMatchObject({ kind: 'ref', targetIsFamily: true });
  });

  it('drops a proposal path through it with an accurate reason', () => {
    const measurements = cols.find((c) => c.id === 'measurements')!;
    const { dropped } = translateColumns([{ path: ['sample', 'label'] }], 'field', measurements, cols);
    expect(dropped).toEqual([
      { path: ['sample', 'label'], reason: expect.stringMatching(/Sample, a family with no collection of its own/) },
    ]);
    expect(dropped[0]!.reason).not.toMatch(/does not expose/);
  });

  it('still opens a value on its kind\'s page', () => {
    expect(referenceTarget(sampleRef, { id: 'br1', __typename: 'Brain' }, cols)?.id).toBe('brains');
    expect(referenceTarget(sampleRef, { id: 'x' }, cols)).toBeUndefined();
  });
});
