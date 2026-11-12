import type { Capabilities } from './capabilities';
import type { BatchModel, BatchOperation, BatchResult } from './batch';
import { buildIngestBatch, deriveBatchModel, normalizeBatchResult } from './batch';
import type { ConversationModel, ConverseRequest, ConverseResponse } from './conversation';
import { buildConverseMutation, deriveConversationModel, normalizeConverseResult } from './conversation';
import type { Neighborhood, NeighborsModel } from './neighbors';
import { buildNeighborsQuery, deriveNeighborsModel, normalizeNeighborhood } from './neighbors';
import type {
  IntrospectionData,
  IntrospectionSchema,
  SlotEnrichment,
  SlotEnrichmentData,
} from './introspection';
import {
  findType,
  HIPPO_SCHEMA_QUERY,
  indexSlotEnrichment,
  INTROSPECTION_QUERY,
} from './introspection';
import type { ScopedDataClient } from './scopedClient';
import type { CollectionModel, ColumnModel, HistoryModel } from './schemaModel';
import { deriveCapabilities, deriveCollections, deriveHistory } from './schemaModel';

/**
 * The Layer-D source adapter (ADR-0017): introspects the active endpoint
 * once, derives the browsable collections + a negotiated `Capabilities`
 * object, and executes schema-derived queries. Generic over any conformant
 * GraphQL endpoint; Hippo enrichment upgrades it when advertised.
 */

/** Active equality filters: filter-input field → value (AND across fields, R3.3). */
export type FilterValues = Record<string, string | boolean>;

/**
 * Active range-facet selections (issue #61): one `{gte?, lte?}` bound per
 * numeric/date facet field — the serialized form `urlState.ts`'s `ranges`
 * state and saved views carry; `rangeConditions` turns these into the typed
 * `GTE`/`LTE` `FilterCondition` entries below.
 */
export type RangeValues = Record<string, { gte?: string | number; lte?: string | number }>;

/**
 * One typed filter condition for the flat `filters:` list (Mosaic ADR-0006
 * increment 1). `op` is a member of the endpoint's introspected `FilterOp`
 * enum (`EQ`/`IN`/`NEQ`/`GT`/…); omit it (or pass `EQ`) for plain equality —
 * equality entries are emitted without an `op` key so pre-enum endpoints and
 * the certified golden-path query shapes are untouched.
 */
export interface FilterCondition {
  field: string;
  value: unknown;
  op?: string;
}

export interface ListOptions {
  page: number;
  pageSize: number;
  filters?: FilterValues;
  /** Typed conditions appended to the same flat `filters:` list (ADR-0035 planner). */
  conditions?: FilterCondition[];
  /** AND (default) / OR across all filter entries, when the endpoint advertises FilterMode. */
  filterMode?: 'AND' | 'OR';
  /**
   * The typed `<Type>Filter` input (Mosaic ADR-0006), when the collection
   * advertises a `where` argument.
   *
   * Applies to the base list field only. The search twin takes its own
   * `where` on the server, but `SearchTwinModel` does not derive it yet and
   * the QuerySpec planner never searches — composing search with typed
   * filters is Mosaic's search-composition work, tracked separately.
   *
   * Composes with `conditions`/`filters` **by AND** — the server's own
   * documented contract, which is why the planner may mix the two only for an
   * AND-mode spec. For OR it would silently change the query's meaning.
   */
  where?: Record<string, unknown>;
  /**
   * Extra selection for result columns reached through a reference (ADR-0041),
   * already compiled — `donor { id cohort }`.
   *
   * A compiled string rather than the paths themselves, because resolving a
   * path needs the whole collection graph and this layer only ever holds one
   * collection. The planner owns that compilation, as it already does for
   * `where`, and both the live query and the export page-through pass the same
   * string so the file cannot disagree with the screen.
   */
  pathSelection?: string;
  search?: string;
  /**
   * Server-side ordering (Mosaic ADR-0007), when the collection advertises
   * it: `field` is the column's derived `orderField` enum member — never a
   * raw column name — and `dir` defaults to ascending.
   */
  orderBy?: { field: string; dir?: 'ASC' | 'DESC' };
  /**
   * Columns to select beyond the curated table set — e.g. the reference
   * column a semijoin extracts linking ids from (ADR-0035 planner), which
   * the table budget routinely truncates away.
   */
  extraColumns?: ColumnModel[];
  /** Bypass the document cache (read-after-write surfaces, e.g. the control plane). */
  fresh?: boolean;
}

