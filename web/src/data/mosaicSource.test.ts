import {
  buildCreateMutation,
  buildDetailQuery,
  buildListQuery,
  buildSetAvailabilityMutation,
  buildSupersedeMutation,
  buildUpdateMutation,
  connectMosaicSource,
} from './mosaicSource';
import { deriveCollections } from './schemaModel';
import {
  bareSchema,
  capableSchema,
  facetCountsSchema,
  fakeClient,
  fieldRangeSchema,
  realIntrospection,
  sortableSchema,
} from './testing/fixtures';

const BOOK_COLUMNS = 'authorId format inPrint title year id isAvailable version';

describe('buildListQuery', () => {
  it('builds an offset page with typed variables (refs select their id field)', () => {
    const [books] = deriveCollections(capableSchema());
    const { document, variables } = buildListQuery(books, { page: 3, pageSize: 25 });
    expect(document).toBe(
      'query ApertureList($limit: Int, $offset: Int) { books(limit: $limit, offset: $offset) ' +
        '{ id title published_on page_count in_print format author { id } reviews { id } } }',
    );
    expect(variables).toEqual({ limit: 25, offset: 50 });
  });

  it('passes equality filters and search through introspected args', () => {
    const [books] = deriveCollections(capableSchema());
    const { document, variables } = buildListQuery(books, {
      page: 1,
      pageSize: 25,
      filters: { format: 'EBOOK', in_print: true },
      search: 'catalog',
    });
    expect(document).toContain('$filter: BookFilter');
    expect(document).toContain('filter: $filter');
    expect(document).toContain('search: $search');
    expect(variables).toEqual({
      limit: 25,
      offset: 0,
      filter: { format: 'EBOOK', in_print: true },
      search: 'catalog',
    });
  });

  it('omits args the endpoint does not advertise (never fakes)', () => {
    const [things] = deriveCollections(bareSchema());
    const { document, variables } = buildListQuery(things, {
      page: 1,
      pageSize: 25,
      filters: { anything: 'x' },
      search: 'y',
    });
    expect(document).toBe('query ApertureList { things { label } }');
    expect(variables).toEqual({});
  });
});

