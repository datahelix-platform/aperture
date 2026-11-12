import type { IntrospectionSchema, TypeRef } from './introspection';
import { deriveCollections, deriveCapabilities, deriveHistory, humanize } from './schemaModel';
import { buildListQuery } from './hippoSource';
import {
  arg,
  bareSchema,
  capableSchema,
  enumRef,
  enumType,
  field,
  inputObjectType,
  list,
  nonNull,
  object,
  objectType,
  realIntrospection,
  scalar,
} from './testing/fixtures';

describe('humanize', () => {
  it('turns snake_case and camelCase field names into labels', () => {
    expect(humanize('published_on')).toBe('Published on');
    expect(humanize('pageCount')).toBe('Page count');
    expect(humanize('books')).toBe('Books');
  });
});

describe('deriveCollections', () => {
  it('derives a collection per Query list field, with a typed column model', () => {
    const collections = deriveCollections(capableSchema());
    expect(collections.map((c) => c.id)).toEqual(['books', 'authors']);

    const books = collections[0];
    expect(books.label).toBe('Books');
    expect(books.typeName).toBe('Book');
    expect(books.columns).toEqual([
      { field: 'id', label: 'Id', kind: 'id' },
      { field: 'title', label: 'Title', kind: 'text' },
      { field: 'published_on', label: 'Published on', kind: 'date' },
      { field: 'page_count', label: 'Page count', kind: 'number' },
      { field: 'in_print', label: 'In print', kind: 'boolean' },
      {
        field: 'format',
        label: 'Format',
        kind: 'enum',
        enumValues: ['HARDCOVER', 'PAPERBACK', 'EBOOK'],
      },
      { field: 'author', label: 'Author', kind: 'ref', targetType: 'Author', targetIdField: 'id' },
      {
        field: 'reviews',
        label: 'Reviews',
        kind: 'refList',
        targetType: 'Review',
        targetIdField: 'id',
      },
    ]);
  });

  it('records the pagination/filter/search arg names + types the endpoint advertises', () => {
    const [books, authors] = deriveCollections(capableSchema());
    expect(books.args).toEqual({
      limit: 'limit',
      offset: 'offset',
      filter: 'filter',
      search: 'search',
      orderBy: undefined,
    });
    expect(books.argTypes).toEqual({
      limit: 'Int',
      offset: 'Int',
      filter: 'BookFilter',
      search: 'String',
    });
    expect(books.idColumn).toBe('id');
    expect(authors.args.filter).toBeUndefined();
    expect(authors.args.limit).toBe('limit');
  });

  it('skips non-list, singular-detail, history, and introspection fields', () => {
    const collections = deriveCollections(capableSchema({ hippoSchema: true }));
    expect(collections.map((c) => c.id)).toEqual(['books', 'authors']);
  });

  it('derives equality facets from the filter input type only (R3.3)', () => {
    const [books, authors] = deriveCollections(capableSchema());
    expect(books.facets).toEqual([
      { field: 'format', label: 'Format', kind: 'enum', options: ['HARDCOVER', 'PAPERBACK', 'EBOOK'] },
      { field: 'in_print', label: 'In print', kind: 'boolean' },
      { field: 'author', label: 'Author', kind: 'ref' },
      // 'title' (plain String) and 'or' (combinator) are not equality facets.
    ]);
    expect(authors.facets).toEqual([]); // no filter arg → no facets, gated off
  });

  it('derives the detail path: singular field preferred, absent when unavailable', () => {
    const [books, authors] = deriveCollections(capableSchema());
    expect(books.detail).toEqual({ kind: 'field', field: 'book', argName: 'id', argType: 'ID!' });
    expect(authors.detail).toBeUndefined();
  });

  it('keeps the stub bare-list shape as the fallback (pageShape/filterShape markers)', () => {
    const [books, authors] = deriveCollections(capableSchema());
    expect(books.pageShape).toBe('list');
    expect(books.filterShape).toBe('inputObject');
    expect(books.search).toBeUndefined();
    expect(authors.pageShape).toBe('list');
    expect(authors.filterShape).toBeUndefined();
  });
});