export interface EntityPage {
  rows: Record<string, unknown>[];
  /** True when a next page may exist (from `total` when the page envelope carries one). */
  mayHaveMore: boolean;
  /** The server-reported total for the filtered set (envelope pages only). */
  total?: number;
}

export interface HistoryEntry {
  [field: string]: unknown;
}

/** Form values keyed by input-field name; null clears a field on update. */
export type WriteValues = Record<string, string | number | boolean | null>;

export interface HippoSource {
  capabilities: Capabilities;
  collections: CollectionModel[];
  history?: HistoryModel;
  listEntities(collectionId: string, options: ListOptions): Promise<EntityPage>;
  /**
   * Fetch one entity via the collection's detail path; null when not found.
   * `fresh` bypasses the document cache — needed for read-after-write when
   * the write's mutation response doesn't share the entity's typename (e.g.
   * the lifecycle mutations, W4.4), which urql's cache invalidation can't
   * key off of.
   */
  getEntity(collectionId: string, id: string, fresh?: boolean): Promise<Record<string, unknown> | null>;
  /** Entity change history, when the endpoint advertises it (R3.7). */
  getHistory(id: string): Promise<HistoryEntry[]>;
  /**
   * Per-value counts for a set of equality facets on one collection, under
   * the collection's other active filters (each facet's own current
   * selection is excluded from its own counts, so switching among a facet's
   * options never zeroes out the alternatives — issue #20). Empty when the
   * collection advertises no `facetCounts` field or `fields` is empty.
   */
  getFacetCounts(
    collectionId: string,
    fields: string[],
    filters: FilterValues,
  ): Promise<Record<string, { value: unknown; count: number }[]>>;
  /**
   * Advertised min/max bounds for a set of numeric/date range facets on one
   * collection, under the collection's active equality filters (issue #61)
   * — the bounds pre-fill a `RangeFacet` widget's inputs. Empty when the
   * collection advertises no `fieldRange` field or `fields` is empty.
   */
  getFieldRange(
    collectionId: string,
    fields: string[],
    filters: FilterValues,
  ): Promise<Record<string, { min: unknown; max: unknown }>>;
  /** Create via the derived write path; returns the new entity's id column value (W4.3). */
  createEntity(collectionId: string, values: WriteValues): Promise<string | null>;
  /** Partial-merge update: send only the given fields (W4.3). */
  updateEntity(collectionId: string, id: string, values: WriteValues): Promise<void>;
  /** Availability transition (W4.4), when the endpoint advertises one. */
  setAvailability(
    collectionId: string,
    id: string,
    isAvailable: boolean,
    reason?: string,
  ): Promise<void>;
  /** Supersede with a replacement entity (W4.4), when the endpoint advertises it. */
  supersede(
    collectionId: string,
    id: string,
    replacementId: string,
    reason?: string,
  ): Promise<void>;
  /** The introspected batch unit-of-work surface, when usable (ADR-0028). */
  batch?: BatchModel;
  /** Whole-set dry-run (dryRun=true) or atomic commit of a staged set (W4.7). */
  runBatch(operations: BatchOperation[], dryRun: boolean): Promise<BatchResult>;
  /** The introspected conversational query surface, when usable (ADR-0039). */
  conversation?: ConversationModel;
  /** One conversational turn; the response's `turns` replaces the caller's list. */
  /**
   * `signal` aborts the round trip. A conversational turn can legitimately run
   * to the planning service's full timeout, so abandoning one must release the
   * request, not merely stop rendering it (ADR-0039 / design Decision 10).
   */
  converse(request: ConverseRequest, signal?: AbortSignal): Promise<ConverseResponse>;
  /** The introspected `neighbors` traversal root, when usable (ADR-0037 server tier). */
  neighbors?: NeighborsModel;
  /** The one-hop neighborhood of an entity, in one request (ADR-0037 server tier). */
  getNeighbors(id: string): Promise<Neighborhood>;
}