describe('buildListQuery (live Hippo shapes — #15)', () => {
  const books = deriveCollections(realIntrospection).find((c) => c.id === 'books')!;

  // These document strings are VERIFIED against a live `hippo serve` v0.10.3
  // (certification fixture schema): 5 Books, total=5.
  it('selects the { items total } page envelope with required Int! paging', () => {
    const { document, variables, rootField, envelope } = buildListQuery(books, {
      page: 1,
      pageSize: 25,
    });
    expect(document).toBe(
      'query ApertureList($limit: Int!, $offset: Int!) { books(limit: $limit, offset: $offset) ' +
        `{ items { ${BOOK_COLUMNS} } total } }`,
    );
    expect(variables).toEqual({ limit: 25, offset: 0 });
    expect(rootField).toBe('books');
    expect(envelope).toBe(true);
  });

  it('passes filters as the generic [{field, value}] list, combined with AND', () => {
    const { document, variables } = buildListQuery(books, {
      page: 1,
      pageSize: 25,
      filters: { format: 'paperback', in_print: true },
    });
    expect(document).toBe(
      'query ApertureList($limit: Int!, $offset: Int!, $filters: [FilterInput!], $filterMode: FilterMode!) ' +
        '{ books(limit: $limit, offset: $offset, filters: $filters, filterMode: $filterMode) ' +
        `{ items { ${BOOK_COLUMNS} } total } }`,
    );
    expect(variables).toEqual({
      limit: 25,
      offset: 0,
      filters: [
        { field: 'format', value: 'paperback' },
        { field: 'in_print', value: true },
      ],
      filterMode: 'AND',
    });
  });

  it('routes an active search to the twin — a bare list, so search replaces filters', () => {
    const { document, variables, rootField, envelope } = buildListQuery(books, {
      page: 2,
      pageSize: 25,
      filters: { format: 'paperback' },
      search: 'Le Guin',
    });
    expect(document).toBe(
      'query ApertureList($q: String!, $limit: Int!, $offset: Int!) ' +
        `{ searchBooks(q: $q, limit: $limit, offset: $offset) { ${BOOK_COLUMNS} } }`,
    );
    // The twin takes no filters — they must not leak into the variables.
    expect(variables).toEqual({ q: 'Le Guin', limit: 25, offset: 25 });
    expect(rootField).toBe('searchBooks');
    expect(envelope).toBe(false);
  });

  it('a composed envelope twin (Mosaic #157) keeps filters and the page envelope', () => {
    // Same base collection, but with the twin upgraded to the composed
    // shape the new endpoint advertises.
    const composed = {
      ...books,
      search: {
        ...books.search!,
        envelope: true,
        filterArg: 'filters',
        filterArgType: '[FilterInput!]',
        filterModeArg: 'filterMode',
        filterModeArgType: 'FilterMode!',
      },
    };
    const { document, variables, rootField, envelope } = buildListQuery(composed, {
      page: 2,
      pageSize: 25,
      filters: { format: 'paperback' },
      filterMode: 'AND',
      search: 'Le Guin',
    });
    expect(document).toBe(
      'query ApertureList($q: String!, $limit: Int!, $offset: Int!, ' +
        '$filters: [FilterInput!], $filterMode: FilterMode!) ' +
        '{ searchBooks(q: $q, limit: $limit, offset: $offset, ' +
        `filters: $filters, filterMode: $filterMode) { items { ${BOOK_COLUMNS} } total } }`,
    );
    expect(variables).toEqual({
      q: 'Le Guin',
      limit: 25,
      offset: 25,
      filters: [{ field: 'format', value: 'paperback' }],
      filterMode: 'AND',
    });
    expect(rootField).toBe('searchBooks');
    expect(envelope).toBe(true);
  });

  it('detail rides the singular field with the full column set', () => {
    const built = buildDetailQuery(books, 'book-left-hand')!;
    expect(built.document).toBe(
      'query ApertureDetail($id: ID!) { book(id: $id) ' +
        `{ ${BOOK_COLUMNS} createdAt updatedAt schemaVersion createdBy updatedBy supersededBy author { id } } }`,
    );
    expect(built.variables).toEqual({ id: 'book-left-hand' });
  });
});

describe('buildListQuery (server-side sort — Mosaic ADR-0007, issue #20)', () => {
  const [things] = deriveCollections(sortableSchema());

  it('sends orderBy/orderDir as typed variables when a sort is active', () => {
    const { document, variables } = buildListQuery(things, {
      page: 1,
      pageSize: 25,
      orderBy: { field: 'LABEL', dir: 'DESC' },
    });
    expect(document).toBe(
      'query ApertureList($limit: Int!, $offset: Int!, $orderBy: ThingOrderField, ' +
        '$orderDir: OrderDirection!) { things(limit: $limit, offset: $offset, ' +
        'orderBy: $orderBy, orderDir: $orderDir) { items { id label } total } }',
    );
    expect(variables).toEqual({ limit: 25, offset: 0, orderBy: 'LABEL', orderDir: 'DESC' });
  });

  it('defaults direction to ASC when unspecified', () => {
    const { variables } = buildListQuery(things, {
      page: 1,
      pageSize: 25,
      orderBy: { field: 'ID' },
    });
    expect(variables).toEqual({ limit: 25, offset: 0, orderBy: 'ID', orderDir: 'ASC' });
  });

  it('omits orderBy/orderDir entirely when no sort is active (never fakes)', () => {
    const { document, variables } = buildListQuery(things, { page: 1, pageSize: 25 });
    expect(document).not.toContain('orderBy');
    expect(variables).toEqual({ limit: 25, offset: 0 });
  });

  it('threads orderBy/orderDir through an active search twin too', () => {
    const { document, variables, rootField } = buildListQuery(things, {
      page: 1,
      pageSize: 25,
      search: 'widget',
      orderBy: { field: 'LABEL', dir: 'DESC' },
    });
    expect(rootField).toBe('searchThings');
    expect(document).toContain('orderBy: $orderBy, orderDir: $orderDir');
    expect(variables).toEqual({
      q: 'widget',
      limit: 25,
      offset: 0,
      orderBy: 'LABEL',
      orderDir: 'DESC',
    });
  });
});

