import type {
  IntrospectionField,
  IntrospectionInputValue,
  IntrospectionSchema,
  IntrospectionType,
  SlotEnrichment,
  SlotInfo,
} from './introspection';
import { findType, isListType, namedType, typeRefToSDL } from './introspection';
import type { Capabilities } from './capabilities';
import { deriveBatchModel } from './batch';
import { deriveConversationModel } from './conversation';
import { deriveNeighborsModel } from './neighbors';

/**
 * The schema-derived binding model (the novel bet, `prior-art.md`): browsable
 * collections and their column models derive at runtime from endpoint
 * introspection — no build-time codegen, no hand-written per-type UI. Cell
 * renderers key off `SlotKind` (R3.2).
 */

export type SlotKind =
  | 'id'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'ref'
  | 'refList';

export interface ColumnModel {
  /** GraphQL field name on the entity type. */
  field: string;
  /** Humanized header label. */
  label: string;
  kind: SlotKind;
  /** For enum columns: the advertised values (feeds Phase-1 facets). */
  enumValues?: readonly string[];
  /** For ref/refList columns: the target entity type + its id-ish field. */
  targetType?: string;
  targetIdField?: string;
  /**
   * The `orderBy` enum member that sorts by this column, when the endpoint's
   * `<Class>OrderField` enum advertises one (Mosaic ADR-0007). Absent →
   * unsortable, regardless of the collection-level sort capability.
   */
  orderField?: string;

  // ── Slot enrichment (`hippoSchema`) ──────────────────────────────────────
  // All optional, all absent on an endpoint that does not advertise it. Nothing
  // downstream may require them: the table, facets and detail view predate this
  // and must keep working unchanged.

  /**
   * The schema author's own description of the slot.
   *
   * NOT available from `__schema` — its generated object types carry a description on the
   * TYPE and `null` on every field. This is the prose that lets a user's own vocabulary
   * find a field whose name shares none of its words ("head injuries" → `history_of_rhi`).
   */
  description?: string;
  /** The raw LinkML range — `integer`, `string`, `CohortEnum`, `Workflow`. */
  range?: string;
  /** Mosaic's own classification: scalar | enum | reference | structured. */
  slotKind?: string;
  /** Whether a value must be present on every record. */
  required?: boolean;
  /** For enum slots, the name of the vocabulary. */
  enumName?: string;
  /** The LinkML slot name (snake_case), which differs from `field` (camelCase). */
  slot?: string;
}

/**
 * An equality or range facet derived from the collection's filter surface
 * (R3.3): enum → checklist, boolean → true/false, ref-id → id equality,
 * numeric/date → a min/max range (issue #61, gated on a genuine `FieldRange`
 * field — ADR-0029). Per-value counts are a separate overlay (issue #20).
 */
export interface FacetModel {
  /** The filter input field name (what the server filters on). */
  field: string;
  label: string;
  kind: 'enum' | 'boolean' | 'ref' | 'number-range' | 'date-range';
  /** For enum facets: the advertised values. */
  options?: readonly string[];
}

/**
 * A genuine `<collection>FacetCounts(field: String!) -> [{value count}]`
 * Query field (Mosaic ADR-0007/X1, issue #20), when advertised — per-value
 * counts for an equality facet under the collection's current filters.
 */
export interface FacetCountsModel {
  /** The Query field, e.g. `biosamplesFacetCounts`. */
  field: string;
  /** The `field: String!` arg naming which facet to count (the slot name). */
  fieldArgName: string;
  fieldArgType: string;
  /** The flat `filters:`/`filterMode:` args, when advertised beside it. */
  filtersArgName?: string;
  filtersArgType?: string;
  filterModeArgName?: string;
  filterModeArgType?: string;
}

/**
 * A genuine `<collection>FieldRange(field: String!) -> {min max}` Query
 * field (Mosaic ADR-0007/X1, issue #61), when advertised — the advertised
 * min/max bounds for a numeric/date range facet under the collection's
 * current filters. Same arg shape as `FacetCountsModel`, mirrored.
 */
export interface FieldRangeModel {
  /** The Query field, e.g. `biosamplesFieldRange`. */
  field: string;
  /** The `field: String!` arg naming which facet to bound (the slot name). */
  fieldArgName: string;
  fieldArgType: string;
  /** The flat `filters:`/`filterMode:` args, when advertised beside it. */
  filtersArgName?: string;
  filtersArgType?: string;
  filterModeArgName?: string;
  filterModeArgType?: string;
}

/** How a single entity can be fetched for the detail view (R3.7). */
export type DetailPath =
  | { kind: 'field'; field: string; argName: string; argType: string }
  | { kind: 'filter'; filterField: string };

/**
 * A search twin: a Query field for the same entity type taking a required
 * search string (e.g. `searchBooks(q: String!)`). It attaches to the base
 * collection as its search capability rather than deriving as a standalone
 * collection — its required arg is only satisfiable when a search term is
 * active. Two shapes exist: the legacy bare list, and the composed page
 * envelope (Mosaic issue #157) which returns the same `{ items total }`
 * Page as the base collection and accepts its filter arguments.
 */
export interface SearchTwinModel {
  field: string;
  argName: string;
  argType: string;
  limitArg?: string;
  limitArgType?: string;
  offsetArg?: string;
  offsetArgType?: string;
  /** True when the twin returns the `{ items total }` Page envelope (#157). */
  envelope?: boolean;
  /** The twin's flat filter-list arg, when it composes with filters (#157). */
  filterArg?: string;
  filterArgType?: string;
  filterModeArg?: string;
  filterModeArgType?: string;
  /** The twin's `orderBy`/`orderDir` args (Mosaic ADR-0007), when advertised. */
  orderByArg?: string;
  orderByArgType?: string;
  orderDirArg?: string;
  orderDirArgType?: string;
}