function selectionFor(column: ColumnModel): string {
  if (column.kind === 'ref' || column.kind === 'refList') {
    return `${column.field} { ${column.targetIdField} }`;
  }
  return column.field;
}

function selectionSet(columns: ColumnModel[], extra?: ColumnModel[]): string {
  const seen = new Set(columns.map((c) => c.field));
  const all = [...columns, ...(extra ?? []).filter((c) => !seen.has(c.field))];
  return all.map(selectionFor).join(' ');
}

/**
 * The full row selection: the anchor's own columns plus any traversal paths.
 *
 * The two are appended rather than merged into one tree, because they overlap
 * only on reference fields and `selectionFor` already emits those as
 * `field { id }`. A path through the same reference emits a richer selection
 * for it, and GraphQL merges sibling selections on the same field — so asking
 * for `donor { id }` and `donor { cohort }` yields `donor { id cohort }`,
 * which is what we want and costs nothing to say twice.
 */
function rowSelection(collection: CollectionModel, options: ListOptions): string {
  const base = selectionSet(listColumns(collection), options.extraColumns);
  return options.pathSelection ? `${base} ${options.pathSelection}` : base;
}

/**
 * The table's columns, plus the identifying column when the budget excluded it
 * (issue #67).
 *
 * `idColumn` now derives from the full field set rather than the `MAX_COLUMNS`
 * table slice, so it can name a column the slice does not carry. Selecting only
 * the slice would then hand every consumer `undefined` — trading a *wrong* id
 * for a *missing* one, which breaks row navigation and the planner's semijoin
 * just as thoroughly and is harder to see.
 *
 * Appended rather than hoisted into `columns`: the table should not grow a UUID
 * column on classes that correctly lead with a human-readable name. It travels
 * in the row payload and is read by field name.
 */
function listColumns(collection: CollectionModel): ColumnModel[] {
  const { columns, idColumn } = collection;
  if (!idColumn || columns.some((c) => c.field === idColumn)) return columns;
  const identifying = collection.detailColumns.find((c) => c.field === idColumn);
  return identifying ? [...columns, identifying] : columns;
}

export interface BuiltQuery {
  document: string;
  variables: Record<string, unknown>;
}

export interface BuiltListQuery extends BuiltQuery {
  /** The Query field the rows come back under (the search twin when searching). */
  rootField: string;
  /** True when rows arrive inside an `{ items total }` page envelope. */
  envelope: boolean;
}

class QueryBuilder {
  varDefs: string[] = [];
  argList: string[] = [];
  variables: Record<string, unknown> = {};

  add(arg: string | undefined, type: string | undefined, name: string, value: unknown) {
    if (!arg || !type || value === undefined) return;
    this.varDefs.push(`$${name}: ${type}`);
    this.argList.push(`${arg}: $${name}`);
    this.variables[name] = value;
  }

  document(rootField: string, selections: string) {
    const defs = this.varDefs.length > 0 ? `(${this.varDefs.join(', ')})` : '';
    const args = this.argList.length > 0 ? `(${this.argList.join(', ')})` : '';
    return `query ApertureList${defs} { ${rootField}${args} { ${selections} } }`;
  }
}

/**
 * Builds the list query for one collection from its derived column model,
 * passing paging/filter/search through typed variables (types come from the
 * introspected arg types, so the document always matches the endpoint).
 *
 * Envelope collections (live Hippo, #15) select `{ items { … } total }` and
 * pass filters as the generic `[{field, value}]` list (AND). An active search
 * term routes to the attached search twin instead. Composed twins (Mosaic
 * issue #157) return the same page envelope and take the same filter
 * arguments, so search runs WITHIN the filtered cohort with an honest
 * `total`; legacy bare-list twins take no filters, so there the term
 * replaces them (the old flat search-over-filters semantics).
 */
/** The generic `[{field, value, op?}]` filter entries for a list request. */
function listFilterEntries(options: ListOptions): Record<string, unknown>[] {
  return [
    ...Object.entries(options.filters ?? {}).map(([field, value]) => ({ field, value })),
    ...(options.conditions ?? []).map((c) =>
      c.op && c.op !== 'EQ'
        ? { field: c.field, value: c.value, op: c.op }
        : { field: c.field, value: c.value },
    ),
  ];
}