describe('buildDetailQuery', () => {
  it('prefers the singular field path and selects the full detail column set', () => {
    const [books] = deriveCollections(capableSchema());
    const built = buildDetailQuery(books, 'BK-1')!;
    expect(built.document).toBe(
      'query ApertureDetail($id: ID!) { book(id: $id) ' +
        '{ id title published_on page_count in_print format author { id } reviews { id } } }',
    );
    expect(built.variables).toEqual({ id: 'BK-1' });
  });

  it('returns null when the collection has no detail path', () => {
    const collections = deriveCollections(capableSchema());
    const authors = collections.find((c) => c.id === 'authors')!;
    expect(authors.detail).toBeUndefined();
    expect(buildDetailQuery(authors, 'AU-1')).toBeNull();
  });
});

describe('write mutations (W4.3)', () => {
  it('builds create/update documents from the derived write paths', () => {
    const [books] = deriveCollections(capableSchema());
    const create = buildCreateMutation(books, { title: 'T' })!;
    expect(create.document).toBe(
      'mutation ApertureCreate($input: BookInput!) { createBook(input: $input) { id } }',
    );
    expect(create.variables).toEqual({ input: { title: 'T' } });

    const update = buildUpdateMutation(books, 'BK-1', { page_count: 9 })!;
    expect(update.document).toBe(
      'mutation ApertureUpdate($id: ID!, $input: BookUpdateInput!) ' +
        '{ updateBook(id: $id, input: $input) { id } }',
    );
    // Partial-merge: only the provided fields travel.
    expect(update.variables).toEqual({ id: 'BK-1', input: { page_count: 9 } });
  });

  it('returns null for collections without write paths', () => {
    const collections = deriveCollections(capableSchema());
    const authors = collections.find((c) => c.id === 'authors')!;
    expect(buildCreateMutation(authors, {})).toBeNull();
    expect(buildUpdateMutation(authors, 'AU-1', {})).toBeNull();
  });

  it('createEntity returns the new id; updateEntity surfaces server rejection', async () => {
    const client = fakeClient(capableSchema(), (query) => {
      if (query.includes('ApertureCreate')) {
        return { data: { createBook: { id: 'BK-NEW' } }, error: null };
      }
      if (query.includes('ApertureUpdate')) {
        return { data: null, error: new Error('title must not be empty') };
      }
      return { data: {}, error: null };
    });
    const source = await connectMosaicSource(client);
    expect(await source.createEntity('books', { title: 'T' })).toBe('BK-NEW');
    await expect(source.updateEntity('books', 'BK-1', { title: '' })).rejects.toThrow(
      /Could not update Book “BK-1”: title must not be empty/,
    );
    await expect(source.createEntity('authors', {})).rejects.toThrow(/does not support create/);
  });
});