describe('deriveCollections (live Hippo shapes — #15)', () => {
  const collections = deriveCollections(realIntrospection);
  const books = collections.find((c) => c.id === 'books')!;

  it('derives exactly the page-envelope collections — no search twins, no hippoSchema', () => {
    expect(collections.map((c) => c.id)).toEqual([
      'apertureDocuments',
      'authors',
      'books',
      'externalIds',
      'reviews',
    ]);
    expect(collections.every((c) => c.pageShape === 'envelope')).toBe(true);
  });

  it('maps the envelope args: limit/offset/filters + the FilterMode combinator', () => {
    expect(books.typeName).toBe('Book');
    expect(books.args).toEqual({ limit: 'limit', offset: 'offset', filter: 'filters' });
    expect(books.argTypes).toEqual({ limit: 'Int!', offset: 'Int!', filter: '[FilterInput!]' });
    expect(books.filterShape).toBe('filterList');
    expect(books.filterModeArg).toEqual({ name: 'filterMode', type: 'FilterMode!' });
    expect(books.idColumn).toBe('id'); // the entity's own id, not the authorId FK rename
  });

  it('attaches search twins to their base collections instead of deriving them', () => {
    expect(books.search).toEqual({
      field: 'searchBooks',
      argName: 'q',
      argType: 'String!',
      limitArg: 'limit',
      limitArgType: 'Int!',
      offsetArg: 'offset',
      offsetArgType: 'Int!',
    });
    expect(collections.every((c) => c.search != null)).toBe(true);
  });

  it('derives the detail path from the singular Query field', () => {
    expect(books.detail).toEqual({ kind: 'field', field: 'book', argName: 'id', argType: 'ID!' });
    expect(collections.every((c) => c.detail?.kind === 'field')).toBe(true);
  });

  it('derives facets from the collection columns, keyed by LinkML slot name', () => {
    expect(books.facets).toEqual([
      {
        field: 'format',
        label: 'Format',
        kind: 'enum',
        options: ['audiobook', 'ebook', 'hardcover', 'paperback'],
      },
      { field: 'in_print', label: 'In print', kind: 'boolean' },
      { field: 'is_available', label: 'Is available', kind: 'boolean' },
      { field: 'author', label: 'Author', kind: 'ref' },
    ]);
  });

  it('filter fields are the slot names of the columns, minus FK renames', () => {
    expect(books.filterFields).toEqual([
      'format',
      'in_print',
      'title',
      'year',
      'id',
      'is_available',
      'version',
      'created_at',
      'updated_at',
      'schema_version',
      'created_by',
      'updated_by',
      'superseded_by',
      'author',
    ]);
    // `authorId` is the FK rename of the `author` slot — filtering by it
    // silently matches nothing on live Hippo, so it must not be offered.
    expect(books.filterFields).not.toContain('author_id');
    const documents = collections.find((c) => c.id === 'apertureDocuments')!;
    expect(documents.filterFields).toEqual(expect.arrayContaining(['kind', 'name']));
  });

  it('write paths still derive for envelope collections', () => {
    expect(books.write.create?.field).toBe('createBook');
    expect(books.write.create?.inputArgName).toBe('data');
    expect(books.write.create?.inputArgType).toBe('BookCreateInput!');
    expect(books.write.update?.field).toBe('updateBook');
    expect(books.write.update?.idArgName).toBe('id');
  });

  it('lifecycle paths derive from the live availability/supersede mutations (W4.4)', () => {
    expect(books.lifecycle.setAvailability).toEqual({
      field: 'setBookAvailability',
      idArgName: 'id',
      idArgType: 'ID!',
      availabilityArgName: 'isAvailable',
      reasonArgName: 'reason',
    });
    expect(books.lifecycle.supersede).toEqual({
      field: 'supersedeBook',
      idArgName: 'id',
      idArgType: 'ID!',
      replacementArgName: 'replacementId',
      replacementArgType: 'ID!',
      reasonArgName: 'reason',
    });
    // The bulk mutation must not be mistaken for the single-entity one.
    expect(collections.every((c) => c.lifecycle.setAvailability?.field !== 'setBookAvailabilityBulk')).toBe(
      true,
    );
  });

  it('a NON_NULL arg with a server default never blocks derivation (Mosaic ADR-0007 orderDir)', () => {
    // Regression: `orderDir: OrderDirection! = ASC` (Mosaic aggregation-and-
    // ordering) made every list field carry a NON_NULL arg we don't supply;
    // per the GraphQL spec it is not *required* — the default satisfies it.
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int')), '100'),
            arg('offset', nonNull(scalar('Int')), '0'),
            arg('orderBy', enumRef('ThingOrderField')),
            arg('orderDir', nonNull(enumRef('OrderDirection')), 'ASC'),
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID'))), field('label', scalar('String'))]),
      ],
    };
    expect(deriveCollections(schema).map((c) => c.id)).toEqual(['things']);
  });

  it('attaches an envelope-shaped search twin (Mosaic #157) with its filter args', () => {
    const filterInput: TypeRef = { kind: 'INPUT_OBJECT', name: 'FilterInput', ofType: null };
    const pageArgs = [
      arg('limit', nonNull(scalar('Int'))),
      arg('offset', nonNull(scalar('Int'))),
      arg('filters', list(nonNull(filterInput))),
      arg('filterMode', nonNull(enumRef('FilterMode'))),
    ];
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), pageArgs),
          // Composed twin: same Page shape, required q, same filter args.
          field('searchThings', nonNull(object('ThingPage')), [
            arg('q', nonNull(scalar('String'))),
            ...pageArgs,
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID'))), field('label', scalar('String'))]),
      ],
    };
    const derived = deriveCollections(schema);
    // The twin never derives as a collection (its q is unsatisfiable there)…
    expect(derived.map((c) => c.id)).toEqual(['things']);
    // …it attaches to its base, carrying the envelope + filter args.
    expect(derived[0].search).toEqual({
      field: 'searchThings',
      argName: 'q',
      argType: 'String!',
      limitArg: 'limit',
      limitArgType: 'Int!',
      offsetArg: 'offset',
      offsetArgType: 'Int!',
      envelope: true,
      filterArg: 'filters',
      filterArgType: '[FilterInput!]',
      filterModeArg: 'filterMode',
      filterModeArgType: 'FilterMode!',
    });
  });

  it('tags columns with the orderBy enum member that sorts them (Mosaic ADR-0007, issue #20)', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int'))),
            arg('offset', nonNull(scalar('Int'))),
            arg('orderBy', enumRef('ThingOrderField')),
            arg('orderDir', nonNull(enumRef('OrderDirection')), 'ASC'),
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [
          field('id', nonNull(scalar('ID'))),
          field('collectedAt', scalar('Date')),
          field('label', scalar('String')), // not in the enum — stays unsortable
        ]),
        // Members are the LinkML slot names, SCREAMING_SNAKE (Mosaic's own
        // convention) — but matching is normalized, not name-format-assuming.
        enumType('ThingOrderField', ['ID', 'COLLECTED_AT']),
      ],
    };
    const [things] = deriveCollections(schema);
    expect(things.args.orderBy).toBe('orderBy');
    expect(things.args.orderDir).toBe('orderDir');
    expect(things.argTypes.orderBy).toBe('ThingOrderField');
    expect(things.argTypes.orderDir).toBe('OrderDirection!');
    expect(things.columns.map((c) => [c.field, c.orderField])).toEqual([
      ['id', 'ID'],
      ['collectedAt', 'COLLECTED_AT'],
      ['label', undefined],
    ]);
  });

  it('leaves columns unsortable when orderBy is absent or resolves to a non-enum type', () => {
    const noOrderBy = deriveCollections(capableSchema())[0];
    expect(noOrderBy.columns.every((c) => c.orderField == null)).toBe(true);

    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int'))),
            arg('offset', nonNull(scalar('Int'))),
            // Advertised, but not an enum — never assume it's the ADR-0007 shape.
            arg('orderBy', scalar('String')),
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID')))]),
      ],
    };
    const [things] = deriveCollections(schema);
    expect(things.columns.every((c) => c.orderField == null)).toBe(true);
  });

  it('attaches orderBy/orderDir to an envelope search twin when it advertises them (Mosaic #157/ADR-0007)', () => {
    const filterInput: TypeRef = { kind: 'INPUT_OBJECT', name: 'FilterInput', ofType: null };
    const pageArgs = [
      arg('limit', nonNull(scalar('Int'))),
      arg('offset', nonNull(scalar('Int'))),
      arg('filters', list(nonNull(filterInput))),
      arg('filterMode', nonNull(enumRef('FilterMode'))),
      arg('orderBy', enumRef('ThingOrderField')),
      arg('orderDir', nonNull(enumRef('OrderDirection')), 'ASC'),
    ];
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), pageArgs),
          field('searchThings', nonNull(object('ThingPage')), [
            arg('q', nonNull(scalar('String'))),
            ...pageArgs,
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID')))]),
        enumType('ThingOrderField', ['ID']),
      ],
    };
    const [things] = deriveCollections(schema);
    expect(things.search).toMatchObject({
      orderByArg: 'orderBy',
      orderByArgType: 'ThingOrderField',
      orderDirArg: 'orderDir',
      orderDirArgType: 'OrderDirection!',
    });
  });

  it('a search-shaped bare list with no base collection never derives (required q unsatisfiable)', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('searchThings', nonNull(list(nonNull(object('Thing')))), [
            arg('q', nonNull(scalar('String'))),
            arg('limit', scalar('Int')),
          ]),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID'))), field('label', scalar('String'))]),
      ],
    };
    expect(deriveCollections(schema)).toEqual([]);
  });
});