export function buildListQuery(collection: CollectionModel, options: ListOptions): BuiltListQuery {
  const builder = new QueryBuilder();
  const offset = (options.page - 1) * options.pageSize;

  if (collection.pageShape === 'envelope' && options.search && collection.search) {
    const twin = collection.search;
    builder.add(twin.argName, twin.argType, 'q', options.search);
    builder.add(twin.limitArg, twin.limitArgType, 'limit', options.pageSize);
    builder.add(twin.offsetArg, twin.offsetArgType, 'offset', offset);
    // Composed twins (Mosaic issue #157) accept the list surface's filter
    // arguments — search within a filtered cohort instead of replacing
    // the filters. Legacy bare-list twins take none; there the term
    // replaces the filters (the old flat semantics).
    if (twin.filterArg) {
      const twinFilterEntries = listFilterEntries(options);
      builder.add(
        twin.filterArg,
        twin.filterArgType,
        'filters',
        twinFilterEntries.length > 0 ? twinFilterEntries : undefined,
      );
      builder.add(
        twin.filterModeArg,
        twin.filterModeArgType,
        'filterMode',
        twinFilterEntries.length > 0 ? (options.filterMode ?? 'AND') : undefined,
      );
    }
    builder.add(twin.orderByArg, twin.orderByArgType, 'orderBy', options.orderBy?.field);
    builder.add(
      twin.orderDirArg,
      twin.orderDirArgType,
      'orderDir',
      options.orderBy?.field ? (options.orderBy.dir ?? 'ASC') : undefined,
    );
    const rows = rowSelection(collection, options);
    return {
      document: builder.document(
        twin.field,
        twin.envelope ? `items { ${rows} } total` : rows,
      ),
      variables: builder.variables,
      rootField: twin.field,
      envelope: twin.envelope ?? false,
    };
  }

  builder.add(collection.args.limit, collection.argTypes.limit, 'limit', options.pageSize);
  builder.add(collection.args.offset, collection.argTypes.offset, 'offset', offset);

  const filterEntries = listFilterEntries(options);
  const hasFilters = filterEntries.length > 0;
  if (collection.filterShape === 'filterList') {
    builder.add(
      collection.args.filter,
      collection.argTypes.filter,
      'filters',
      hasFilters ? filterEntries : undefined,
    );
    builder.add(
      collection.filterModeArg?.name,
      collection.filterModeArg?.type,
      'filterMode',
      hasFilters ? (options.filterMode ?? 'AND') : undefined,
    );
  } else {
    // The inputObject (stub) shape carries equality filters only; typed
    // conditions have no representation there and are never sent.
    const hasEqualityFilters = options.filters && Object.keys(options.filters).length > 0;
    builder.add(
      collection.args.filter,
      collection.argTypes.filter,
      'filter',
      hasEqualityFilters ? options.filters : undefined,
    );
  }
  builder.add(collection.args.where, collection.argTypes.where, 'where', options.where);
  builder.add(collection.args.search, collection.argTypes.search, 'search', options.search || undefined);
  builder.add(collection.args.orderBy, collection.argTypes.orderBy, 'orderBy', options.orderBy?.field);
  builder.add(
    collection.args.orderDir,
    collection.argTypes.orderDir,
    'orderDir',
    options.orderBy?.field ? (options.orderBy.dir ?? 'ASC') : undefined,
  );

  const envelope = collection.pageShape === 'envelope';
  const selections = envelope
    ? `items { ${rowSelection(collection, options)} } total`
    : rowSelection(collection, options);
  return {
    document: builder.document(collection.id, selections),
    variables: builder.variables,
    rootField: collection.id,
    envelope,
  };
}

/** Builds the single-entity query along the collection's detail path. */
export function buildDetailQuery(collection: CollectionModel, id: string): BuiltQuery | null {
  const detail = collection.detail;
  if (!detail) return null;
  const selections = selectionSet(collection.detailColumns);
  if (detail.kind === 'field') {
    return {
      document: `query ApertureDetail($id: ${detail.argType}) { ${detail.field}(${detail.argName}: $id) { ${selections} } }`,
      variables: { id },
    };
  }
  // Filter fallback: id-equality on the list field, first row wins.
  const varDefs = [`$filter: ${collection.argTypes.filter}`];
  const args = [`${collection.args.filter}: $filter`];
  const variables: Record<string, unknown> = { filter: { [detail.filterField]: id } };
  if (collection.args.limit && collection.argTypes.limit) {
    varDefs.push(`$limit: ${collection.argTypes.limit}`);
    args.push(`${collection.args.limit}: $limit`);
    variables['limit'] = 1;
  }
  return {
    document: `query ApertureDetail(${varDefs.join(', ')}) { ${collection.id}(${args.join(', ')}) { ${selections} } }`,
    variables,
  };
}