describe('lifecycle mutations (W4.4)', () => {
  it('builds the availability-transition and supersede documents', () => {
    const [books] = deriveCollections(capableSchema({ bookLifecycle: true }));

    const avail = buildSetAvailabilityMutation(books, 'BK-1', false)!;
    expect(avail.document).toBe(
      'mutation ApertureSetAvailability($id: ID!, $isAvailable: Boolean!) ' +
        '{ setBookAvailability(id: $id, isAvailable: $isAvailable) { entityId isAvailable } }',
    );
    expect(avail.variables).toEqual({ id: 'BK-1', isAvailable: false });

    const availWithReason = buildSetAvailabilityMutation(books, 'BK-1', false, 'duplicate record')!;
    expect(availWithReason.document).toContain('$reason: String');
    expect(availWithReason.variables).toEqual({
      id: 'BK-1',
      isAvailable: false,
      reason: 'duplicate record',
    });

    const supersede = buildSupersedeMutation(books, 'BK-1', 'BK-2')!;
    expect(supersede.document).toBe(
      'mutation ApertureSupersede($id: ID!, $replacementId: ID!) ' +
        '{ supersedeBook(id: $id, replacementId: $replacementId) { entityId supersededBy } }',
    );
    expect(supersede.variables).toEqual({ id: 'BK-1', replacementId: 'BK-2' });
  });

  it('returns null when the collection has no lifecycle paths (never fakes)', () => {
    const [books] = deriveCollections(capableSchema());
    expect(buildSetAvailabilityMutation(books, 'BK-1', false)).toBeNull();
    expect(buildSupersedeMutation(books, 'BK-1', 'BK-2')).toBeNull();
  });

  it('setAvailability/supersede execute the mutation; both surface server rejection', async () => {
    const client = fakeClient(capableSchema({ bookLifecycle: true }), (query) => {
      if (query.includes('ApertureSetAvailability')) {
        return { data: null, error: new Error('entity not found') };
      }
      if (query.includes('ApertureSupersede')) {
        return { data: { supersedeBook: { entityId: 'BK-1', supersededBy: 'BK-2' } }, error: null };
      }
      return { data: {}, error: null };
    });
    const source = await connectMosaicSource(client);

    await expect(source.setAvailability('books', 'BK-1', false)).rejects.toThrow(
      /Could not update availability for Book “BK-1”: entity not found/,
    );
    await expect(source.supersede('books', 'BK-1', 'BK-2')).resolves.toBeUndefined();

    const bareSource = await connectMosaicSource(fakeClient(capableSchema()));
    await expect(bareSource.setAvailability('books', 'BK-1', false)).rejects.toThrow(
      /does not support availability transitions/,
    );
    await expect(bareSource.supersede('books', 'BK-1', 'BK-2')).rejects.toThrow(
      /does not support supersede/,
    );
  });
});

describe('connectMosaicSource', () => {
  it('introspects, then serves schema-derived pages', async () => {
    const rows = [{ id: 'b1' }, { id: 'b2' }];
    const client = fakeClient(capableSchema(), () => ({ data: { books: rows }, error: null }));
    const source = await connectMosaicSource(client);

    expect(source.collections.map((c) => c.id)).toEqual(['books', 'authors']);
    expect(source.capabilities.offsetPagination).toBe(true);

    const page = await source.listEntities('books', { page: 1, pageSize: 2 });
    expect(page.rows).toEqual(rows);
    expect(page.mayHaveMore).toBe(true); // full page — next page may exist

    const short = await source.listEntities('books', { page: 1, pageSize: 10 });
    expect(short.mayHaveMore).toBe(false); // 2 rows < pageSize 10
  });

  it('unwraps envelope pages and paginates from the server-reported total', async () => {
    const items = [{ id: 'b1' }, { id: 'b2' }];
    const client = fakeClient(realIntrospection, (query) =>
      query.includes('searchBooks')
        ? { data: { searchBooks: items }, error: null }
        : { data: { books: { items, total: 5 } }, error: null },
    );
    const source = await connectMosaicSource(client);
    expect(source.collections.map((c) => c.id)).toEqual([
      'apertureDocuments',
      'authors',
      'books',
      'externalIds',
      'reviews',
    ]);

    const first = await source.listEntities('books', { page: 1, pageSize: 2 });
    expect(first.rows).toEqual(items);
    expect(first.total).toBe(5);
    expect(first.mayHaveMore).toBe(true); // 2 of 5

    const last = await source.listEntities('books', { page: 2, pageSize: 3 });
    expect(last.mayHaveMore).toBe(false); // 3 + 2 = 5 of 5

    // Search rides the bare-list twin: no total → page-scoped honesty again.
    const searched = await source.listEntities('books', { page: 1, pageSize: 2, search: 'x' });
    expect(searched.rows).toEqual(items);
    expect(searched.total).toBeUndefined();
    expect(searched.mayHaveMore).toBe(true); // full page — a next page may exist
  });

  it('fetches an envelope entity along the singular detail field', async () => {
    const entity = { id: 'book-emma', title: 'Emma' };
    const client = fakeClient(realIntrospection, (query) =>
      query.includes('ApertureDetail')
        ? { data: { book: entity }, error: null }
        : { data: {}, error: null },
    );
    const source = await connectMosaicSource(client);
    expect(await source.getEntity('books', 'book-emma')).toEqual(entity);
  });

  it('fetches a single entity along the detail path', async () => {
    const entity = { id: 'BK-1', title: 'A Book' };
    const client = fakeClient(capableSchema(), (query) =>
      query.includes('ApertureDetail')
        ? { data: { book: entity }, error: null }
        : { data: {}, error: null },
    );
    const source = await connectMosaicSource(client);
    expect(await source.getEntity('books', 'BK-1')).toEqual(entity);
  });

  it('fetches entity history when advertised', async () => {
    const entries = [{ timestamp: 't1', action: 'created', actor: 'a' }];
    const client = fakeClient(capableSchema(), (query) =>
      query.includes('ApertureHistory')
        ? { data: { entityHistory: entries }, error: null }
        : { data: {}, error: null },
    );
    const source = await connectMosaicSource(client);
    expect(source.capabilities.entityHistory).toBe(true);
    expect(await source.getHistory('BK-1')).toEqual(entries);
    expect(
      client.queries.some((q) => q.includes('entityHistory(entityId: $id)')),
    ).toBe(true);
  });

  it('returns empty history when the endpoint does not advertise it', async () => {
    const source = await connectMosaicSource(fakeClient(bareSchema()));
    expect(source.capabilities.entityHistory).toBe(false);
    expect(await source.getHistory('X')).toEqual([]);
  });

  it('surfaces introspection failure as an error (honest, not a blank UI)', async () => {
    const boom = async () => ({ data: null, error: new Error('boom') });
    const failing = { query: boom, mutate: boom };
    await expect(connectMosaicSource(failing)).rejects.toThrow(/Could not introspect.*boom/);
  });

  it('rejects unknown collections and invalid paging', async () => {
    const source = await connectMosaicSource(fakeClient(capableSchema()));
    await expect(source.listEntities('nope', { page: 1, pageSize: 25 })).rejects.toThrow(
      /Unknown collection/,
    );
    await expect(source.listEntities('books', { page: 0, pageSize: 25 })).rejects.toThrow(
      /Invalid page/,
    );
    await expect(source.listEntities('books', { page: 1, pageSize: 10_000 })).rejects.toThrow(
      /Invalid page size/,
    );
  });

  it('surfaces list-query errors with the collection named', async () => {
    const client = fakeClient(capableSchema(), () => ({
      data: null,
      error: new Error('timeout'),
    }));
    const source = await connectMosaicSource(client);
    await expect(source.listEntities('books', { page: 1, pageSize: 25 })).rejects.toThrow(
      /Could not list Books: timeout/,
    );
  });
});

