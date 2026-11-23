import type { Capabilities } from '../data/capabilities';
import type { CollectionModel } from '../data/schemaModel';
import { humanize, slotName } from '../data/schemaModel';
import { supportsRelationship } from './whereCompiler';

/**
 * The QuerySpec noun (ADR-0035): a typed, serializable, introspection-
 * validated cross-class query artifact. This MVP carries the anchor, one
 * criteria group (AND/OR) of field conditions and quantified relationship
 * conditions, and rides the URL (`qs`). Nested criteria groups arrive with
 * the typed `where:` planner tier (Mosaic ADR-0006 inc. 2+); columns/sort
 * arrive with server aggregation (Mosaic ADR-0007). The artifact never
 * changes shape when the server upgrades — only the planner does.
 */

/** Operator vocabulary (slot names, matching Mosaic's SDK ops). */
export type QueryOp =
  | 'eq'
  | 'neq'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'is_null';

/** SDK op → the endpoint's FilterOp enum member name. */
export function filterOpMember(op: QueryOp): string {
  return op.toUpperCase();
}

export interface FieldCondition {
  kind: 'field';
  /** LinkML slot name — never the camelCase rename (ADR-0035). */
  slot: string;
  op: QueryOp;
  value: unknown;
}

export interface RelatedCondition {
  kind: 'related';
  /**
   * v2: the LinkML slot name of a forward reference the anchor itself holds
   * (`donor`) — the same vocabulary Mosaic's `RelatedCondition.edge` validates
   * against, so a spec from a planning service needs no translation.
   *
   * Reverse edges keep the Aperture-local `rev:<collectionId>.<field>` key.
   * That is deliberate, not an oversight: a reverse edge has no LinkML name
   * until the schema declares the inverting slot (`Donor.samples` with
   * `inverse: donor`), which Mosaic ADR-0011 / `mosaic#204` add. Naming one
   * now would invent a vocabulary upstream has already decided differently —
   * and dropping the prefix would be wrong besides, since `rev:samples.donor`
   * strips to `donor`, a slot on `Sample` rather than on the `Donor` anchor,
   * colliding with the forward edge of the same name. These keys never reach
   * a server: they drive the client-side semijoin in `planner.ts`.
   */
  edge: string;
  /** "having ≥1" / "having exactly 0" related records (ADR-0035). */
  quantifier: 'some' | 'none';
  /** Conditions holding on the SAME related record (AND, flat in the MVP). */
  criteria: FieldCondition[];
}

export type Criterion = FieldCondition | RelatedCondition;

/**
 * The artifact, spelled in LinkML vocabulary: `anchor` is the **class name**
 * (`"Sample"`), `slot` is the slot name, and a forward `edge` is the reference
 * slot's name.
 *
 * **`v` stays 1, deliberately (2026-09-11, task 4.1).** This is not Aperture's
 * version to bump: `v: 1` is the *platform* wire version. Mosaic's parser hard-
 * requires it (`core/query_spec.py` — "'v' must be 1") and re-validates every
 * candidate spec through it, and the planning service's own tool schema says
 * "QuerySpec version. Always 1." A `v: 2` would come back
 * `INVALID_QUERYSPEC_SHAPE`.
 *
 * What changed is not the version but the **dialect**. Aperture used to address
 * the anchor by its own collection id (`"samples"`) and prefix forward edges
 * `fwd:<graphqlField>` — a local dialect of a shared artifact, which is why a
 * spec from a planning service could be displayed but never run. Aperture now
 * speaks the platform spelling. Since both dialects carry `v: 1`, the version
 * cannot tell them apart and `canonicalizeQuerySpec` discriminates by content.
 *
 * Aperture's shape remains a documented **subset** of Mosaic's `QuerySpec`,
 * which also carries `as_of` and `sort` — a pre-existing gap, not a new one.
 */
export interface QuerySpec {
  v: 1;
  /** LinkML class name of the anchor — a result row IS one of these. */
  anchor: string;
  /** Combinator across the top-level criteria. */
  mode: 'AND' | 'OR';
  criteria: Criterion[];
}

export function emptyQuerySpec(anchorTypeName: string): QuerySpec {
  return { v: 1, anchor: anchorTypeName, mode: 'AND', criteria: [] };
}

/**
 * Shape guard for the `qs` URL parameter (nuqs parseAsJson validator).
 *
 * Deliberately schema-*un*aware: nuqs calls this with no app context, and
 * telling the two dialects apart needs `collections`. Shape here, dialect in
 * `canonicalizeQuerySpec`.
 */
export function validateQuerySpecShape(value: unknown): QuerySpec {
  const spec = readQuerySpec(value);
  if (!spec) throw new Error('not a QuerySpec');
  return spec;
}

