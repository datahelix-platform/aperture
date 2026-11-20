import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { App } from '../../App';
import { capableSchema, fakeClient, fieldRangeSchema } from '../../data/testing/fixtures';
import { connectMosaicSource } from '../../data/mosaicSource';
import { deriveCollections } from '../../data/schemaModel';
import { collectAllRows, downloadFile, toCSV, toJSONExport } from './export';

// The DOM download mechanics (object URL + anchor click) don't exist in
// jsdom; the browser path is covered by the e2e verify drive.
vi.mock('./export', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./export')>();
  return { ...mod, downloadFile: vi.fn() };
});

const endpoint = { url: 'http://example.test/graphql' };

function makeRows(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `BK-${offset + i + 1}`,
    title: `Book ${offset + i + 1}`,
    author: { id: `AU-${(offset + i) % 3}` },
    reviews: [{ id: 'RV-1' }, { id: 'RV-2' }],
  }));
}

describe('toCSV', () => {
  it('serializes derived columns: refs → target id, refLists → joined ids, escaping', () => {
    const [books] = deriveCollections(capableSchema());
    const rows = [
      {
        id: 'BK-1',
        title: 'Comma, and "quotes"',
        published_on: null,
        page_count: 42,
        in_print: true,
        format: 'EBOOK',
        author: { id: 'AU-1' },
        reviews: [{ id: 'RV-1' }, { id: 'RV-2' }],
      },
    ];
    const csv = toCSV(books.columns, rows);
    const [header, line] = csv.split('\r\n');
    expect(header).toBe('Id,Title,Published on,Page count,In print,Format,Author,Reviews');
    expect(line).toBe('BK-1,"Comma, and ""quotes""",,42,true,EBOOK,AU-1,RV-1; RV-2');
  });
});

describe('collectAllRows', () => {
  async function sourceWith(pages: Record<number, Record<string, unknown>[]>) {
    const client = fakeClient(capableSchema(), (_query, variables) => {
      const offset = (variables['offset'] as number) ?? 0;
      const pageSize = (variables['limit'] as number) ?? 100;
      const page = Math.floor(offset / pageSize) + 1;
      return { data: { books: pages[page] ?? [] }, error: null };
    });
    return { source: await connectMosaicSource(client), client };
  }

  it('pages through until a short page', async () => {
    const { source, client } = await sourceWith({
      1: makeRows(100),
      2: makeRows(100, 100),
      3: makeRows(7, 200),
    });
    const [books] = source.collections;
    const result = await collectAllRows(source, books, {}, '');
    expect(result.rows).toHaveLength(207);
    expect(result.truncated).toBe(false);
    // Filters/search travel with every export page request.
    const withFilter = await collectAllRows(source, books, { format: 'EBOOK' }, 'x', 300);
    expect(withFilter.rows.length).toBeGreaterThan(0);
    expect(
      client.recorded
        .filter((q) => q.document.includes('ApertureList') && q.variables['filter'])
        .every((q) => JSON.stringify(q.variables['filter']) === '{"format":"EBOOK"}'),
    ).toBe(true);
  });

  it('caps the export and reports truncation honestly', async () => {
    const pages: Record<number, Record<string, unknown>[]> = {};
    for (let p = 1; p <= 4; p++) pages[p] = makeRows(100, (p - 1) * 100);
    const { source } = await sourceWith(pages);
    const [books] = source.collections;
    const result = await collectAllRows(source, books, {}, '', 250);
    expect(result.rows).toHaveLength(250);
    expect(result.truncated).toBe(true);
  });

  it('inherits active range-facet conditions (issue #61)', async () => {
    const client = fakeClient(fieldRangeSchema(), () => ({
      data: { things: { items: [{ id: 'T-1', age: 42 }], total: 1 } },
      error: null,
    }));
    const source = await connectMosaicSource(client);
    const [things] = source.collections;
    await collectAllRows(source, things, {}, '', 100, undefined, [
      { field: 'age', value: 18, op: 'GTE' },
    ]);
    const sent = client.recorded.find((r) => r.document.includes('ApertureList'))!;
    expect(sent.variables['filters']).toEqual([{ field: 'age', value: 18, op: 'GTE' }]);
  });
});

describe('Export UI (R3.10)', () => {
  it('downloads a CSV of the filtered set and reports the row count', async () => {
    const user = userEvent.setup();
    const rows = makeRows(3);
    const client = fakeClient(capableSchema(), () => ({
      data: { books: rows, authors: [] },
      error: null,
    }));

    render(
      <NuqsTestingAdapter hasMemory>
        <App endpoint={endpoint} clientFactory={() => client} />
      </NuqsTestingAdapter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/Exported 3 rows\./)).toBeInTheDocument();

    const download = vi.mocked(downloadFile);
    expect(download).toHaveBeenCalledTimes(1);
    const [filename, mime, content] = download.mock.calls[0];
    expect(filename).toBe('books.csv');
    expect(mime).toBe('text/csv');
    expect(content).toContain('Id,Title');
    expect(content).toContain('BK-1');
  });

  it('JSON export produces the raw rows', () => {
    expect(JSON.parse(toJSONExport(makeRows(2)))).toHaveLength(2);
  });
});