describe('getFacetCounts (Mosaic ADR-0007/X1, issue #20)', () => {
  it('requests one aliased field per facet, excluding each field’s own current selection', async () => {
    const client = fakeClient(facetCountsSchema(), (query) =>
      query.includes('ApertureFacetCounts')
        ? {
            data: {
              f0: [
                { value: 'ACTIVE', count: 3 },
                { value: 'ARCHIVED', count: 1 },
              ],
            },
            error: null,
          }
        : { data: {}, error: null },
    );
    const source = await connectMosaicSource(client);
    expect(source.capabilities.aggregation).toBe(true);

    const result = await source.getFacetCounts('things', ['status'], {
      status: 'ACTIVE',
      other: 'x',
    });

    expect(result).toEqual({
      status: [
        { value: 'ACTIVE', count: 3 },
        { value: 'ARCHIVED', count: 1 },
      ],
    });
    const sent = client.recorded.find((r) => r.document.includes('ApertureFacetCounts'))!;
    expect(sent.document).toBe(
      'query ApertureFacetCounts($f0Filters: [FilterInput!]) ' +
        '{ f0: thingsFacetCounts(field: "status", filters: $f0Filters, filterMode: AND) { value count } }',
    );
    // The facet's own current selection ('status': 'ACTIVE') is excluded from
    // its own count request; other active filters ('other') are kept.
    expect(sent.variables).toEqual({ f0Filters: [{ field: 'other', value: 'x' }] });
  });

  it('omits the filters arg entirely when no other filters are active', async () => {
    const client = fakeClient(facetCountsSchema(), () => ({
      data: { f0: [] },
      error: null,
    }));
    const source = await connectMosaicSource(client);
    await source.getFacetCounts('things', ['status'], {});
    const sent = client.recorded.find((r) => r.document.includes('ApertureFacetCounts'))!;
    expect(sent.document).toBe(
      'query ApertureFacetCounts { f0: thingsFacetCounts(field: "status") { value count } }',
    );
    expect(sent.variables).toEqual({});
  });

  it('returns {} without a request when the endpoint advertises no facetCounts field', async () => {
    const client = fakeClient(capableSchema());
    const source = await connectMosaicSource(client);
    expect(source.capabilities.aggregation).toBe(false);
    expect(await source.getFacetCounts('books', ['format'], {})).toEqual({});
    expect(client.queries.some((q) => q.includes('ApertureFacetCounts'))).toBe(false);
  });

  it('returns {} without a request when fields is empty', async () => {
    const client = fakeClient(facetCountsSchema());
    const source = await connectMosaicSource(client);
    expect(await source.getFacetCounts('things', [], {})).toEqual({});
    expect(client.queries.some((q) => q.includes('ApertureFacetCounts'))).toBe(false);
  });
});