describe('deriveWriteModel (W4.1/W4.3)', () => {
  it('derives create/update paths + a serializable form model from the mutation surface', () => {
    const [books] = deriveCollections(capableSchema());
    expect(books.write.create).toEqual({
      field: 'createBook',
      inputArgName: 'input',
      inputArgType: 'BookInput!',
      form: {
        inputTypeName: 'BookInput',
        fields: [
          { name: 'title', label: 'Title', widget: 'text', required: true },
          { name: 'published_on', label: 'Published on', widget: 'date', required: false },
          { name: 'page_count', label: 'Page count', widget: 'number', required: false },
          { name: 'in_print', label: 'In print', widget: 'checkbox', required: false },
          {
            name: 'format',
            label: 'Format',
            widget: 'select',
            required: false,
            options: ['HARDCOVER', 'PAPERBACK', 'EBOOK'],
          },
          {
            name: 'author',
            label: 'Author',
            widget: 'ref',
            required: false,
            targetType: 'Author',
          },
          // multivalued 'tags' has no Tier-0 widget → omitted, never offered
        ],
      },
    });
    expect(books.write.update?.field).toBe('updateBook');
    expect(books.write.update?.idArgName).toBe('id');
    expect(books.write.update?.form.fields.find((f) => f.name === 'title')?.required).toBe(false);
  });

  it('is empty when no mutations target the type (write UI gates off)', () => {
    const collections = deriveCollections(capableSchema());
    const authors = collections.find((c) => c.id === 'authors')!;
    expect(authors.write).toEqual({});
    const [things] = deriveCollections(bareSchema());
    expect(things.write).toEqual({});
  });

  it('form model is plain serializable data (config-as-data seed)', () => {
    const [books] = deriveCollections(capableSchema());
    const form = books.write.create!.form;
    expect(JSON.parse(JSON.stringify(form))).toEqual(form);
  });
});