/**
 * The same shape check, non-throwing.
 *
 * Use this wherever a spec arrives from somewhere other than the URL — above
 * all the conversational wire, where `turn.query_spec` is `unknown` server JSON
 * (`data/conversation.ts`). `validateQuerySpecShape` throws by design because
 * nuqs catches for it; called during render it would take the tree down
 * instead, and this app has no ErrorBoundary.
 */
export function readQuerySpec(value: unknown): QuerySpec | null {
  const spec = value as QuerySpec;
  if (
    typeof spec !== 'object' ||
    spec == null ||
    spec.v !== 1 ||
    typeof spec.anchor !== 'string' ||
    (spec.mode !== 'AND' && spec.mode !== 'OR') ||
    !Array.isArray(spec.criteria)
  ) {
    return null;
  }
  return spec;
}

/**
 * Bring a spec onto the platform spelling, whichever dialect it arrives in.
 *
 * Both dialects carry `v: 1`, so this reads content, in a stated precedence:
 *
 * 1. an `anchor` matching a **typeName** is already canonical (checked first —
 *    Mosaic generates lowercase-plural list ids and PascalCase class names, so
 *    a collision is not expected, but precedence should not be left to
 *    `find` order);
 * 2. an `anchor` matching a **collection id** is the legacy dialect;
 * 3. a `fwd:` prefix marks a legacy edge wherever it appears — LinkML slot
 *    names contain no colon, so the marker is unambiguous.
 *
 * Returns `null` when the anchor matches neither, so callers degrade honestly
 * (ADR-0029) rather than running a half-translated query.
 */
export function canonicalizeQuerySpec(
  spec: QuerySpec,
  collections: CollectionModel[],
): QuerySpec | null {
  const anchor =
    collections.find((c) => c.typeName === spec.anchor) ??
    collections.find((c) => c.id === spec.anchor);
  if (!anchor) return null;

  // Legacy forward keys carried the GraphQL field name (`fwd:sampleType`); the
  // platform spelling is the LinkML slot (`sample_type`), so this is a real
  // translation, not a prefix strip. Reverse keys pass through untouched.
  let rewrote = false;
  const criteria = spec.criteria.map((criterion) => {
    if (criterion.kind !== 'related' || !criterion.edge.startsWith('fwd:')) return criterion;
    rewrote = true;
    return { ...criterion, edge: slotName(criterion.edge.slice('fwd:'.length)) };
  });

  if (!rewrote && anchor.typeName === spec.anchor) return spec;
  return { v: 1, anchor: anchor.typeName, mode: spec.mode, criteria };
}

/** The anchor collection a spec names, by LinkML class name. */
export function resolveAnchor(
  spec: QuerySpec,
  collections: CollectionModel[],
): CollectionModel | undefined {
  return collections.find((c) => c.typeName === spec.anchor);
}

/**
 * A relationship edge the anchor can traverse for a RelatedCondition,
 * derived entirely from the introspected collections (ADR-0002):
 *
 * - forward: the anchor has a resolved reference column pointing at the
 *   related type ("Sample → its Donor");
 * - reverse: another collection has a resolved reference column pointing at
 *   the anchor's type ("Donors having Samples where …").
 */
export interface QueryEdge {
  key: string;
  label: string;
  direction: 'forward' | 'reverse';
  /** The collection queried for the semijoin (the related side). */
  relatedCollectionId: string;
  /** The reference column field name on whichever side holds the reference. */
  refField: string;
  refTargetIdField: string;
  /**
   * True when traversing this edge reaches MANY related records — a forward
   * multivalued reference (`Workflow.inputSamples`), or any reverse edge.
   *
   * A display column on a to-many edge is a grain decision, not a formatting
   * one (ADR-0041): it must resolve to `count`/`joinIds` or an explicit
   * `explode`. To-one edges need no such choice.
   */
  toMany: boolean;
  /**
   * The GraphQL field on the ANCHOR that selects the related object(s), when
   * one exists — the nested-selection path (`donor { … }`).
   *
   * Absent on an inferred reverse edge, which is exactly the point: the anchor
   * holds no field to select through, so the edge can filter (via a semijoin)
   * but cannot carry display columns. That is the honest gate ADR-0029 asks
   * for, and it lifts on its own once the schema declares the `inverse:` slot
   * (Mosaic ADR-0011) and the edge arrives as a real `refList`.
   */
  selectField?: string;
}