export interface CollectionModel {
  /** The Query list field, e.g. `subjects` — doubles as the URL collection id. */
  id: string;
  /** Humanized nav/table label, e.g. "Subjects". */
  label: string;
  /** The entity type name, e.g. `Subject`. */
  typeName: string;
  /**
   * The schema author's description of the entity type.
   *
   * `__schema` has always returned this and derivation has always dropped it. Unlike the
   * per-FIELD description (which `__schema` reports as null and only `hippoSchema`
   * carries), this one needs no enrichment query.
   */
  description?: string;
  /** The curated table columns (budgeted). */
  columns: ColumnModel[];
  /** The full derivable field set, for the detail view. */
  detailColumns: ColumnModel[];
  /** The field identifying an entity in links/detail (the first id-ish column). */
  idColumn?: string;
  /**
   * How the list field pages (live Hippo shape, #15): 'envelope' = an object
   * page `{ items: [T!]! total: Int! }`; 'list' = a bare list of T (the stub
   * shape, kept as the fallback).
   */
  pageShape: 'envelope' | 'list';
  /**
   * How equality filters travel: 'inputObject' = a per-type filter input
   * (stub shape); 'filterList' = the generic `[FilterInput!]` + FilterMode
   * pair (live Hippo shape).
   */
  filterShape?: 'inputObject' | 'filterList';
  /** For 'filterList': the AND/OR combinator arg, when advertised. */
  filterModeArg?: { name: string; type: string };
  /** The attached search twin, when the endpoint advertises one. */
  search?: SearchTwinModel;
  /** Introspected arg names, present only when the endpoint advertises them. */
  args: {
    limit?: string;
    offset?: string;
    filter?: string;
    search?: string;
    orderBy?: string;
    /** The direction arg beside `orderBy` (Mosaic ADR-0007 `orderDir`), when advertised. */
    orderDir?: string;
    /** Typed per-class filter input (Mosaic ADR-0006 inc. 2), when advertised. */
    where?: string;
  };
  /** SDL types for the advertised args (for variable definitions). */
  argTypes: Partial<
    Record<'limit' | 'offset' | 'filter' | 'search' | 'where' | 'orderBy' | 'orderDir', string>
  >;
  /** Equality facets the endpoint's filter input advertises. */
  facets: FacetModel[];
  /** Per-value facet counts, when the endpoint advertises a genuine field (issue #20). */
  facetCounts?: FacetCountsModel;
  /** Advertised min/max bounds for range facets, when genuinely advertised (issue #61). */
  fieldRange?: FieldRangeModel;
  /** All non-combinator fields of the filter input (equality-filterable). */
  filterFields: string[];
  /**
   * The typed `where:` input's shape, when the endpoint advertises one
   * (Mosaic ADR-0006 increment 2+). Keyed by the input's own field name —
   * camelCase, the GraphQL spelling, not the LinkML slot.
   *
   * Derived rather than assumed because the three field *shapes* compile
   * differently and are told apart only by their input type:
   *
   * - `ops` — a `<Scalar>FilterOps` object (`{eq, neq, in, gt, …}`);
   * - `nested` — another `<Type>Filter`, which a to-one reference takes
   *   directly (`SampleFilter.donor: DonorFilter`);
   * - `quantifiers` — a `<Type>EdgeQuantifiers` (`{some, none}`), which a
   *   to-many or `inverse:`-declared edge takes (ADR-0006 M5a/M5b).
   *
   * Absent → the endpoint predates the typed contract and the planner keeps
   * compiling to the flat `filters:` list.
   */
  whereFields?: Record<string, WhereField>;
  /** How to fetch one entity, when the endpoint offers a way (else detail gates off). */
  detail?: DetailPath;
  /** Create/update mutation paths + derived forms; absent members gate the write UI off. */
  write: WriteModel;
  /** Availability/supersede mutation paths (W4.4); absent members gate those affordances off. */
  lifecycle: LifecycleModel;
}

/** One field of a typed `<Type>Filter` input, classified by how it compiles. */
export interface WhereField {
  /** The input type's own field name (camelCase). */
  field: string;
  kind: 'ops' | 'nested' | 'quantifiers';
  /** The named input type — `StringFilterOps`, `DonorFilter`, `SampleEdgeQuantifiers`. */
  inputType: string;
  /** For `ops`: the operator members the endpoint actually advertises for it. */
  ops?: string[];
}

/** Combinators are structure, not fields — the compiler emits them itself. */
const WHERE_COMBINATORS = new Set(['and', 'or', 'not']);

/**
 * Classify every field of a typed filter input (Mosaic ADR-0006).
 *
 * The classification is read off the input types themselves rather than
 * matched by name: a to-one reference and a to-many edge are both named after
 * their slot, and only the type distinguishes `DonorFilter` (nested) from
 * `SampleEdgeQuantifiers` (quantified). Name-matching would compile a
 * relationship predicate into the wrong shape and fail GraphQL validation.
 */
