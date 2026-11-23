import { describe, expect, it } from 'vitest';
import { deriveCollections } from './schemaModel';
import { demoIntrospection } from './testing/fixtures';
import { capExplode, explodeKey, flattenRows, normalizeExplode, pathLabel, selectionForPaths, valueAtPath } from './selection';
import type { ManyMode, PathColumn } from './selection';

const demo = deriveCollections(demoIntrospection);
const find = (id: string) => demo.find((c) => c.id === id)!;
const col = (collectionId: string, field: string) =>
  find(collectionId).detailColumns.find((c) => c.field === field)!;

const at = (path: string[], collectionId: string, field: string): PathColumn => ({
  path,
  column: col(collectionId, field),
  label: field,
});

describe('selectionForPaths', () => {
  it('merges sibling fields into one nested selection', () => {
    const sel = selectionForPaths(
      [at(['donor', 'cohort'], 'donors', 'cohort'), at(['donor', 'ageAtDeath'], 'donors', 'ageAtDeath')],
      find('samples'),
      demo,
    );
    // Two `donor` selections would be legal GraphQL and answered twice. The
    // merge is the reason this is a tree rather than a string join.
    expect(sel.match(/donor \{/g)).toHaveLength(1);
    expect(sel).toContain('cohort');
    expect(sel).toContain('ageAtDeath');
  });

  it('carries the target id into every nested selection', () => {
    const sel = selectionForPaths([at(['donor', 'cohort'], 'donors', 'cohort')], find('samples'), demo);
    // Row-click navigation and stable row keys read it, and under edge-only
    // emission (Mosaic ADR-0005) there is no `donorId` scalar to fall back to.
    expect(sel).toMatch(/donor \{[^}]*\bid\b/);
  });

  it('selects an object for a reference chosen as a leaf', () => {
    const sel = selectionForPaths([at(['donor'], 'samples', 'donor')], find('samples'), demo);
    // There is no scalar to ask for: a bare `donor` is not a valid selection.
    expect(sel).toMatch(/^donor \{ .*id.* \}$/);
  });

  it('traverses a to-many reference', () => {
    const sel = selectionForPaths(
      [at(['inputSamples', 'accession'], 'samples', 'accession')],
      find('workflows'),
      demo,
    );
    expect(sel).toMatch(/inputSamples \{[^}]*accession/);
  });

  it('drops a hop it cannot resolve instead of guessing', () => {
    const sel = selectionForPaths(
      [{ path: ['notAnEdge', 'cohort'], column: col('donors', 'cohort'), label: 'x' }],
      find('samples'),
      demo,
    );
    // Emitting an untypable nested selection would fail server-side with a
    // worse error than simply not offering the column.
    expect(sel).toBe('');
  });

  it('refuses a path deeper than the hop cap', () => {
    const deep = { path: ['a', 'b', 'c', 'd'], column: col('donors', 'cohort'), label: 'x' };
    expect(selectionForPaths([deep], find('samples'), demo)).toBe('');
  });
});

describe('valueAtPath', () => {
  it('reads through nested objects and tolerates an absent hop', () => {
    const row = { donor: { cohort: 'CTE' } };
    expect(valueAtPath(row, ['donor', 'cohort'])).toBe('CTE');
    // An unset reference and a masked field look the same here, and both render
    // as "—" rather than throwing (ADR-0029).
    expect(valueAtPath({ donor: null }, ['donor', 'cohort'])).toBeUndefined();
    expect(valueAtPath({}, ['donor', 'cohort'])).toBeUndefined();
  });
});

describe('pathLabel', () => {
  it('labels a traversal by its path', () => {
    expect(pathLabel(['donor', 'cohort'], find('samples'), demo)).toBe('Donor → Cohort');
    expect(pathLabel(['accession'], find('samples'), demo)).toBe('Accession');
  });
});

describe('flattenRows', () => {
  const cohort = (mode?: ManyMode): PathColumn => ({
    path: ['inputSamples', 'accession'],
    column: col('samples', 'accession'),
    label: 'Sample → Accession',
    many: mode ? { mode } : undefined,
  });
  const status: PathColumn = { path: ['status'], column: col('workflows', 'status'), label: 'Status' };

  const rows = [
    { id: 'w1', status: 'done', inputSamples: [{ id: 's1', accession: 'A1' }, { id: 's2', accession: 'A2' }] },
    { id: 'w2', status: 'failed', inputSamples: [] },
  ];

  it('keeps anchor grain for count, and reports no grain change', () => {
    const out = flattenRows(rows, [status, cohort('count')], 'id');
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].values['inputSamples.accession']).toBe(2);
    expect(out.rows[1].values['inputSamples.accession']).toBe(0);
    expect(out.grain).toBeUndefined();
  });

  it('joins member values without changing the row count', () => {
    const out = flattenRows(rows, [status, cohort('joinIds')], 'id');
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].values['inputSamples.accession']).toBe('A1; A2');
  });

  it('explodes to one row per member and repeats the anchor values', () => {
    const out = flattenRows(rows, [status, cohort('explode')], 'id');
    // The repetition is the feature: w1 appears twice, once per sample.
    expect(out.rows.map((r) => r.values['status'])).toEqual(['done', 'done', 'failed']);
    expect(out.rows.map((r) => r.values['inputSamples.accession'])).toEqual(['A1', 'A2', undefined]);
  });

  it('keeps an anchor with no members when exploding', () => {
    const out = flattenRows(rows, [status, cohort('explode')], 'id');
    // Dropping w2 would turn an explode into a filter — the table would stop
    // agreeing with the result total for a reason nothing on screen explains.
    expect(out.rows.filter((r) => r.anchorId === 'w2')).toHaveLength(1);
  });

  it('states the grain change with both counts', () => {
    const out = flattenRows(rows, [status, cohort('explode')], 'id');
    // "3 rows from 2 workflows" — ADR-0041 requires this wherever the rows are.
    expect(out.grain).toMatchObject({ anchorCount: 2, rowCount: 3 });
  });

  it('gives exploded siblings distinct keys', () => {
    const out = flattenRows(rows, [status, cohort('explode')], 'id');
    // The anchor id alone collides, and React would reuse a row across members.
    expect(new Set(out.rows.map((r) => r.key)).size).toBe(out.rows.length);
    expect(out.rows.every((r) => r.anchorId === 'w1' || r.anchorId === 'w2')).toBe(true);
  });

  it('ignores a second explode rather than multiplying rows', () => {
    const second: PathColumn = {
      path: ['runConfigurations', 'name'],
      column: col('workflows', 'name'),
      label: 'x',
      many: { mode: 'explode' },
    };
    const out = flattenRows(rows, [status, cohort('explode'), second], 'id');
    // A cartesian product has no user model behind it (v1 cap, ADR-0041).
    expect(out.rows).toHaveLength(3);
  });
});