describe('deriveLifecycleModel (W4.4)', () => {
  it('is empty when the endpoint advertises no availability/supersede mutations (never fakes)', () => {
    const [books] = deriveCollections(capableSchema());
    expect(books.lifecycle).toEqual({});
    const [things] = deriveCollections(bareSchema());
    expect(things.lifecycle).toEqual({});
  });

  it('derives setAvailability + supersede paths when advertised', () => {
    const [books] = deriveCollections(capableSchema({ bookLifecycle: true }));
    expect(books.lifecycle.setAvailability).toEqual({
      field: 'setBookAvailability',
      idArgName: 'id',
      idArgType: 'ID!',
      availabilityArgName: 'isAvailable',
      reasonArgName: 'reason',
    });
    expect(books.lifecycle.supersede).toEqual({
      field: 'supersedeBook',
      idArgName: 'id',
      idArgType: 'ID!',
      replacementArgName: 'replacementId',
      replacementArgType: 'ID!',
      reasonArgName: 'reason',
    });
  });

  it('never matches the bulk availability mutation as the single-entity one', () => {
    const [books] = deriveCollections(capableSchema({ bookLifecycle: true }));
    expect(books.lifecycle.setAvailability?.field).not.toBe('setBookAvailabilityBulk');
  });

  it('does not derive lifecycle mutations for an unrelated type (name must reference the entity)', () => {
    const collections = deriveCollections(capableSchema({ bookLifecycle: true }));
    const authors = collections.find((c) => c.id === 'authors')!;
    expect(authors.lifecycle).toEqual({});
  });
});

