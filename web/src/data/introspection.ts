/**
 * Standard GraphQL `__schema` introspection — the generic baseline every
 * conformant endpoint supports (ADR-0017). Mosaic's `mosaicSchema` /
 * `mosaicEntityType` enrichment layers on top when advertised (its presence is
 * detected here; richer enrichment is a Phase-1 concern once its query shape
 * is confirmed against a live `mosaic serve`).
 */

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}

export interface IntrospectionInputValue {
  name: string;
  type: TypeRef;
  /**
   * GraphQL-literal default, when declared. Per the GraphQL spec an
   * argument is only *required* when NON_NULL **and** defaultless — e.g.
   * Mosaic's `orderDir: OrderDirection! = ASC` needs no value from us.
   */
  defaultValue?: string | null;
}

export interface IntrospectionField {
  name: string;
  description?: string | null;
  args: IntrospectionInputValue[];
  type: TypeRef;
}

export interface IntrospectionType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: IntrospectionField[] | null;
  /** For INPUT_OBJECT types (e.g. filter inputs) — feeds facet derivation. */
  inputFields?: IntrospectionInputValue[] | null;
  enumValues?: { name: string }[] | null;
  /**
   * For INTERFACE types: the object types implementing it. Standard
   * introspection (ADR-0017). Mosaic emits an interface per family, an
   * abstract class with exposed kinds (Mosaic ADR-0014), so this is the
   * family's kinds (ADR-0042).
   */
  possibleTypes?: { name: string }[] | null;
}

export interface IntrospectionSchema {
  queryType: { name: string };
  mutationType?: { name: string } | null;
  types: IntrospectionType[];
}

export interface IntrospectionData {
  __schema: IntrospectionSchema;
}

/** Nested-list depth we resolve type refs to (spec-typical is 7 levels). */
const TYPE_REF_DEPTH = 7;

function typeRefSelection(depth: number): string {
  return depth === 0 ? 'kind name' : `kind name ofType { ${typeRefSelection(depth - 1)} }`;
}

export const INTROSPECTION_QUERY = `
  query ApertureIntrospection {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
        fields {
          name
          description
          args { name defaultValue type { ${typeRefSelection(TYPE_REF_DEPTH)} } }
          type { ${typeRefSelection(TYPE_REF_DEPTH)} }
        }
        inputFields { name type { ${typeRefSelection(TYPE_REF_DEPTH)} } }
        enumValues { name }
        possibleTypes { name }
      }
    }
  }
`;

/** Unwraps NON_NULL wrappers only. */
export function unwrapNonNull(ref: TypeRef): TypeRef {
  return ref.kind === 'NON_NULL' && ref.ofType ? unwrapNonNull(ref.ofType) : ref;
}

/** Unwraps NON_NULL and LIST wrappers down to the named type. */
export function namedType(ref: TypeRef): TypeRef {
  return (ref.kind === 'NON_NULL' || ref.kind === 'LIST') && ref.ofType
    ? namedType(ref.ofType)
    : ref;
}

/** True when the (non-null-unwrapped) type is a list. */
export function isListType(ref: TypeRef): boolean {
  return unwrapNonNull(ref).kind === 'LIST';
}

export function findType(
  schema: IntrospectionSchema,
  name: string | null,
): IntrospectionType | undefined {
  if (name == null) return undefined;
  return schema.types.find((t) => t.name === name);
}

/** Renders a type ref back to SDL notation (for variable definitions). */
export function typeRefToSDL(ref: TypeRef): string {
  if (ref.kind === 'NON_NULL' && ref.ofType) return `${typeRefToSDL(ref.ofType)}!`;
  if (ref.kind === 'LIST' && ref.ofType) return `[${typeRefToSDL(ref.ofType)}]`;
  return ref.name ?? 'String';
}

/**
 * Mosaic's own LinkML type model, exposed as `mosaicSchema` (Mosaic ADR-0009).
 *
 * Standard `__schema` carries a description on each TYPE but — verified against a live
 * endpoint — `null` on every FIELD, because the generated object types do not propagate
 * slot descriptions. The per-slot prose a curator wrote, the true LinkML range, whether a
 * slot is required, and what a reference points at all live here instead.
 *
 * `deriveCollections` detects this field's presence already and records it as
 * `capabilities.schemaIntrospection`; this is the query that detection was waiting for
 * (see this file's header note about enrichment being a later concern — the query shape is
 * now confirmed against a live server).
 *
 * Named `hippoSchema` until Mosaic v0.16.0, which renamed it per platform ADR-0007 (Q3).
 */
export const MOSAIC_SCHEMA_QUERY = `
  query ApertureSlotEnrichment {
    mosaicSchema {
      name
      accessorName
      description
      fields {
        name
        kind
        range
        role
        required
        multivalued
        identifier
        description
        targetEntityType
        enumName
        enumValues
      }
    }
  }
`;

/** One slot of an entity type, as Mosaic's shared LinkML type model classifies it. */
export interface SlotInfo {
  name: string;
  /** scalar | enum | reference | structured */
  kind: string;
  /** The raw LinkML range — `integer`, `string`, `CohortEnum`, `Workflow`. */
  range: string;
  /** user | system — a user's own fields vs the ones the runtime supplies. */
  role: string;
  required: boolean;
  multivalued: boolean;
  identifier: boolean;
  description: string | null;
  targetEntityType: string | null;
  enumName: string | null;
  enumValues: readonly string[];
}

export interface EntityTypeInfo {
  name: string;
  accessorName: string;
  description: string | null;
  fields: readonly SlotInfo[];
}

export interface SlotEnrichmentData {
  mosaicSchema: readonly EntityTypeInfo[];
}

/**
 * Slot enrichment keyed by entity type name, then by slot name.
 *
 * `undefined` throughout when the endpoint does not advertise `mosaicSchema`, or when the
 * query fails. Every consumer must read it as optional: an endpoint without it has to keep
 * working exactly as it did (ADR-0029 honest degradation).
 */
export type SlotEnrichment = ReadonlyMap<string, ReadonlyMap<string, SlotInfo>>;

export function indexSlotEnrichment(data: SlotEnrichmentData | null | undefined): SlotEnrichment | undefined {
  if (!data?.mosaicSchema) return undefined;
  const byType = new Map<string, ReadonlyMap<string, SlotInfo>>();
  for (const entity of data.mosaicSchema) {
    byType.set(entity.name, new Map(entity.fields.map((f) => [f.name, f])));
  }
  return byType;
}