describe('mixed modes on one link (aperture#89 review: Mosaic accepts them)', () => {
  const on = (field: string, mode: ManyMode): PathColumn => ({
    path: ['inputSamples', field],
    column: col('samples', field),
    label: field,
    many: { mode },
  });
  const rows = [{ id: 'w1', inputSamples: [{ id: 's1', accession: 'A1' }, { id: 's2', accession: 'A2' }] }];

  it('capExplode keeps a sibling\'s own mode on the exploded link', () => {
    const out = capExplode([on('accession', 'explode'), on('id', 'joinIds')]);
    expect(out.map((c) => c.many?.mode)).toEqual(['explode', 'joinIds']);
  });

  it('capExplode still demotes an explode through a second link', () => {
    const other: PathColumn = {
      path: ['outputSamples', 'accession'],
      column: col('samples', 'accession'),
      label: 'out',
      many: { mode: 'explode' },
    };
    expect(capExplode([on('accession', 'explode'), other]).map((c) => c.many?.mode)).toEqual(['explode', 'count']);
  });

  it('flattenRows reads an exploded column per member and a joinIds sibling as the anchor\'s list', () => {
    const out = flattenRows(rows, [on('accession', 'explode'), on('id', 'joinIds')], 'id');
    expect(out.rows.map((r) => r.values['inputSamples.accession'])).toEqual(['A1', 'A2']);
    expect(out.rows.map((r) => r.values['inputSamples.id'])).toEqual(['s1; s2', 's1; s2']);
  });
});