describe('deriveHistory (R3.7)', () => {
  it('derives the entityHistory surface when advertised', () => {
    expect(deriveHistory(capableSchema())).toEqual({
      field: 'entityHistory',
      argName: 'entityId',
      argType: 'ID!',
      columns: [
        { field: 'timestamp', label: 'Timestamp', kind: 'text' },
        { field: 'action', label: 'Action', kind: 'text' },
        { field: 'actor', label: 'Actor', kind: 'text' },
      ],
    });
  });

  it('is absent on a bare endpoint', () => {
    expect(deriveHistory(bareSchema())).toBeUndefined();
  });
});

describe('deriveCapabilities (negotiated, never faked — ADR-0029)', () => {
  it('detects the full Hippo-like surface', () => {
    const schema = capableSchema({ hippoSchema: true });
    const caps = deriveCapabilities(schema, deriveCollections(schema));
    expect(caps).toEqual({
      schemaIntrospection: 'hippo',
      offsetPagination: true,
      equalityFacets: true,
      fullTextSearch: true,
      sort: false, // Hippo X1 not landed — stays off
      aggregation: false, // Hippo X1 not landed — stays off
      rangeFacets: false, // Hippo X1 not landed — stays off
      relationshipTraversal: true,
      entityHistory: true,
      batchWrite: true,
      // Pre-FilterOp-enum endpoint with a filter arg: bare equality only.
      filterOps: ['EQ'],
      whereFilter: false,
      // No converse mutation on this surface — the chat panel stays off.
      conversationalQuery: false,
      neighborsTraversal: false,
    });
  });

  it('reports standard introspection when hippoSchema is not advertised', () => {
    const schema = capableSchema();
    const caps = deriveCapabilities(schema, deriveCollections(schema));
    expect(caps.schemaIntrospection).toBe('graphql');
  });

  it('negotiates the live Hippo surface (envelope pages + search twins)', () => {
    const caps = deriveCapabilities(realIntrospection, deriveCollections(realIntrospection));
    expect(caps.schemaIntrospection).toBe('hippo');
    expect(caps.offsetPagination).toBe(true);
    expect(caps.equalityFacets).toBe(true);
    expect(caps.fullTextSearch).toBe(true);
    expect(caps.entityHistory).toBe(true);
    expect(caps.sort).toBe(false); // still unadvertised — stays off
    // The real ingestBatch shape ({entityType, data} entities + dryRun) is
    // now the derived contract — the batch surface gates ON (#15 write path).
    expect(caps.batchWrite).toBe(true);
    // The captured hippo 0.10.3 schema advertises the FilterOp enum (EQ/IN
    // era) and no typed where inputs yet (Mosaic ADR-0006 not landed there).
    expect(caps.filterOps).toContain('EQ');
    expect(caps.whereFilter).toBe(false);
  });

  it('sort gates on when an orderBy enum resolves to at least one column (Mosaic X1/ADR-0007, issue #20)', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int'))),
            arg('offset', nonNull(scalar('Int'))),
            arg('orderBy', enumRef('ThingOrderField')),
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID')))]),
        enumType('ThingOrderField', ['ID']),
      ],
    };
    const caps = deriveCapabilities(schema, deriveCollections(schema));
    expect(caps.sort).toBe(true);
  });

  it('sort stays off when orderBy is advertised but its enum matches no derived column', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int'))),
            arg('offset', nonNull(scalar('Int'))),
            arg('orderBy', enumRef('ThingOrderField')),
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID')))]),
        // Members share no normalized name with any derived column.
        enumType('ThingOrderField', ['RELEVANCE']),
      ],
    };
    const caps = deriveCapabilities(schema, deriveCollections(schema));
    expect(caps.sort).toBe(false);
  });

  it('derives a genuine facetCounts field and gates aggregation on (Mosaic ADR-0007, issue #20)', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int'))),
            arg('offset', nonNull(scalar('Int'))),
          ]),
          field('thingsFacetCounts', nonNull(list(nonNull(object('FacetCount')))), [
            arg('field', nonNull(scalar('String'))),
            arg('filters', list(object('FilterInput'))),
            arg('filterMode', enumRef('FilterMode')),
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID')))]),
        objectType('FacetCount', [field('value', scalar('String')), field('count', nonNull(scalar('Int')))]),
      ],
    };
    const [things] = deriveCollections(schema);
    expect(things.facetCounts).toEqual({
      field: 'thingsFacetCounts',
      fieldArgName: 'field',
      fieldArgType: 'String!',
      filtersArgName: 'filters',
      filtersArgType: '[FilterInput]',
      filterModeArgName: 'filterMode',
      filterModeArgType: 'FilterMode',
    });
    expect(deriveCapabilities(schema, deriveCollections(schema)).aggregation).toBe(true);
  });

  it('does not derive facetCounts from a name match alone (ADR-0029)', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int'))),
            arg('offset', nonNull(scalar('Int'))),
          ]),
          // Right name, wrong shape: no `field` arg, and the row type lacks
          // `count` — neither is a usable facetCounts primitive.
          field('thingsFacetCounts', nonNull(list(nonNull(object('Thing'))))),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID')))]),
      ],
    };
    const [things] = deriveCollections(schema);
    expect(things.facetCounts).toBeUndefined();
    expect(deriveCapabilities(schema, deriveCollections(schema)).aggregation).toBe(false);
  });

  /** A filterList collection with a numeric + a date column, for range-facet tests. */
  function rangeableSchema(withFieldRange: boolean): IntrospectionSchema {
    const queryFields = [
      field('things', nonNull(object('ThingPage')), [
        arg('limit', nonNull(scalar('Int'))),
        arg('offset', nonNull(scalar('Int'))),
        arg('filters', list(nonNull(object('FilterInput')))),
      ]),
    ];
    if (withFieldRange) {
      queryFields.push(
        field('thingsFieldRange', nonNull(object('FieldRange')), [
          arg('field', nonNull(scalar('String'))),
          arg('filters', list(object('FilterInput'))),
          arg('filterMode', enumRef('FilterMode')),
        ]),
      );
    }
    return {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', queryFields),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [
          field('id', nonNull(scalar('ID'))),
          field('age', scalar('Int')),
          field('joinedOn', scalar('Date')),
        ]),
        objectType('FieldRange', [field('min', scalar('Float')), field('max', scalar('Float'))]),
      ],
    };
  }

  it('derives a genuine fieldRange field and number-range/date-range facets, gates rangeFacets on (Mosaic ADR-0007, issue #61)', () => {
    const schema = rangeableSchema(true);
    const [things] = deriveCollections(schema);
    expect(things.fieldRange).toEqual({
      field: 'thingsFieldRange',
      fieldArgName: 'field',
      fieldArgType: 'String!',
      filtersArgName: 'filters',
      filtersArgType: '[FilterInput]',
      filterModeArgName: 'filterMode',
      filterModeArgType: 'FilterMode',
    });
    expect(things.facets).toEqual([
      { field: 'age', label: 'Age', kind: 'number-range' },
      { field: 'joined_on', label: 'Joined on', kind: 'date-range' },
    ]);
    expect(deriveCapabilities(schema, deriveCollections(schema)).rangeFacets).toBe(true);
  });

  it('derives no range facets — and gates rangeFacets off — without a genuine fieldRange field (ADR-0029: never fake)', () => {
    const schema = rangeableSchema(false);
    const [things] = deriveCollections(schema);
    expect(things.fieldRange).toBeUndefined();
    // Numeric/date columns exist, but with no FieldRange advertised a min/max
    // widget could never actually filter — nothing changes.
    expect(things.facets).toEqual([]);
    expect(deriveCapabilities(schema, deriveCollections(schema)).rangeFacets).toBe(false);
  });

  it('does not derive fieldRange from a name match alone (ADR-0029)', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(object('ThingPage')), [
            arg('limit', nonNull(scalar('Int'))),
            arg('offset', nonNull(scalar('Int'))),
            arg('filters', list(nonNull(object('FilterInput')))),
          ]),
          // Right name, wrong shape: it returns a LIST (facetCounts' shape),
          // not a single {min max} object.
          field('thingsFieldRange', nonNull(list(nonNull(object('FieldRange')))), [
            arg('field', nonNull(scalar('String'))),
          ]),
        ]),
        objectType('ThingPage', [
          field('items', nonNull(list(nonNull(object('Thing'))))),
          field('total', nonNull(scalar('Int'))),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID'))), field('age', scalar('Int'))]),
        objectType('FieldRange', [field('min', scalar('Float')), field('max', scalar('Float'))]),
      ],
    };
    const [things] = deriveCollections(schema);
    expect(things.fieldRange).toBeUndefined();
    expect(deriveCapabilities(schema, deriveCollections(schema)).rangeFacets).toBe(false);
  });

  it('never derives range facets for the inputObject/stub shape, even with a fieldRange field (conditions have no representation there)', () => {
    const schema: IntrospectionSchema = {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [
          field('things', nonNull(list(nonNull(object('Thing')))), [
            arg('filter', { kind: 'INPUT_OBJECT', name: 'ThingFilter', ofType: null }),
          ]),
          field('thingsFieldRange', nonNull(object('FieldRange')), [
            arg('field', nonNull(scalar('String'))),
          ]),
        ]),
        objectType('Thing', [field('id', nonNull(scalar('ID'))), field('age', scalar('Int'))]),
        objectType('FieldRange', [field('min', scalar('Float')), field('max', scalar('Float'))]),
        inputObjectType('ThingFilter', [arg('age', scalar('Int'))]),
      ],
    };
    const [things] = deriveCollections(schema);
    // The capability model is still honestly derived…
    expect(things.fieldRange).toBeDefined();
    // …but no widget: the stub filter shape never sends `conditions`.
    expect(things.facets).toEqual([]);
    expect(deriveCapabilities(schema, deriveCollections(schema)).rangeFacets).toBe(false);
  });

  it('gates everything off for a bare endpoint', () => {
    const schema = bareSchema();
    const caps = deriveCapabilities(schema, deriveCollections(schema));
    expect(caps).toEqual({
      schemaIntrospection: 'graphql',
      offsetPagination: false,
      equalityFacets: false,
      fullTextSearch: false,
      sort: false,
      aggregation: false,
      rangeFacets: false,
      relationshipTraversal: false,
      entityHistory: false,
      batchWrite: false,
      filterOps: [],
      whereFilter: false,
      conversationalQuery: false,
      neighborsTraversal: false,
    });
  });
});