describe('getFieldRange (Mosaic ADR-0007/X1, issue #61)', () => {
  it('requests one aliased field per range facet, carrying the active equality filters', async () => {
    const client = fakeClient(fieldRangeSchema(), (query) =>
      query.includes('ApertureFieldRange')
        ? { data: { f0: { min: 3, max: 88 } }, error: null }
        : { data: {}, error: null },
    );
    const source = await connectMosaicSource(client);
    expect(source.capabilities.rangeFacets).toBe(true);

    const result = await source.getFieldRange('things', ['age'], { status: 'ACTIVE' });

    expect(result).toEqual({ age: { min: 3, max: 88 } });
    const sent = client.recorded.find((r) => r.document.includes('ApertureFieldRange'))!;
    expect(sent.document).toBe(
      'query ApertureFieldRange($f0Filters: [FilterInput!]) ' +
        '{ f0: thingsFieldRange(field: "age", filters: $f0Filters, filterMode: AND) { min max } }',
    );
    expect(sent.variables).toEqual({ f0Filters: [{ field: 'status', value: 'ACTIVE' }] });
  });

  it('omits the filters arg entirely when no equality filters are active', async () => {
    const client = fakeClient(fieldRangeSchema(), () => ({
      data: { f0: { min: null, max: null } },
      error: null,
    }));
    const source = await connectMosaicSource(client);
    await source.getFieldRange('things', ['age'], {});
    const sent = client.recorded.find((r) => r.document.includes('ApertureFieldRange'))!;
    expect(sent.document).toBe(
      'query ApertureFieldRange { f0: thingsFieldRange(field: "age") { min max } }',
    );
    expect(sent.variables).toEqual({});
  });

  it('requests multiple range facets as separate aliases in one round-trip', async () => {
    const client = fakeClient(fieldRangeSchema(), (query) =>
      query.includes('ApertureFieldRange')
        ? { data: { f0: { min: 3, max: 88 }, f1: { min: '2020-01-01', max: '2026-01-01' } }, error: null }
        : { data: {}, error: null },
    );
    const source = await connectMosaicSource(client);
    const result = await source.getFieldRange('things', ['age', 'joined_on'], {});
    expect(result).toEqual({
      age: { min: 3, max: 88 },
      joined_on: { min: '2020-01-01', max: '2026-01-01' },
    });
    expect(client.queries.filter((q) => q.includes('ApertureFieldRange'))).toHaveLength(1);
  });

  it('returns {} without a request when the endpoint advertises no fieldRange field', async () => {
    const client = fakeClient(facetCountsSchema());
    const source = await connectMosaicSource(client);
    expect(source.capabilities.rangeFacets).toBe(false);
    expect(await source.getFieldRange('things', ['status'], {})).toEqual({});
    expect(client.queries.some((q) => q.includes('ApertureFieldRange'))).toBe(false);
  });

  it('returns {} without a request when fields is empty', async () => {
    const client = fakeClient(fieldRangeSchema());
    const source = await connectMosaicSource(client);
    expect(await source.getFieldRange('things', [], {})).toEqual({});
    expect(client.queries.some((q) => q.includes('ApertureFieldRange'))).toBe(false);
  });
});