export function deriveEdges(
  anchor: CollectionModel,
  collections: CollectionModel[],
): QueryEdge[] {
  const edges: QueryEdge[] = [];
  const byType = (typeName: string) => collections.find((c) => c.typeName === typeName);

  // Scan the FULL derivable field set (detailColumns): resolved reference
  // edges sit after the computed fields in Mosaic's generated types, so the
  // curated table budget (columns) routinely truncates them away.
  // `refList` is included alongside `ref` (ADR-0041). A forward multivalued
  // reference (`Workflow.inputSamples`) was previously skipped outright, so the
  // builder could neither filter on it nor read through it — even though Mosaic
  // has advertised both the resolved list and a `<rel>Count` companion since
  // v0.13.0.
  for (const column of anchor.detailColumns) {
    const isRef = column.kind === 'ref' || column.kind === 'refList';
    if (!isRef || !column.targetType || !column.targetIdField) continue;
    const related = byType(column.targetType);
    if (!related) continue;
    const toMany = column.kind === 'refList';
    edges.push({
      // v2: the LinkML slot name, unprefixed — the vocabulary a planning
      // service emits and Mosaic validates. `column.field` is the GraphQL
      // camelCase rename, so this is a real translation, not a prefix strip.
      key: slotName(column.field),
      label: toMany
        ? `${humanize(column.targetType)} (its ${column.label.toLowerCase()}, many)`
        : `${humanize(column.targetType)} (its ${column.label.toLowerCase()})`,
      direction: 'forward',
      relatedCollectionId: related.id,
      refField: column.field,
      refTargetIdField: column.targetIdField,
      toMany,
      // The anchor holds the field, so it is selectable — this is what lets a
      // forward edge carry display columns as well as criteria.
      selectField: column.field,
    });
  }

  // Reverse edges are INFERRED: nothing on the anchor names them, so they are
  // recovered by scanning other collections for a reference pointing back here.
  //
  // A declared edge always wins over an inferred one covering the same pair
  // (ADR-0041). Once a deployment declares the LinkML `inverse:` slot (Mosaic
  // ADR-0011) the same relationship arrives above as a real forward `refList`
  // — `Donor.samples` — and without this check the builder would offer it
  // twice: once as `samples`, once as `rev:samples.donor`. The declared form is
  // strictly better (server-filterable, and selectable for display), so the
  // inferred one suppresses itself rather than competing.
  const declaredTargets = new Set(
    edges.filter((e) => e.direction === 'forward').map((e) => e.relatedCollectionId),
  );

  for (const other of collections) {
    if (other.id === anchor.id) continue;
    if (declaredTargets.has(other.id)) continue;
    for (const column of other.detailColumns) {
      if (column.kind !== 'ref' || column.targetType !== anchor.typeName) continue;
      if (!column.targetIdField) continue;
      edges.push({
        key: `rev:${other.id}.${column.field}`,
        label: `${other.label} (their ${column.label.toLowerCase()})`,
        direction: 'reverse',
        relatedCollectionId: other.id,
        refField: column.field,
        refTargetIdField: column.targetIdField,
        // Reverse traversal reaches many related records by construction.
        toMany: true,
        // No `selectField`: the anchor holds no field to select through, so
        // this edge can filter but cannot carry display columns.
      });
    }
  }
  return edges;
}

export function edgeByKey(edges: QueryEdge[], key: string): QueryEdge | undefined {
  return edges.find((e) => e.key === key);
}

/** The operator set a slot kind supports (mirrors Mosaic ADR-0006). */
export function opsForKind(kind: string): QueryOp[] {
  switch (kind) {
    case 'number':
      return ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'is_null'];
    case 'date':
      return ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'is_null'];
    case 'boolean':
      return ['eq', 'neq', 'is_null'];
    case 'enum':
      return ['eq', 'neq', 'in', 'is_null'];
    case 'ref':
    case 'id':
      return ['eq', 'neq', 'in', 'is_null'];
    default:
      return ['eq', 'neq', 'in', 'contains', 'is_null'];
  }
}

/** A filterable slot on a collection: slot name + display metadata. */
export interface FilterSlot {
  slot: string;
  label: string;
  kind: string;
  enumValues?: readonly string[];
}

/**
 * Mosaic's read-time computed fields (provenance-derived, sec9 §9.7) plus its
 * envelope fields: exposed on entity types but never filterable — the server
 * rejects them with a coded UNFILTERABLE_FIELD (mosaic#149), so the builder
 * never offers them. Temporal queries go through `asOf`, not filters.
 */
const COMPUTED_UNFILTERABLE = new Set([
  'version',
  'created_at',
  'updated_at',
  'schema_version',
  'created_by',
  'updated_by',
  'superseded_by',
]);

/**
 * The filterable slots of a collection, with kinds resolved by matching the
 * filter-input slot names back to the entity columns (slot → camelCase).
 */