function deriveWhereFields(
  schema: IntrospectionSchema,
  whereTypeName: string | undefined,
): Record<string, WhereField> | undefined {
  const input = whereTypeName ? findType(schema, whereTypeName) : undefined;
  if (input?.kind !== 'INPUT_OBJECT') return undefined;

  const fields: Record<string, WhereField> = {};
  for (const field of input.inputFields ?? []) {
    if (WHERE_COMBINATORS.has(field.name)) continue;
    const named = namedType(field.type);
    const typeName = named.name;
    if (!typeName) continue;
    const target = findType(schema, typeName);
    if (target?.kind !== 'INPUT_OBJECT') continue;

    const members = (target.inputFields ?? []).map((f) => f.name);
    const isQuantifier =
      members.length > 0 && members.every((m) => m === 'some' || m === 'none');
    // A nested filter carries combinators; an ops object never does. That is a
    // structural test, so it holds for any naming convention.
    const isNested = members.some((m) => WHERE_COMBINATORS.has(m));

    fields[field.name] = {
      field: field.name,
      kind: isQuantifier ? 'quantifiers' : isNested ? 'nested' : 'ops',
      inputType: typeName,
      ops: isQuantifier || isNested ? undefined : members,
    };
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** Derived from a Query `entityHistory`-style field, when advertised (R3.7). */
export interface HistoryModel {
  field: string;
  argName: string;
  argType: string;
  /** Scalar columns of the history row type. */
  columns: ColumnModel[];
}

/**
 * A form field derived from a mutation input type (W4.1). The whole
 * FormModel is plain serializable data — the schema/UI-schema seed for
 * config-as-data forms (ADR-0003/0004).
 */
export interface FormFieldModel {
  /** Input-object field name (what the mutation receives). */
  name: string;
  label: string;
  widget: 'text' | 'number' | 'checkbox' | 'select' | 'date' | 'ref';
  /** NON_NULL input field → required (client pre-validation; server authoritative). */
  required: boolean;
  /** For select widgets: the advertised enum values. */
  options?: readonly string[];
  /** For ref widgets: the target entity type (picker searches its collection). */
  targetType?: string;
}

export interface FormModel {
  inputTypeName: string;
  fields: FormFieldModel[];
}

/** How a collection's entities are created/updated, when the endpoint offers it (W4.3). */
export interface WriteModel {
  create?: {
    field: string;
    inputArgName: string;
    inputArgType: string;
    form: FormModel;
  };
  update?: {
    field: string;
    idArgName: string;
    idArgType: string;
    inputArgName: string;
    inputArgType: string;
    form: FormModel;
  };
}

/**
 * Availability transitions and supersession, when the endpoint offers them
 * (W4.4) — Mosaic's no-hard-delete lifecycle. Absent members gate the
 * corresponding affordance off (ADR-0029).
 */
export interface LifecycleModel {
  setAvailability?: {
    field: string;
    idArgName: string;
    idArgType: string;
    availabilityArgName: string;
    /** Present only when the mutation advertises an optional reason arg. */
    reasonArgName?: string;
  };
  supersede?: {
    field: string;
    idArgName: string;
    idArgType: string;
    replacementArgName: string;
    replacementArgType: string;
    /** Present only when the mutation advertises an optional reason arg. */
    reasonArgName?: string;
  };
}

/** Table column budget for the derived default view (curation is later config). */
const MAX_COLUMNS = 8;
/** Field budget for the detail view (all derivable fields, within reason). */
const MAX_DETAIL_COLUMNS = 50;

const DATE_SCALARS = new Set(['Date', 'DateTime', 'Datetime', 'Time', 'XSDDate', 'XSDDateTime']);
const NUMBER_SCALARS = new Set(['Int', 'Float', 'BigInt', 'Decimal', 'Double']);
const ID_FIELD_NAMES = new Set(['id', 'identifier', 'external_id', 'externalId']);

export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function argNamed(field: IntrospectionField, ...names: string[]) {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return field.args.find((a) => lower.has(a.name.toLowerCase()));
}

/** The field used to identify related entities in ref cells (prefer id-ish names). */
function idishField(type: IntrospectionType): string | undefined {
  const scalarFields = (type.fields ?? []).filter((f) => {
    const named = namedType(f.type);
    return named.kind === 'SCALAR' && !isListType(f.type);
  });
  const byName = scalarFields.find((f) => ID_FIELD_NAMES.has(f.name));
  const byKind = scalarFields.find((f) => namedType(f.type).name === 'ID');
  return (byName ?? byKind ?? scalarFields[0])?.name;
}

function columnFor(
  field: IntrospectionField,
  schema: IntrospectionSchema,
): ColumnModel | undefined {
  const named = namedType(field.type);
  const list = isListType(field.type);
  const base = { field: field.name, label: humanize(field.name) };

  if (named.kind === 'SCALAR') {
    if (list) return undefined; // multivalued scalars degrade to hidden for Phase 0
    const scalar = named.name ?? '';
    if (scalar === 'ID' || ID_FIELD_NAMES.has(field.name)) return { ...base, kind: 'id' };
    if (NUMBER_SCALARS.has(scalar)) return { ...base, kind: 'number' };
    if (scalar === 'Boolean') return { ...base, kind: 'boolean' };
    if (DATE_SCALARS.has(scalar)) return { ...base, kind: 'date' };
    return { ...base, kind: 'text' };
  }

  if (named.kind === 'ENUM') {
    if (list) return undefined;
    const enumType = findType(schema, named.name);
    return { ...base, kind: 'enum', enumValues: enumType?.enumValues?.map((v) => v.name) ?? [] };
  }

  if (named.kind === 'OBJECT') {
    const target = findType(schema, named.name);
    if (!target) return undefined;
    const targetIdField = idishField(target);
    if (!targetIdField) return undefined;
    return {
      ...base,
      kind: list ? 'refList' : 'ref',
      targetType: target.name,
      targetIdField,
    };
  }

  return undefined;
}

/** Combinator/meta input fields that are not equality facets. */
const COMBINATOR_FIELDS = new Set(['and', 'or', 'not', 'AND', 'OR', 'NOT']);

/**
 * Hippo's generic FilterInput takes LinkML slot names, while the GraphQL
 * output fields are their camelCase renames — filtering by `inPrint` silently
 * matches nothing; `in_print` works (verified against hippo v0.10.3).
 */
export function slotName(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * For 'filterList' collections there is no per-type filter input to derive
 * from — the filterable surface is the entity's own columns (#15): enum →
 * single-select facet, boolean → true/false, resolved refs → id equality.
 * FK-rename scalars (e.g. `authorId` beside `author`) are excluded: the
 * filter slot is the relationship name, not the rename.
 */
function deriveColumnFacets(columns: ColumnModel[]): FacetModel[] {
  const facets: FacetModel[] = [];
  for (const column of columns) {
    if (column.kind === 'enum') {
      facets.push({
        field: slotName(column.field),
        label: column.label,
        kind: 'enum',
        options: column.enumValues ?? [],
      });
    } else if (column.kind === 'boolean') {
      facets.push({ field: slotName(column.field), label: column.label, kind: 'boolean' });
    } else if (column.kind === 'ref') {
      facets.push({ field: slotName(column.field), label: column.label, kind: 'ref' });
    }
  }
  return facets;
}

/** The equality-filterable field (slot) names for a 'filterList' collection. */
function deriveColumnFilterFields(columns: ColumnModel[]): string[] {
  const refFields = new Set(columns.filter((c) => c.kind === 'ref').map((c) => c.field));
  return columns
    .filter((c) => c.kind !== 'refList')
    .filter((c) => !(c.kind === 'id' && refFields.has(c.field.replace(/Id$/, ''))))
    .map((c) => slotName(c.field));
}

/**
 * Equality facets derive from the filter input type's own fields (R3.3):
 * whatever the endpoint's filter advertises is facetable — nothing else.
 */
function deriveFacets(
  schema: IntrospectionSchema,
  filterTypeName: string | null,
  columns: ColumnModel[],
): FacetModel[] {
  const filterType = findType(schema, filterTypeName);
  if (filterType?.kind !== 'INPUT_OBJECT') return [];
  const refColumns = new Set(
    columns.filter((c) => c.kind === 'ref' || c.kind === 'id').map((c) => c.field),
  );

  const facets: FacetModel[] = [];
  for (const input of filterType.inputFields ?? []) {
    if (COMBINATOR_FIELDS.has(input.name)) continue;
    const named = namedType(input.type);
    if (named.kind === 'ENUM') {
      const enumType = findType(schema, named.name);
      facets.push({
        field: input.name,
        label: humanize(input.name),
        kind: 'enum',
        options: enumType?.enumValues?.map((v) => v.name) ?? [],
      });
    } else if (named.name === 'Boolean') {
      facets.push({ field: input.name, label: humanize(input.name), kind: 'boolean' });
    } else if (
      (named.name === 'ID' || named.name === 'String') &&
      (refColumns.has(input.name) || /_id$|Id$/.test(input.name))
    ) {
      facets.push({ field: input.name, label: humanize(input.name), kind: 'ref' });
    }
    // Plain text/number inputs are not equality facets (range = Hippo X1).
  }
  return facets;
}

/**
 * A `<collectionId>FacetCounts(field: String!) -> [{value count}]` Query
 * field (Mosaic ADR-0007, issue #20), when genuinely advertised — a name
 * match alone is not a capability (ADR-0029): the return type must actually
 * be a list of an object type carrying `value`/`count`, and the aggregation
 * target must be a required scalar `field` arg.
 */
function deriveFacetCounts(
  schema: IntrospectionSchema,
  queryFields: readonly IntrospectionField[],
  collectionId: string,
): FacetCountsModel | undefined {
  const pattern = new RegExp(`^${collectionId}FacetCounts$`, 'i');
  const field = queryFields.find((f) => pattern.test(f.name));
  if (!field || !isListType(field.type)) return undefined;
  const rowType = findType(schema, namedType(field.type).name);
  if (rowType?.kind !== 'OBJECT') return undefined;
  const rowFields = new Set((rowType.fields ?? []).map((f) => f.name));
  if (!rowFields.has('value') || !rowFields.has('count')) return undefined;

  const fieldArg = field.args.find(
    (a) => a.name === 'field' && namedType(a.type).name === 'String',
  );
  if (!fieldArg) return undefined;

  const filtersArg = field.args.find((a) => a.name === 'filters' && isListType(a.type));
  const filterModeArg = field.args.find((a) => a.name === 'filterMode');

  return {
    field: field.name,
    fieldArgName: fieldArg.name,
    fieldArgType: typeRefToSDL(fieldArg.type),
    filtersArgName: filtersArg?.name,
    filtersArgType: filtersArg && typeRefToSDL(filtersArg.type),
    filterModeArgName: filterModeArg?.name,
    filterModeArgType: filterModeArg && typeRefToSDL(filterModeArg.type),
  };
}

/**
 * A `<collectionId>FieldRange(field: String!) -> {min max}` Query field
 * (Mosaic ADR-0007, issue #61), when genuinely advertised — mirrors
 * `deriveFacetCounts`'s ADR-0029 discipline: the return type must actually
 * be an OBJECT carrying `min`/`max` (a single range, never a list of
 * buckets), and the aggregation target must be a required scalar `field` arg.
 */
function deriveFieldRange(
  schema: IntrospectionSchema,
  queryFields: readonly IntrospectionField[],
  collectionId: string,
): FieldRangeModel | undefined {
  const pattern = new RegExp(`^${collectionId}FieldRange$`, 'i');
  const field = queryFields.find((f) => pattern.test(f.name));
  if (!field || isListType(field.type)) return undefined;
  const rowType = findType(schema, namedType(field.type).name);
  if (rowType?.kind !== 'OBJECT') return undefined;
  const rowFields = new Set((rowType.fields ?? []).map((f) => f.name));
  if (!rowFields.has('min') || !rowFields.has('max')) return undefined;

  const fieldArg = field.args.find(
    (a) => a.name === 'field' && namedType(a.type).name === 'String',
  );
  if (!fieldArg) return undefined;

  const filtersArg = field.args.find((a) => a.name === 'filters' && isListType(a.type));
  const filterModeArg = field.args.find((a) => a.name === 'filterMode');

  return {
    field: field.name,
    fieldArgName: fieldArg.name,
    fieldArgType: typeRefToSDL(fieldArg.type),
    filtersArgName: filtersArg?.name,
    filtersArgType: filtersArg && typeRefToSDL(filtersArg.type),
    filterModeArgName: filterModeArg?.name,
    filterModeArgType: filterModeArg && typeRefToSDL(filterModeArg.type),
  };
}

/**
 * Numeric/date range facets (issue #61): derived from a 'filterList'
 * collection's own columns — the only shape whose typed `conditions`
 * mechanism can carry GTE/LTE (hippoSource.ts `listFilterEntries`; the
 * inputObject/stub shape carries equality filters only and never sees
 * conditions). Gated on a genuine `FieldRange` field (ADR-0029): without it,
 * nothing changes even though the FilterOp vocabulary may already advertise
 * GTE/LTE independent of this aggregation gate (ADR-0006, predates X1).
 */
function deriveRangeFacets(
  columns: ColumnModel[],
  fieldRange: FieldRangeModel | undefined,
): FacetModel[] {
  if (!fieldRange) return [];
  const facets: FacetModel[] = [];
  for (const column of columns) {
    if (column.kind === 'number') {
      facets.push({ field: slotName(column.field), label: column.label, kind: 'number-range' });
    } else if (column.kind === 'date') {
      facets.push({ field: slotName(column.field), label: column.label, kind: 'date-range' });
    }
  }
  return facets;
}

/**
 * A single-entity fetch path (R3.7): prefer a singular Query field returning
 * the entity type with one scalar arg (e.g. `book(id: ID!)`); fall back to an
 * id-equality filter on the list field. Neither advertised → no detail path,
 * detail UI gates off (ADR-0029).
 */
function deriveDetailPath(
  queryFields: IntrospectionField[],
  typeName: string,
  filterType: IntrospectionType | undefined,
  idColumn: string | undefined,
): DetailPath | undefined {
  for (const field of queryFields) {
    if (isListType(field.type)) continue;
    const named = namedType(field.type);
    if (named.kind !== 'OBJECT' || named.name !== typeName) continue;
    const scalarArg = field.args.find((a) => {
      const argNamedType = namedType(a.type);
      return argNamedType.name === 'ID' || argNamedType.name === 'String';
    });
    if (scalarArg) {
      return {
        kind: 'field',
        field: field.name,
        argName: scalarArg.name,
        argType: typeRefToSDL(scalarArg.type),
      };
    }
  }
  if (idColumn && filterType?.kind === 'INPUT_OBJECT') {
    const idInput = (filterType.inputFields ?? []).find((f) => f.name === idColumn);
    if (idInput) return { kind: 'filter', filterField: idInput.name };
  }
  return undefined;
}

/**
 * The form model derives from a mutation's input object type (W4.1): widget
 * per input-field kind, required from NON_NULL. Multivalued and nested inputs
 * are deferred (Tier-1 workflow territory); those fields are omitted, which
 * is honest — the form never offers what it can't submit.
 */
function deriveFormModel(
  schema: IntrospectionSchema,
  inputTypeName: string | null,
  entityColumns: ColumnModel[],
): FormModel | undefined {
  const inputType = findType(schema, inputTypeName);
  if (inputType?.kind !== 'INPUT_OBJECT') return undefined;
  const refTargets = new Map(
    entityColumns.filter((c) => c.kind === 'ref').map((c) => [c.field, c.targetType]),
  );

  const fields: FormFieldModel[] = [];
  for (const input of inputType.inputFields ?? []) {
    if (isListType(input.type)) continue;
    const named = namedType(input.type);
    const base = {
      name: input.name,
      label: humanize(input.name),
      required: input.type.kind === 'NON_NULL',
    };
    if (named.kind === 'ENUM') {
      const enumType = findType(schema, named.name);
      fields.push({
        ...base,
        widget: 'select',
        options: enumType?.enumValues?.map((v) => v.name) ?? [],
      });
    } else if (named.kind === 'SCALAR') {
      const scalar = named.name ?? '';
      if (refTargets.has(input.name) && (scalar === 'ID' || scalar === 'String')) {
        fields.push({ ...base, widget: 'ref', targetType: refTargets.get(input.name) });
      } else if (scalar === 'Boolean') {
        fields.push({ ...base, widget: 'checkbox' });
      } else if (NUMBER_SCALARS.has(scalar)) {
        fields.push({ ...base, widget: 'number' });
      } else if (DATE_SCALARS.has(scalar)) {
        fields.push({ ...base, widget: 'date' });
      } else {
        fields.push({ ...base, widget: 'text' });
      }
    }
    // Nested input objects are skipped (no Tier-0 widget).
  }
  if (fields.length === 0) return undefined;
  return { inputTypeName: inputType.name, fields };
}

/**
 * Create/update mutation paths derive from the Mutation type (W4.3): a
 * create-shaped field returns the entity type and takes one input object; an
 * update-shaped field additionally takes a scalar id arg. Nothing advertised
 * → the write UI gates off (ADR-0029).
 */
function deriveWriteModel(
  schema: IntrospectionSchema,
  typeName: string,
  entityColumns: ColumnModel[],
): WriteModel {
  const mutationType = findType(schema, schema.mutationType?.name ?? null);
  const write: WriteModel = {};

  for (const field of mutationType?.fields ?? []) {
    if (isListType(field.type)) continue;
    if (namedType(field.type).name !== typeName) continue;

    const inputArg = field.args.find((a) => namedType(a.type).kind === 'INPUT_OBJECT');
    const idArg = field.args.find((a) => {
      const t = namedType(a.type);
      return t.kind === 'SCALAR' && (t.name === 'ID' || t.name === 'String');
    });
    if (!inputArg) continue;
    const form = deriveFormModel(schema, namedType(inputArg.type).name, entityColumns);
    if (!form) continue;

    if (!write.create && !idArg && /^(create|add|new)/i.test(field.name)) {
      write.create = {
        field: field.name,
        inputArgName: inputArg.name,
        inputArgType: typeRefToSDL(inputArg.type),
        form,
      };
    } else if (!write.update && idArg && /^(update|edit|patch)/i.test(field.name)) {
      write.update = {
        field: field.name,
        idArgName: idArg.name,
        idArgType: typeRefToSDL(idArg.type),
        inputArgName: inputArg.name,
        inputArgType: typeRefToSDL(inputArg.type),
        form,
      };
    }
  }
  return write;
}

/** A required scalar (ID/String) arg, optionally excluding one already claimed by name. */
function requiredScalarIdArg(
  field: IntrospectionField,
  exclude?: string,
): IntrospectionInputValue | undefined {
  return field.args.find((a) => {
    if (exclude && a.name === exclude) return false;
    if (a.type.kind !== 'NON_NULL') return false;
    const named = namedType(a.type);
    return named.kind === 'SCALAR' && (named.name === 'ID' || named.name === 'String');
  });
}

/**
 * Availability-transition / supersede mutations derive from the Mutation
 * type (W4.4): a `*Availability` field (id arg + Boolean arg) is the
 * single-entity availability transition; a `supersede*` field (id arg + a
 * second required id-typed arg) is the supersede mutation. Bulk availability
 * mutations are excluded — this derives the single-entity detail-view
 * affordances only. Unlike create/update (`deriveWriteModel`), these
 * mutations return a result/receipt type rather than the entity itself, so
 * the match can't ride the return type — the field name must reference the
 * entity type instead. Nothing advertised → no affordance (ADR-0029).
 */
function deriveLifecycleModel(schema: IntrospectionSchema, typeName: string): LifecycleModel {
  const mutationType = findType(schema, schema.mutationType?.name ?? null);
  const lifecycle: LifecycleModel = {};
  const lowerType = typeName.toLowerCase();

  for (const field of mutationType?.fields ?? []) {
    if (!field.name.toLowerCase().includes(lowerType)) continue;

    if (!lifecycle.setAvailability && /availability/i.test(field.name) && !/bulk/i.test(field.name)) {
      const idArg = requiredScalarIdArg(field);
      const availabilityArg = field.args.find((a) => namedType(a.type).name === 'Boolean');
      if (idArg && availabilityArg) {
        const reasonArg = field.args.find((a) => /^reason$/i.test(a.name));
        lifecycle.setAvailability = {
          field: field.name,
          idArgName: idArg.name,
          idArgType: typeRefToSDL(idArg.type),
          availabilityArgName: availabilityArg.name,
          reasonArgName: reasonArg?.name,
        };
      }
    }

    if (!lifecycle.supersede && /^supersede/i.test(field.name)) {
      const idArg = requiredScalarIdArg(field);
      const replacementArg = idArg && requiredScalarIdArg(field, idArg.name);
      if (idArg && replacementArg) {
        const reasonArg = field.args.find((a) => /^reason$/i.test(a.name));
        lifecycle.supersede = {
          field: field.name,
          idArgName: idArg.name,
          idArgType: typeRefToSDL(idArg.type),
          replacementArgName: replacementArg.name,
          replacementArgType: typeRefToSDL(replacementArg.type),
          reasonArgName: reasonArg?.name,
        };
      }
    }
  }

  return lifecycle;
}

/** The derivable column set of an entity type (detail-budgeted). */
function deriveColumns(
  schema: IntrospectionSchema,
  entityType: IntrospectionType,
): ColumnModel[] {
  const detailColumns: ColumnModel[] = [];
  for (const entityField of entityType.fields ?? []) {
    if (detailColumns.length >= MAX_DETAIL_COLUMNS) break;
    const column = columnFor(entityField, schema);
    if (column) detailColumns.push(column);
  }
  return detailColumns;
}

/**
 * Prefer the entity's own id-named column over other ID-typed fields (FK renames).
 *
 * **Takes `detailColumns`, never the `MAX_COLUMNS` table slice (issue #67).** A
 * presentation budget must not decide what identifies a record. Passing the
 * slice meant any class declaring more than eight slots before the envelope
 * fields fell through to the "first non-FK column" arm and identified its
 * records by `name` — on the 15-collection demo schema that was `instruments`
 * (`id` at index 8) and `publications` (index 9), and declaring a single
 * `inverse:` slot added `donors`, because the generated `<rel>Count` field
 * lands inline at the slot's position and displaces everything after it.
 *
 * The failure was quiet where it mattered most: `planner.ts` reads
 * `row[related.idColumn]` to collect linking ids for a semijoin, so a wrong
 * answer here produced an `IN` filter over names that matched nothing and
 * reported no error.
 */
function pickIdColumn(columns: ColumnModel[]): string {
  // FK-rename scalars (e.g. `donorId` beside a `donor` ref) are NOT the
  // entity's own identity. Excluding them keeps the id-column link from
  // pointing a foreign key at the *current* collection (the wrong-collection
  // bug) — those resolve through their reference edge instead. Same exclusion
  // as `deriveColumnFilterFields`.
  const refFields = new Set(columns.filter((c) => c.kind === 'ref').map((c) => c.field));
  const isForeignKey = (c: ColumnModel) =>
    c.kind === 'id' && refFields.has(c.field.replace(/Id$/, ''));
  return (
    columns.find((c) => ID_FIELD_NAMES.has(c.field)) ??
    columns.find((c) => c.kind === 'id' && !isForeignKey(c)) ??
    columns.find((c) => !isForeignKey(c)) ??
    columns[0]
  ).field;
}

/**
 * The page-envelope shape (live Hippo, #15): a non-list Query field returning
 * an OBJECT with `items: [T!]` (list of OBJECT) and `total: Int`.
 */
function pageEnvelope(
  schema: IntrospectionSchema,
  field: IntrospectionField,
): IntrospectionType | undefined {
  if (isListType(field.type)) return undefined;
  const pageType = findType(schema, namedType(field.type).name);
  if (pageType?.kind !== 'OBJECT') return undefined;
  const items = (pageType.fields ?? []).find((f) => f.name === 'items');
  const total = (pageType.fields ?? []).find((f) => f.name === 'total');
  if (!items || !total || !isListType(items.type) || isListType(total.type)) return undefined;
  if (namedType(total.type).name !== 'Int') return undefined;
  const itemNamed = namedType(items.type);
  if (itemNamed.kind !== 'OBJECT' || itemNamed.name == null || itemNamed.name.startsWith('__')) {
    return undefined;
  }
  const entityType = findType(schema, itemNamed.name);
  return entityType?.fields?.length ? entityType : undefined;
}

/**
 * Never derive a query surface whose required args we can't supply
 * (ADR-0029). Per the GraphQL spec an argument is only *required* when
 * NON_NULL **and** defaultless — a server-side default (e.g. Mosaic's
 * `orderDir: OrderDirection! = ASC`, ADR-0007) satisfies it without us.
 */
function requiredArgsSatisfiable(field: IntrospectionField, supplied: Set<string>): boolean {
  return field.args.every(
    (a) => a.type.kind !== 'NON_NULL' || a.defaultValue != null || supplied.has(a.name),
  );
}

/** The search-twin arg: a required search string (`q(uery)`/`search`: String!). */
function searchTwinArg(field: IntrospectionField): IntrospectionInputValue | undefined {
  return field.args.find(
    (a) =>
      /^(q|query|search)$/i.test(a.name) &&
      a.type.kind === 'NON_NULL' &&
      namedType(a.type).name === 'String',
  );
}

/** Case/separator-insensitive key for matching a field name against an enum member. */
function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The `orderBy` arg's advertised enum type, when it resolves to one (Mosaic
 * ADR-0007 `<Class>OrderField`). Never assumed by name — derived from the
 * arg's own introspected type, so a non-enum `orderBy` (or none) yields
 * nothing to match against.
 */
function orderFieldEnumType(
  schema: IntrospectionSchema,
  orderByArg: IntrospectionInputValue | undefined,
): IntrospectionType | undefined {
  if (!orderByArg) return undefined;
  const enumType = findType(schema, namedType(orderByArg.type).name);
  return enumType?.kind === 'ENUM' ? enumType : undefined;
}

/**
 * Tags each column with the `orderBy` enum member that sorts by it, when the
 * endpoint's enum advertises a matching member (normalized name match — e.g.
 * `collectedAt` ↔ `COLLECTED_AT`). Columns with no match stay unsortable
 * (ADR-0029 — degrade honestly rather than guessing).
 */
function attachOrderFields(columns: ColumnModel[], enumType: IntrospectionType | undefined): ColumnModel[] {
  if (!enumType?.enumValues?.length) return columns;
  const byNormalizedName = new Map(enumType.enumValues.map((v) => [normalizeForMatch(v.name), v.name]));
  return columns.map((column) => {
    const member = byNormalizedName.get(normalizeForMatch(column.field));
    return member ? { ...column, orderField: member } : column;
  });
}

/**
 * A Query field is a browsable collection when it pages entities — either a
 * page envelope `{ items total }` (live Hippo, #15) or a bare list of OBJECTs
 * (the stub shape, kept as the fallback). Nav derives all of them
 * (derive-all; config reorder/relabel/hide is later — R3.1).
 */
/**
 * Attach Mosaic's per-slot metadata to columns that already exist.
 *
 * A separate pass rather than a parameter threaded through `columnFor`: derivation is
 * driven by the GraphQL surface and should stay that way, and enrichment is optional data
 * that decorates the result. Keeping them apart means an endpoint without `hippoSchema`
 * takes literally the same code path it always did.
 *
 * **Joined on SLOT name, not field name.** `ColumnModel.field` is the GraphQL field
 * (`historyOfRhi`); `hippoSchema` speaks LinkML (`history_of_rhi`). `specProse` already
 * resolves this same mismatch the same way.
 */
function enrichColumn(column: ColumnModel, slots: ReadonlyMap<string, SlotInfo>): ColumnModel {
  const slot = slots.get(slotName(column.field)) ?? slots.get(column.field);
  if (!slot) return column;
  return {
    ...column,
    slot: slot.name,
    description: slot.description ?? undefined,
    range: slot.range,
    slotKind: slot.kind,
    required: slot.required,
    enumName: slot.enumName ?? undefined,
    // Only fill enum values we do not already have: the GraphQL enum is the one the
    // filter input actually accepts, and it is what the rest of the app matches against.
    enumValues: column.enumValues ?? (slot.enumValues.length ? slot.enumValues : undefined),
  };
}

function enrichCollection(collection: CollectionModel, enrichment: SlotEnrichment): CollectionModel {
  const slots = enrichment.get(collection.typeName);
  if (!slots) return collection;
  return {
    ...collection,
    columns: collection.columns.map((c) => enrichColumn(c, slots)),
    detailColumns: collection.detailColumns.map((c) => enrichColumn(c, slots)),
  };
}

export function deriveCollections(
  schema: IntrospectionSchema,
  enrichment?: SlotEnrichment,
): CollectionModel[] {
  const queryType = findType(schema, schema.queryType.name);
  const queryFields = queryType?.fields ?? [];
  const collections: CollectionModel[] = [];

  // Pass 1 — page envelopes.
  for (const field of queryFields) {
    const entityType = pageEnvelope(schema, field);
    if (!entityType) continue;

    // The flat filter arg is LIST-typed ([FilterInput!]); a typed per-class
    // `where` input object (Mosaic ADR-0006 inc. 2) may sit BESIDE it on the
    // same field. Disambiguate by shape, not name — matching `where` by name
    // alone would route the flat filter list into the typed input and fail
    // GraphQL validation on ADR-0006-era endpoints.
    const flatFilterArg = field.args.find(
      (a) => ['filters', 'filter', 'where'].includes(a.name) && isListType(a.type),
    );
    const whereArg = field.args.find(
      (a) =>
        a.name === 'where' &&
        !isListType(a.type) &&
        findType(schema, namedType(a.type).name)?.kind === 'INPUT_OBJECT',
    );
    const args = {
      limit: argNamed(field, 'limit', 'first'),
      offset: argNamed(field, 'offset', 'skip'),
      filter: flatFilterArg ?? argNamed(field, 'filter', 'filters'),
      filterMode: argNamed(field, 'filterMode'),
      orderBy: argNamed(field, 'orderBy', 'order_by', 'sort'),
      orderDir: argNamed(field, 'orderDir', 'order_dir', 'direction'),
      where: whereArg,
    };
    const supplied = new Set(
      [args.limit, args.offset, args.filter, args.filterMode].flatMap((a) =>
        a ? [a.name] : [],
      ),
    );
    if (!requiredArgsSatisfiable(field, supplied)) continue;

    const orderFieldEnum = orderFieldEnumType(schema, args.orderBy);
    const detailColumns = attachOrderFields(deriveColumns(schema, entityType), orderFieldEnum);
    if (detailColumns.length === 0) continue;
    const columns = detailColumns.slice(0, MAX_COLUMNS);
    const idColumn = pickIdColumn(detailColumns);
    const fieldRange = deriveFieldRange(schema, queryFields, field.name);

    collections.push({
      id: field.name,
      label: humanize(field.name),
      typeName: entityType.name,
      columns,
      detailColumns,
      idColumn,
      pageShape: 'envelope',
      filterShape: args.filter ? 'filterList' : undefined,
      filterModeArg: args.filterMode && {
        name: args.filterMode.name,
        type: typeRefToSDL(args.filterMode.type),
      },
      args: {
        limit: args.limit?.name,
        offset: args.offset?.name,
        filter: args.filter?.name,
        orderBy: args.orderBy?.name,
        orderDir: args.orderDir?.name,
        where: args.where?.name,
      },
      argTypes: {
        limit: args.limit && typeRefToSDL(args.limit.type),
        offset: args.offset && typeRefToSDL(args.offset.type),
        filter: args.filter && typeRefToSDL(args.filter.type),
        where: args.where && typeRefToSDL(args.where.type),
        orderBy: args.orderBy && typeRefToSDL(args.orderBy.type),
        orderDir: args.orderDir && typeRefToSDL(args.orderDir.type),
      },
      facets: args.filter
        ? [...deriveColumnFacets(detailColumns), ...deriveRangeFacets(detailColumns, fieldRange)]
        : [],
      facetCounts: deriveFacetCounts(schema, queryFields, field.name),
      fieldRange,
      filterFields: args.filter ? deriveColumnFilterFields(detailColumns) : [],
      whereFields: deriveWhereFields(schema, args.where ? (namedType(args.where.type).name ?? undefined) : undefined),
      detail: deriveDetailPath(queryFields, entityType.name, undefined, idColumn),
      write: deriveWriteModel(schema, entityType.name, detailColumns),
      lifecycle: deriveLifecycleModel(schema, entityType.name),
    });
  }

  // Pass 1.5 — envelope search twins (Mosaic issue #157): a non-list Query
  // field returning the same Page shape with a required search-string arg
  // (`searchSamples(q: String!): SamplePage`). It never derived as a
  // collection above (its required `q` is unsatisfiable there); attach it
  // to its base collection, carrying the filter args it composes with.
  for (const field of queryFields) {
    const entityType = pageEnvelope(schema, field);
    if (!entityType) continue;
    const twinArg = searchTwinArg(field);
    if (!twinArg) continue;
    const base = collections.find(
      (c) => c.pageShape === 'envelope' && c.typeName === entityType.name,
    );
    if (!base) continue;
    const limit = argNamed(field, 'limit', 'first');
    const offset = argNamed(field, 'offset', 'skip');
    // Same shape-based disambiguation as the base collection: the flat
    // filter arg is LIST-typed; `where` beside it is the typed input.
    const twinFilterArg = field.args.find(
      (a) => ['filters', 'filter', 'where'].includes(a.name) && isListType(a.type),
    );
    const twinFilterMode = argNamed(field, 'filterMode');
    if (
      !requiredArgsSatisfiable(
        field,
        new Set(
          [twinArg, limit, offset, twinFilterArg, twinFilterMode].flatMap((a) =>
            a ? [a.name] : [],
          ),
        ),
      )
    ) {
      continue;
    }
    const twinOrderBy = argNamed(field, 'orderBy', 'order_by', 'sort');
    const twinOrderDir = argNamed(field, 'orderDir', 'order_dir', 'direction');
    base.search ??= {
      field: field.name,
      argName: twinArg.name,
      argType: typeRefToSDL(twinArg.type),
      limitArg: limit?.name,
      limitArgType: limit && typeRefToSDL(limit.type),
      offsetArg: offset?.name,
      offsetArgType: offset && typeRefToSDL(offset.type),
      envelope: true,
      filterArg: twinFilterArg?.name,
      filterArgType: twinFilterArg && typeRefToSDL(twinFilterArg.type),
      filterModeArg: twinFilterMode?.name,
      filterModeArgType: twinFilterMode && typeRefToSDL(twinFilterMode.type),
      orderByArg: twinOrderBy?.name,
      orderByArgType: twinOrderBy && typeRefToSDL(twinOrderBy.type),
      orderDirArg: twinOrderDir?.name,
      orderDirArgType: twinOrderDir && typeRefToSDL(twinOrderDir.type),
    };
  }

  // An endpoint that advertises page envelopes is envelope-shaped: its bare
  // lists are auxiliary surfaces (search twins, hippoSchema, …), never
  // standalone collections.
  const envelopeMode = collections.length > 0;

  // Pass 2 — bare lists: search twins attach; the rest derive only in stub
  // (list) mode.
  for (const field of queryFields) {
    if (!isListType(field.type)) continue;
    // History is a per-entity query surface (R3.7), not a browsable collection.
    if (/^entityHistory$/i.test(field.name)) continue;
    const named = namedType(field.type);
    if (named.kind !== 'OBJECT' || named.name == null) continue;
    const entityType = findType(schema, named.name);
    if (!entityType?.fields?.length) continue;
    // Introspection meta types are filtered by the server; skip defensively.
    if (named.name.startsWith('__')) continue;

    const twinArg = searchTwinArg(field);
    const base = collections.find(
      (c) => c.pageShape === 'envelope' && c.typeName === named.name,
    );
    if (twinArg && base) {
      const limit = argNamed(field, 'limit', 'first');
      const offset = argNamed(field, 'offset', 'skip');
      if (!requiredArgsSatisfiable(field, new Set([twinArg.name, limit?.name ?? '', offset?.name ?? '']))) {
        continue;
      }
      base.search ??= {
        field: field.name,
        argName: twinArg.name,
        argType: typeRefToSDL(twinArg.type),
        limitArg: limit?.name,
        limitArgType: limit && typeRefToSDL(limit.type),
        offsetArg: offset?.name,
        offsetArgType: offset && typeRefToSDL(offset.type),
      };
      continue;
    }
    if (envelopeMode) continue;

    const args = {
      limit: argNamed(field, 'limit', 'first'),
      offset: argNamed(field, 'offset', 'skip'),
      filter: argNamed(field, 'filter', 'where', 'filters'),
      search: argNamed(field, 'search', 'q', 'fts', 'query'),
      orderBy: argNamed(field, 'orderBy', 'order_by', 'sort'),
      orderDir: argNamed(field, 'orderDir', 'order_dir', 'direction'),
    };
    // A bare list with required args we don't send (e.g. an unmatched search
    // twin's `q`) can never be queried as a collection — skip it (ADR-0029).
    const supplied = new Set([args.limit, args.offset].flatMap((a) => (a ? [a.name] : [])));
    if (!requiredArgsSatisfiable(field, supplied)) continue;

    const orderFieldEnum = orderFieldEnumType(schema, args.orderBy);
    const detailColumns = attachOrderFields(deriveColumns(schema, entityType), orderFieldEnum);
    if (detailColumns.length === 0) continue;
    const columns = detailColumns.slice(0, MAX_COLUMNS);
    const idColumn = pickIdColumn(detailColumns);
    const filterTypeName = args.filter ? namedType(args.filter.type).name : null;
    const filterType = findType(schema, filterTypeName);

    collections.push({
      id: field.name,
      label: humanize(field.name),
      typeName: named.name,
      columns,
      detailColumns,
      idColumn,
      pageShape: 'list',
      filterShape: filterType?.kind === 'INPUT_OBJECT' ? 'inputObject' : undefined,
      args: {
        limit: args.limit?.name,
        offset: args.offset?.name,
        filter: args.filter?.name,
        search: args.search?.name,
        orderBy: args.orderBy?.name,
        orderDir: args.orderDir?.name,
      },
      argTypes: {
        limit: args.limit && typeRefToSDL(args.limit.type),
        offset: args.offset && typeRefToSDL(args.offset.type),
        filter: args.filter && typeRefToSDL(args.filter.type),
        search: args.search && typeRefToSDL(args.search.type),
        orderBy: args.orderBy && typeRefToSDL(args.orderBy.type),
        orderDir: args.orderDir && typeRefToSDL(args.orderDir.type),
      },
      facets: deriveFacets(schema, filterTypeName, detailColumns),
      facetCounts: deriveFacetCounts(schema, queryFields, field.name),
      // No `deriveRangeFacets` here: the inputObject/stub shape carries
      // equality filters only (hippoSource.ts) — a widget wired to GTE/LTE
      // would silently do nothing, which ADR-0029 forbids. `fieldRange` is
      // still derived so the capability model is honest either way.
      fieldRange: deriveFieldRange(schema, queryFields, field.name),
      filterFields:
        filterType?.kind === 'INPUT_OBJECT'
          ? (filterType.inputFields ?? [])
              .filter((f) => !COMBINATOR_FIELDS.has(f.name))
              .map((f) => f.name)
          : [],
      detail: deriveDetailPath(queryFields, named.name, filterType, idColumn),
      write: deriveWriteModel(schema, named.name, detailColumns),
      lifecycle: deriveLifecycleModel(schema, named.name),
    });
  }

  // The entity description comes from `__schema` and needs no enrichment, so it is filled
  // whether or not `hippoSchema` is advertised.
  const described = collections.map((c) => {
    const entityType = findType(schema, c.typeName);
    return entityType?.description ? { ...c, description: entityType.description } : c;
  });
  return enrichment ? described.map((c) => enrichCollection(c, enrichment)) : described;
}

/**
 * An `entityHistory`-style Query field (R3.7), when advertised: one scalar
 * arg, returns a list of objects with derivable scalar columns.
 */
export function deriveHistory(schema: IntrospectionSchema): HistoryModel | undefined {
  const queryType = findType(schema, schema.queryType.name);
  const field = (queryType?.fields ?? []).find((f) => /^entityHistory$/i.test(f.name));
  if (!field || !isListType(field.type)) return undefined;
  const named = namedType(field.type);
  const rowType = findType(schema, named.name);
  if (rowType?.kind !== 'OBJECT') return undefined;
  const scalarArg = field.args.find((a) => {
    const t = namedType(a.type);
    return t.name === 'ID' || t.name === 'String';
  });
  if (!scalarArg) return undefined;
  const columns = (rowType.fields ?? [])
    .map((f) => columnFor(f, schema))
    .filter((c): c is ColumnModel => c != null && c.kind !== 'ref' && c.kind !== 'refList')
    .slice(0, MAX_COLUMNS);
  if (columns.length === 0) return undefined;
  return {
    field: field.name,
    argName: scalarArg.name,
    argType: typeRefToSDL(scalarArg.type),
    columns,
  };
}

/**
 * Capability negotiation (N5.1): every flag derives from what introspection
 * actually shows. On Hippo today that yields FTS + equality facets + offset
 * pages + relationship traversal + batch write; sort/aggregation stay off
 * until Hippo X1 advertises them (ADR-0029 — never fake).
 */
export function deriveCapabilities(
  schema: IntrospectionSchema,
  collections: CollectionModel[],
): Capabilities {
  const queryType = findType(schema, schema.queryType.name);
  const hasHippoSchema = (queryType?.fields ?? []).some((f) => f.name === 'hippoSchema');

  const some = (pick: (c: CollectionModel) => unknown) => collections.some((c) => Boolean(pick(c)));

  const relationshipTraversal = collections.some((c) =>
    c.columns.some((col) => col.kind === 'ref' || col.kind === 'refList'),
  );

  // The flat-filter operator vocabulary IS the introspected FilterOp enum
  // (Mosaic ADR-0006's contract principle) — derived, never assumed. Pre-enum
  // endpoints (equality-only filter inputs) degrade to bare equality.
  const filterOpEnum = findType(schema, 'FilterOp');
  const filterOps =
    filterOpEnum?.kind === 'ENUM'
      ? (filterOpEnum.enumValues ?? []).map((v) => v.name)
      : some((c) => c.args.filter)
        ? ['EQ']
        : [];

  return {
    schemaIntrospection: hasHippoSchema ? 'hippo' : 'graphql',
    offsetPagination: some((c) => c.args.limit && c.args.offset),
    equalityFacets: some((c) => c.args.filter),
    fullTextSearch:
      some((c) => c.args.search || c.search) ||
      (queryType?.fields ?? []).some((f) => /^search/i.test(f.name)),
    // A collection only counts as sortable if at least one of its columns
    // actually resolved to an orderBy enum member — an advertised `orderBy`
    // arg whose enum matches none of the derived columns sorts nothing.
    sort: some((c) => c.args.orderBy && c.columns.some((col) => col.orderField != null)),
    aggregation: some((c) => c.facetCounts != null),
    // Only counts collections whose facets actually include a range facet —
    // a `fieldRange` field with no usable filterList facets to attach to
    // (the stub/inputObject shape) advertises no rangeFacets capability.
    rangeFacets: some((c) => c.facets.some((f) => f.kind === 'number-range' || f.kind === 'date-range')),
    relationshipTraversal,
    entityHistory: deriveHistory(schema) != null,
    // True only when the batch surface introspects to a usable shape —
    // a name match alone is not a capability (ADR-0029).
    batchWrite: deriveBatchModel(schema) != null,
    filterOps,
    // Typed per-class filter inputs (Mosaic ADR-0006 inc. 2): a list field
    // advertising a `where` arg whose type is an input object.
    whereFilter: some((c) => c.args.where),
    // Same standard as batchWrite: the mutation must introspect to a shape the
    // panel can actually drive, not merely carry the right name (ADR-0039).
    conversationalQuery: deriveConversationModel(schema) != null,
    // The graph view's server tier (ADR-0037): shape-checked, not name-matched.
    neighborsTraversal: deriveNeighborsModel(schema) != null,
  };
}