/** Builds the create mutation for a collection's derived write path. */
export function buildCreateMutation(
  collection: CollectionModel,
  values: Record<string, unknown>,
): BuiltQuery | null {
  const create = collection.write.create;
  if (!create) return null;
  const idSelection = collection.idColumn ?? collection.columns[0].field;
  return {
    document: `mutation ApertureCreate($input: ${create.inputArgType}) { ${create.field}(${create.inputArgName}: $input) { ${idSelection} } }`,
    variables: { input: values },
  };
}

/** Builds the partial-merge update mutation (only the provided fields travel). */
export function buildUpdateMutation(
  collection: CollectionModel,
  id: string,
  values: Record<string, unknown>,
): BuiltQuery | null {
  const update = collection.write.update;
  if (!update) return null;
  const idSelection = collection.idColumn ?? collection.columns[0].field;
  return {
    document:
      `mutation ApertureUpdate($id: ${update.idArgType}, $input: ${update.inputArgType}) ` +
      `{ ${update.field}(${update.idArgName}: $id, ${update.inputArgName}: $input) { ${idSelection} } }`,
    variables: { id, input: values },
  };
}

/** Builds the availability-transition mutation (W4.4): id + isAvailable, optional reason. */
export function buildSetAvailabilityMutation(
  collection: CollectionModel,
  id: string,
  isAvailable: boolean,
  reason?: string,
): BuiltQuery | null {
  const lifecycle = collection.lifecycle.setAvailability;
  if (!lifecycle) return null;
  const varDefs = [`$id: ${lifecycle.idArgType}`, '$isAvailable: Boolean!'];
  const args = [`${lifecycle.idArgName}: $id`, `${lifecycle.availabilityArgName}: $isAvailable`];
  const variables: Record<string, unknown> = { id, isAvailable };
  if (lifecycle.reasonArgName && reason) {
    varDefs.push('$reason: String');
    args.push(`${lifecycle.reasonArgName}: $reason`);
    variables.reason = reason;
  }
  return {
    document: `mutation ApertureSetAvailability(${varDefs.join(', ')}) { ${lifecycle.field}(${args.join(', ')}) { entityId isAvailable } }`,
    variables,
  };
}

/** Builds the supersede mutation (W4.4): id + replacementId, optional reason. */
export function buildSupersedeMutation(
  collection: CollectionModel,
  id: string,
  replacementId: string,
  reason?: string,
): BuiltQuery | null {
  const lifecycle = collection.lifecycle.supersede;
  if (!lifecycle) return null;
  const varDefs = [`$id: ${lifecycle.idArgType}`, `$replacementId: ${lifecycle.replacementArgType}`];
  const args = [`${lifecycle.idArgName}: $id`, `${lifecycle.replacementArgName}: $replacementId`];
  const variables: Record<string, unknown> = { id, replacementId };
  if (lifecycle.reasonArgName && reason) {
    varDefs.push('$reason: String');
    args.push(`${lifecycle.reasonArgName}: $reason`);
    variables.reason = reason;
  }
  return {
    document: `mutation ApertureSupersede(${varDefs.join(', ')}) { ${lifecycle.field}(${args.join(', ')}) { entityId supersededBy } }`,
    variables,
  };
}

/**
 * Read `hippoSchema` when the endpoint advertises it.
 *
 * Gated on the same presence check `deriveCapabilities` uses for
 * `schemaIntrospection`, so an endpoint that does not expose the field is never asked for
 * it — a GraphQL validation error on an unknown field would be a needless round trip and a
 * confusing log line.
 */