describe('pickIdColumn (id-column selection)', () => {
  // An entity whose own identifier is NOT named `id`, next to a `donor`
  // reference and its FK-rename scalar `donorId`, with the FK ordered first.
  function rnaSchema(): IntrospectionSchema {
    return {
      queryType: { name: 'Query' },
      mutationType: null,
      types: [
        objectType('Query', [field('rnas', list(object('Rna')))]),
        objectType('Rna', [
          field('donor', object('Donor')),
          field('donorId', scalar('ID')),
          field('accession', scalar('ID')),
          field('name', scalar('String')),
        ]),
        objectType('Donor', [field('id', scalar('ID')), field('name', scalar('String'))]),
      ],
    };
  }

  it('does not pick an FK-rename scalar as the id column', () => {
    const [rnas] = deriveCollections(rnaSchema());
    // `donorId` is the foreign key of the `donor` ref, not Rna's own identity —
    // picking it would make the id-column link point a donor id at the rnas
    // collection (the wrong-collection bug). The entity's own id-typed field wins.
    expect(rnas.idColumn).toBe('accession');
    expect(rnas.idColumn).not.toBe('donorId');
  });

  /**
   * A class declaring more than MAX_COLUMNS (8) fields before its `id` — the
   * ordinary case on a real schema, not a contrived one: the 15-collection demo
   * deployment has `id` at index 8 on Instrument and index 9 on Publication.
   */
  function lateIdSchema(): IntrospectionSchema {
    const wide = Array.from({ length: 9 }, (_, i) => field(`slot${i}`, scalar('String')));
    return {
      queryType: { name: 'Query' },
      types: [
        objectType('Query', [
          field('instruments', nonNull(list(nonNull(object('Instrument')))), [
            arg('limit', scalar('Int')),
            arg('offset', scalar('Int')),
          ]),
          field('instrument', object('Instrument'), [arg('id', nonNull(scalar('ID')))]),
        ]),
        objectType('Instrument', [...wide, field('id', scalar('ID'))]),
      ],
    };
  }

  it('identifies a record by its id even when the table budget excludes it', () => {
    const [instruments] = deriveCollections(lateIdSchema());
    // Issue #67. `idColumn` used to be picked from `columns` — the MAX_COLUMNS
    // slice — so an `id` past index 7 fell through to the "first non-FK column"
    // arm and the collection identified its records by `slot0`. A presentation
    // budget must not decide what identifies a record, above all because the
    // planner's semijoin reads `row[idColumn]` and an `IN` over the wrong field
    // matches nothing while reporting no error.
    expect(instruments.columns.some((c) => c.field === 'id')).toBe(false);
    expect(instruments.idColumn).toBe('id');
  });

  it('selects the identifying column even when it is outside the table budget', () => {
    const [instruments] = deriveCollections(lateIdSchema());
    const { document } = buildListQuery(instruments, { page: 1, pageSize: 25 });
    // Naming the right column is only half of it: the list query selects
    // `columns`, so without appending the identifier every consumer would read
    // `undefined` — a missing id in place of a wrong one, no better.
    expect(document).toContain('id');
    expect(document).toContain('slot0');
  });
});