describe('flattenRows across two hops (one list on the path)', () => {
  // Workflow → inputSamples (list) → donor (one) → cohort: the RNA-seq + clinical shape.
  const donorCohort = (mode: ManyMode): PathColumn => ({
    path: ['inputSamples', 'donor', 'cohort'],
    column: col('donors', 'cohort'),
    label: 'Sample → Donor → Cohort',
    many: { mode, depth: 1 },
  });
  const accession = (mode: ManyMode): PathColumn => ({
    path: ['inputSamples', 'accession'],
    column: col('samples', 'accession'),
    label: 'Sample → Accession',
    many: { mode, depth: 1 },
  });
  const status: PathColumn = { path: ['status'], column: col('workflows', 'status'), label: 'Status' };
  const rows = [
    {
      id: 'w1',
      status: 'completed',
      inputSamples: [
        { id: 's1', accession: 'A1', donor: { id: 'd1', cohort: 'case' } },
        { id: 's2', accession: 'A2', donor: null },
      ],
    },
    { id: 'w2', status: 'failed', inputSamples: [] },
  ];

  it('explodes at the list and reads the rest of the path from each member', () => {
    const out = flattenRows(rows, [status, accession('explode'), donorCohort('explode')], 'id');
    expect(out.rows.map((r) => [r.values['status'], r.values['inputSamples.accession'], r.values['inputSamples.donor.cohort']])).toEqual([
      ['completed', 'A1', 'case'],
      ['completed', 'A2', undefined], // a sample with no donor: blank, not dropped
      ['failed', undefined, undefined], // outer join: an anchor with no members keeps one row
    ]);
    expect(out.grain).toMatchObject({ anchorCount: 2, rowCount: 3 });
  });

  it('summarises through the list without changing the grain', () => {
    expect(flattenRows(rows, [donorCohort('joinIds')], 'id').rows[0].values['inputSamples.donor.cohort']).toBe('case');
    expect(flattenRows(rows, [donorCohort('count')], 'id').rows[0].values['inputSamples.donor.cohort']).toBe(2);
  });

  it('reads a list at the second hop (Sample → donor → diagnoses)', () => {
    const dx: PathColumn = {
      path: ['donor', 'diagnoses', 'conditionName'],
      column: col('samples', 'name'),
      label: 'Donor → Diagnosis → Condition',
      many: { mode: 'joinIds', depth: 2 },
    };
    const sampleRows = [
      { id: 's1', donor: { id: 'd1', diagnoses: [{ id: 'x1', conditionName: 'CTE' }, { id: 'x2', conditionName: 'AD' }] } },
      { id: 's2', donor: null },
    ];
    const out = flattenRows(sampleRows, [dx], 'id');
    expect(out.rows.map((r) => r.values['donor.diagnoses.conditionName'])).toEqual(['CTE; AD', '']);
  });
});

describe('one exploded LINK, not one exploded column', () => {
  const through = (path: string[], mode: ManyMode, depth?: number): PathColumn => ({
    path,
    column: col('samples', 'accession'),
    label: path.join('.'),
    many: { mode, depth },
  });

  it('keys columns by the link they read through', () => {
    expect(explodeKey(through(['inputSamples', 'accession'], 'count'))).toBe('inputSamples');
    expect(explodeKey(through(['inputSamples', 'donor', 'cohort'], 'count', 1))).toBe('inputSamples');
    expect(explodeKey(through(['donor', 'diagnoses', 'conditionName'], 'count', 2))).toBe('donor.diagnoses');
  });

  it('explodes every column through the chosen link and demotes other links', () => {
    const out = normalizeExplode(
      [
        through(['inputSamples', 'accession'], 'count'),
        through(['inputSamples', 'donor', 'cohort'], 'count', 1),
        through(['datasets', 'name'], 'explode'),
      ],
      'inputSamples',
    );
    expect(out.map((c) => c.many?.mode)).toEqual(['explode', 'explode', 'count']);
  });

  it('keeps the first exploded link when none is preferred', () => {
    const out = normalizeExplode([
      through(['datasets', 'name'], 'explode'),
      through(['inputSamples', 'accession'], 'explode'),
      through(['datasets', 'id'], 'joinIds'),
    ]);
    expect(out.map((c) => c.many?.mode)).toEqual(['explode', 'count', 'explode']);
  });
});