export function filterSlots(collection: CollectionModel): FilterSlot[] {
  const byName = new Map(collection.detailColumns.map((c) => [slotName(c.field), c]));
  return collection.filterFields
    .filter((slot) => !COMPUTED_UNFILTERABLE.has(slot))
    .map((slot) => {
      const column = byName.get(slot) ?? byName.get(slot.replace(/_id$/, ''));
      return {
        slot,
        label: column?.label ?? humanize(slot),
        // A family's kind-only field has no column; its kind comes from its
        // filter input (ADR-0042).
        kind: column?.kind ?? collection.filterKinds?.[slot] ?? 'text',
        enumValues: column?.enumValues,
      };
    });
}

export interface ValidationResult {
  errors: string[];
  /** Honest capability notes (features gated off) — not failures. */
  warnings: string[];
}

/**
 * Total, introspection-driven validation (ADR-0035): every anchor, slot, op,
 * and edge is checked against what the endpoint actually advertises. A spec
 * that validates cleanly compiles to queries the endpoint accepts.
 */
export function validateQuerySpec(
  spec: QuerySpec,
  collections: CollectionModel[],
  capabilities: Capabilities,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const anchor = resolveAnchor(spec, collections);
  if (!anchor) {
    return { errors: [`This endpoint exposes no type “${spec.anchor}”.`], warnings };
  }
  if (!anchor.args.filter) {
    errors.push(`${anchor.label} advertises no filter argument.`);
  }
  if (spec.mode === 'OR' && !anchor.filterModeArg) {
    errors.push('OR groups need the FilterMode combinator, which this endpoint does not advertise.');
  }
  const ops = new Set(capabilities.filterOps);
  const edges = deriveEdges(anchor, collections);

  const checkField = (c: FieldCondition, on: CollectionModel, where: string) => {
    const slots = filterSlots(on);
    const slot = slots.find((s) => s.slot === c.slot);
    if (!slot) {
      errors.push(`${where}: “${c.slot}” is not filterable on ${on.label}.`);
      return;
    }
    if (!opsForKind(slot.kind).includes(c.op)) {
      errors.push(`${where}: ${slot.label} (${slot.kind}) does not support “${c.op}”.`);
    }
    if (!ops.has(filterOpMember(c.op))) {
      warnings.push(
        `${where}: the endpoint does not advertise the “${c.op}” operator yet — gated off.`,
      );
      errors.push(`${where}: operator “${c.op}” is not available on this endpoint.`);
    }
    if (c.op === 'in' && !Array.isArray(c.value)) {
      errors.push(`${where}: “in” takes a list of values.`);
    } else if (c.op === 'is_null' && typeof c.value !== 'boolean') {
      errors.push(`${where}: “is_null” takes true/false.`);
    } else if (c.op !== 'is_null' && (c.value == null || c.value === '')) {
      errors.push(`${where}: missing a value.`);
    }
  };

  spec.criteria.forEach((criterion, i) => {
    const where = `Criterion ${i + 1}`;
    if (criterion.kind === 'field') {
      checkField(criterion, anchor, where);
      return;
    }
    const edge = edgeByKey(edges, criterion.edge);
    if (!edge) {
      errors.push(`${where}: unknown relationship “${criterion.edge}”.`);
      return;
    }
    // Relationship criteria have two execution paths now, and the validator
    // must not reject a spec the better one can run. Server-side predicates
    // (Mosaic ADR-0006 M5a/M5b) take the criterion whole; the semijoin
    // compensates only when the endpoint exposes no predicate for that edge.
    const onServer = supportsRelationship(anchor, criterion.edge, criterion.quantifier);
    if (!onServer && criterion.quantifier === 'none') {
      // "Having none" is an anti-join. The semijoin collects ids that DO match
      // and filters the anchor with `in`, which cannot express the negation, so
      // there is nothing to fall back to — this stays an error rather than
      // becoming a silently wrong result.
      errors.push(
        `${where}: “having none” needs a server-side relationship predicate for this edge. ` +
          `Declaring the inverting slot in the schema (Mosaic ADR-0011) provides one.`,
      );
    }
    if (!onServer && criterion.quantifier === 'some' && !ops.has('IN')) {
      errors.push(
        `${where}: this edge has no server-side predicate, so it compensates through the ` +
          `“in” operator — which this endpoint does not advertise either.`,
      );
    }
    const related = collections.find((c) => c.id === edge.relatedCollectionId);
    if (!related) {
      errors.push(`${where}: related collection “${edge.relatedCollectionId}” is gone.`);
      return;
    }
    criterion.criteria.forEach((sub) => checkField(sub, related, `${where} → ${related.label}`));
  });

  return { errors, warnings };
}