async function fetchSlotEnrichment(
  client: ScopedDataClient,
  schema: IntrospectionSchema,
): Promise<SlotEnrichment | undefined> {
  const queryType = findType(schema, schema.queryType.name);
  if (!(queryType?.fields ?? []).some((f) => f.name === 'hippoSchema')) return undefined;
  try {
    const result = await client.query<SlotEnrichmentData>(HIPPO_SCHEMA_QUERY);
    if (result.error) return undefined;
    return indexSlotEnrichment(result.data);
  } catch {
    // Enrichment is an improvement, never a requirement. A throw here would take down an
    // endpoint that introspects perfectly well.
    return undefined;
  }
}

export async function connectHippoSource(client: ScopedDataClient): Promise<HippoSource> {
  const result = await client.query<IntrospectionData>(INTROSPECTION_QUERY);
  if (result.error || !result.data?.__schema) {
    throw new Error(
      `Could not introspect the endpoint: ${result.error?.message ?? 'no __schema in response'}`,
    );
  }

  const schema = result.data.__schema;

  // Per-slot enrichment, when the endpoint advertises it. Standard `__schema` carries a
  // description on each TYPE but null on every FIELD, so the prose a curator wrote about a
  // slot — the thing that lets a user's own vocabulary find a field whose name shares none
  // of their words — is only reachable here.
  //
  // Issued once, at connect. A failure is NOT fatal: an endpoint without `hippoSchema` has
  // to keep working exactly as it did, so this degrades to `undefined` and every consumer
  // treats the enrichment as optional (ADR-0029).
  const enrichment = await fetchSlotEnrichment(client, schema);

  const collections = deriveCollections(schema, enrichment);
  const capabilities = deriveCapabilities(schema, collections);
  const history = deriveHistory(schema);
  const batch = deriveBatchModel(schema);
  const conversation = deriveConversationModel(schema);
  const neighbors = deriveNeighborsModel(schema);

  const collectionFor = (collectionId: string): CollectionModel => {
    const collection = collections.find((c) => c.id === collectionId);
    if (!collection) throw new Error(`Unknown collection “${collectionId}”`);
    return collection;
  };

  return {
    capabilities,
    collections,
    history,
    batch,
    conversation,
    neighbors,

    async getNeighbors(id) {
      if (!neighbors) {
        throw new Error('The endpoint does not advertise a `neighbors` traversal');
      }
      const built = buildNeighborsQuery(neighbors, id);
      const result = await client.query<Record<string, unknown>>(built.document, built.variables);
      if (result.error || result.data == null) {
        throw new Error(
          `Could not load the neighborhood: ${result.error?.message ?? 'empty response'}`,
        );
      }
      return normalizeNeighborhood(neighbors, result.data[neighbors.field]);
    },

    async converse(request, signal) {
      if (!conversation) {
        throw new Error('The endpoint does not advertise a conversational query surface');
      }
      const built = buildConverseMutation(conversation, request);
      const result = await client.mutate<Record<string, unknown>>(
        built.document,
        built.variables,
        signal ? { signal } : undefined,
      );
      if (result.error || result.data == null) {
        throw new Error(
          `The conversational turn failed: ${result.error?.message ?? 'empty response'}`,
        );
      }
      return normalizeConverseResult(conversation, result.data[conversation.field]);
    },

    async runBatch(operations, dryRun) {
      if (!batch) throw new Error('The endpoint does not advertise a batch unit-of-work');
      if (operations.length === 0) throw new Error('Nothing staged to submit');
      const built = buildIngestBatch(batch, operations, dryRun);
      const batchResult = await client.mutate<Record<string, unknown>>(
        built.document,
        built.variables,
      );
      if (batchResult.error || batchResult.data == null) {
        // Commit-time constraint violations (FK, NOT NULL) surface here as
        // top-level GraphQL errors — the whole batch rolled back atomically.
        throw new Error(
          `Batch ${dryRun ? 'validation' : 'commit'} failed: ${batchResult.error?.message ?? 'empty response'}`,
        );
      }
      return normalizeBatchResult(batchResult.data[batch.field], built.clientIds);
    },

    async listEntities(collectionId, options) {
      const collection = collectionFor(collectionId);
      const { page, pageSize } = options;
      if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid page ${page}`);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
        throw new Error(`Invalid page size ${pageSize}`);
      }

      const { document, variables, rootField, envelope } = buildListQuery(collection, options);
      const listResult = await client.query<Record<string, unknown>>(document, variables, {
        fresh: options.fresh,
      });
      if (listResult.error || listResult.data == null) {
        throw new Error(
          `Could not list ${collection.label}: ${listResult.error?.message ?? 'empty response'}`,
        );
      }
      if (envelope) {
        const envelopePage = (listResult.data[rootField] ?? {}) as {
          items?: Record<string, unknown>[];
          total?: number;
        };
        const rows = envelopePage.items ?? [];
        const total = envelopePage.total;
        return {
          rows,
          total,
          mayHaveMore:
            total != null
              ? (page - 1) * pageSize + rows.length < total
              : rows.length === pageSize,
        };
      }
      // Bare lists carry no total — a full page means a next page may exist.
      const rows = (listResult.data[rootField] ?? []) as Record<string, unknown>[];
      return { rows, mayHaveMore: rows.length === pageSize };
    },

    async getEntity(collectionId, id, fresh) {
      const collection = collectionFor(collectionId);
      const built = buildDetailQuery(collection, id);
      if (!built) {
        throw new Error(`${collection.label} does not support single-entity fetch`);
      }
      const detailResult = await client.query<Record<string, unknown>>(
        built.document,
        built.variables,
        { fresh },
      );
      if (detailResult.error || detailResult.data == null) {
        throw new Error(
          `Could not load ${collection.typeName} “${id}”: ${detailResult.error?.message ?? 'empty response'}`,
        );
      }
      const detail = collection.detail!;
      if (detail.kind === 'field') {
        return (detailResult.data[detail.field] ?? null) as Record<string, unknown> | null;
      }
      const rows = (detailResult.data[collection.id] ?? []) as Record<string, unknown>[];
      return rows[0] ?? null;
    },

    async createEntity(collectionId, values) {
      const collection = collectionFor(collectionId);
      const built = buildCreateMutation(collection, values);
      if (!built) throw new Error(`${collection.label} does not support create`);
      const createResult = await client.mutate<Record<string, unknown>>(
        built.document,
        built.variables,
      );
      if (createResult.error || createResult.data == null) {
        throw new Error(
          `Could not create ${collection.typeName}: ${createResult.error?.message ?? 'empty response'}`,
        );
      }
      const entity = createResult.data[collection.write.create!.field] as
        | Record<string, unknown>
        | null;
      const id = entity?.[collection.idColumn ?? ''];
      return id == null ? null : String(id);
    },

    async updateEntity(collectionId, id, values) {
      const collection = collectionFor(collectionId);
      const built = buildUpdateMutation(collection, id, values);
      if (!built) throw new Error(`${collection.label} does not support update`);
      const updateResult = await client.mutate<Record<string, unknown>>(
        built.document,
        built.variables,
      );
      if (updateResult.error) {
        throw new Error(
          `Could not update ${collection.typeName} “${id}”: ${updateResult.error.message}`,
        );
      }
    },

    async setAvailability(collectionId, id, isAvailable, reason) {
      const collection = collectionFor(collectionId);
      const built = buildSetAvailabilityMutation(collection, id, isAvailable, reason);
      if (!built) throw new Error(`${collection.label} does not support availability transitions`);
      const result = await client.mutate<Record<string, unknown>>(
        built.document,
        built.variables,
      );
      if (result.error) {
        throw new Error(
          `Could not update availability for ${collection.typeName} “${id}”: ${result.error.message}`,
        );
      }
    },

    async supersede(collectionId, id, replacementId, reason) {
      const collection = collectionFor(collectionId);
      const built = buildSupersedeMutation(collection, id, replacementId, reason);
      if (!built) throw new Error(`${collection.label} does not support supersede`);
      const result = await client.mutate<Record<string, unknown>>(
        built.document,
        built.variables,
      );
      if (result.error) {
        throw new Error(
          `Could not supersede ${collection.typeName} “${id}”: ${result.error.message}`,
        );
      }
    },

    async getHistory(id) {
      if (!history) return [];
      const document = `query ApertureHistory($id: ${history.argType}) { ${history.field}(${history.argName}: $id) { ${selectionSet(history.columns)} } }`;
      const historyResult = await client.query<Record<string, unknown>>(document, { id });
      if (historyResult.error || historyResult.data == null) {
        throw new Error(`Could not load history: ${historyResult.error?.message ?? 'empty response'}`);
      }
      return (historyResult.data[history.field] ?? []) as HistoryEntry[];
    },

    async getFacetCounts(collectionId, fields, filters) {
      const collection = collectionFor(collectionId);
      const fc = collection.facetCounts;
      if (!fc || fields.length === 0) return {};

      // One request for every visible facet, via an aliased field per facet
      // (f0, f1, …) rather than N round-trips. Each alias counts its own
      // field EXCLUDING that field's own current selection, so a facet's
      // other options stay visible after picking one; other active filters
      // still narrow it.
      const varDefs: string[] = [];
      const variables: Record<string, unknown> = {};
      const selections = fields.map((slot, i) => {
        const alias = `f${i}`;
        const args = [`${fc.fieldArgName}: ${JSON.stringify(slot)}`];
        if (fc.filtersArgName && fc.filtersArgType) {
          const entries = Object.entries(filters)
            .filter(([field]) => field !== slot)
            .map(([field, value]) => ({ field, value }));
          if (entries.length > 0) {
            const varName = `${alias}Filters`;
            varDefs.push(`$${varName}: ${fc.filtersArgType}`);
            variables[varName] = entries;
            args.push(`${fc.filtersArgName}: $${varName}`);
            if (fc.filterModeArgName) args.push(`${fc.filterModeArgName}: AND`);
          }
        }
        return `${alias}: ${fc.field}(${args.join(', ')}) { value count }`;
      });
      const document = `query ApertureFacetCounts${varDefs.length > 0 ? `(${varDefs.join(', ')})` : ''} { ${selections.join(' ')} }`;
      const result = await client.query<Record<string, { value: unknown; count: number }[]>>(
        document,
        variables,
      );
      if (result.error || result.data == null) {
        throw new Error(`Could not load facet counts: ${result.error?.message ?? 'empty response'}`);
      }
      const byField: Record<string, { value: unknown; count: number }[]> = {};
      fields.forEach((slot, i) => {
        byField[slot] = result.data![`f${i}`] ?? [];
      });
      return byField;
    },

    async getFieldRange(collectionId, fields, filters) {
      const collection = collectionFor(collectionId);
      const fr = collection.fieldRange;
      if (!fr || fields.length === 0) return {};

      // One request for every visible range facet, via an aliased field per
      // facet (f0, f1, …) rather than N round-trips — same shape as
      // getFacetCounts. Unlike facetCounts, a range facet's own value isn't
      // carried in `filters` (it lives in `conditions`/the URL's `ranges`
      // state instead), so there's nothing of its own to exclude here.
      const varDefs: string[] = [];
      const variables: Record<string, unknown> = {};
      const selections = fields.map((slot, i) => {
        const alias = `f${i}`;
        const args = [`${fr.fieldArgName}: ${JSON.stringify(slot)}`];
        if (fr.filtersArgName && fr.filtersArgType) {
          const entries = Object.entries(filters).map(([field, value]) => ({ field, value }));
          if (entries.length > 0) {
            const varName = `${alias}Filters`;
            varDefs.push(`$${varName}: ${fr.filtersArgType}`);
            variables[varName] = entries;
            args.push(`${fr.filtersArgName}: $${varName}`);
            if (fr.filterModeArgName) args.push(`${fr.filterModeArgName}: AND`);
          }
        }
        return `${alias}: ${fr.field}(${args.join(', ')}) { min max }`;
      });
      const document = `query ApertureFieldRange${varDefs.length > 0 ? `(${varDefs.join(', ')})` : ''} { ${selections.join(' ')} }`;
      const result = await client.query<Record<string, { min: unknown; max: unknown }>>(
        document,
        variables,
      );
      if (result.error || result.data == null) {
        throw new Error(`Could not load field range: ${result.error?.message ?? 'empty response'}`);
      }
      const byField: Record<string, { min: unknown; max: unknown }> = {};
      fields.forEach((slot, i) => {
        byField[slot] = result.data![`f${i}`] ?? { min: null, max: null };
      });
      return byField;
    },
  };
}
