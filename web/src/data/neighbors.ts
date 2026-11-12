import type { IntrospectionField, IntrospectionSchema } from './introspection';
import { findType, namedType, typeRefToSDL } from './introspection';

/**
 * The server tier of the graph view's data (ADR-0037): a `neighbors(id, depth)`
 * Query root returning a renderable subgraph — Mosaic's `NeighborhoodGraph`
 * (shipped in Mosaic v0.13.0, issue #158). Derived from introspection like
 * every other surface, and only a capability when the root's *shape* fits:
 * a name match alone is never one (ADR-0029). Endpoints without it keep the
 * client-side one-hop fallback.
 *
 * Wire contract (Mosaic `_neighbors_resolver`):
 *
 *   neighbors(id: ID!, depth: Int! = 1, asOf: String)
 *     → { nodes { entityId entityType data } edges { source target type }
 *         edgeSources notices }
 *
 * `asOf` is deliberately unused here: node-level time travel is a later
 * ADR-0037 step.
 */
export interface NeighborsModel {
  /** The Query field name. */
  field: string;
  idArg: string;
  idArgType: string;
  /** The depth arg, when advertised; the view always asks for one hop. */
  depthArg?: string;
  depthArgType?: string;
  nodes: string;
  nodeFields: { id: string; type: string; data: string };
  edges: string;
  edgeFields: { source: string; target: string; type: string };
  /** The server's disclosure of any bound it hit, when advertised. */
  notices?: string;
}

export interface NeighborhoodNode {
  id: string;
  /** The LinkML class name; null when the server could not resolve it. */
  type: string | null;
  data: Record<string, unknown>;
}

export interface NeighborhoodEdge {
  source: string;
  target: string;
  /** The referencing slot / relationship type. */
  type: string;
}

export interface Neighborhood {
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  notices: string[];
}

function field(fields: readonly IntrospectionField[], ...names: string[]) {
  return fields.find((f) => names.includes(f.name));
}

/**
 * The `neighbors` surface, or `undefined` when the endpoint doesn't offer a
 * usable one: the root must take an `id` and return a payload whose nodes
 * carry an id, a type and data, and whose edges carry source, target and type.
 */
export function deriveNeighborsModel(schema: IntrospectionSchema): NeighborsModel | undefined {
  const queryType = findType(schema, schema.queryType.name);
  const root = field(queryType?.fields ?? [], 'neighbors');
  if (!root) return undefined;
  const idArg = root.args.find((a) => a.name === 'id');
  if (!idArg) return undefined;
  // Any other required arg we don't know how to fill makes the root unusable.
  const depthArg = root.args.find((a) => a.name === 'depth');
  const unknownRequired = root.args.some(
    (a) =>
      a !== idArg && a !== depthArg && a.type.kind === 'NON_NULL' && a.defaultValue == null,
  );
  if (unknownRequired) return undefined;

  const payload = findType(schema, namedType(root.type).name);
  const nodes = field(payload?.fields ?? [], 'nodes');
  const edges = field(payload?.fields ?? [], 'edges');
  if (!nodes || !edges) return undefined;

  const nodeType = findType(schema, namedType(nodes.type).name);
  const nodeId = field(nodeType?.fields ?? [], 'entityId', 'entity_id');
  const nodeKind = field(nodeType?.fields ?? [], 'entityType', 'entity_type');
  const nodeData = field(nodeType?.fields ?? [], 'data');
  if (!nodeId || !nodeKind || !nodeData) return undefined;

  const edgeType = findType(schema, namedType(edges.type).name);
  const source = field(edgeType?.fields ?? [], 'source');
  const target = field(edgeType?.fields ?? [], 'target');
  const type = field(edgeType?.fields ?? [], 'type');
  if (!source || !target || !type) return undefined;

  return {
    field: root.name,
    idArg: idArg.name,
    idArgType: typeRefToSDL(idArg.type),
    depthArg: depthArg?.name,
    depthArgType: depthArg ? typeRefToSDL(depthArg.type) : undefined,
    nodes: nodes.name,
    nodeFields: { id: nodeId.name, type: nodeKind.name, data: nodeData.name },
    edges: edges.name,
    edgeFields: { source: source.name, target: target.name, type: type.name },
    notices: field(payload?.fields ?? [], 'notices')?.name,
  };
}

/** The one-hop neighborhood query for an entity. */
export function buildNeighborsQuery(
  model: NeighborsModel,
  id: string,
): { document: string; variables: Record<string, unknown> } {
  const varDefs = [`$id: ${model.idArgType}`];
  const args = [`${model.idArg}: $id`];
  const variables: Record<string, unknown> = { id };
  if (model.depthArg && model.depthArgType) {
    varDefs.push(`$depth: ${model.depthArgType}`);
    args.push(`${model.depthArg}: $depth`);
    variables.depth = 1;
  }
  const n = model.nodeFields;
  const e = model.edgeFields;
  const selection = [
    `${model.nodes} { ${n.id} ${n.type} ${n.data} }`,
    `${model.edges} { ${e.source} ${e.target} ${e.type} }`,
    model.notices ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    document: `query ApertureNeighbors(${varDefs.join(', ')}) { ${model.field}(${args.join(', ')}) { ${selection} } }`,
    variables,
  };
}

/** Normalizes the raw payload into the view's neighborhood shape. */
export function normalizeNeighborhood(model: NeighborsModel, raw: unknown): Neighborhood {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(payload[model.nodes]) ? (payload[model.nodes] as unknown[]) : [];
  const rawEdges = Array.isArray(payload[model.edges]) ? (payload[model.edges] as unknown[]) : [];
  const nodes: NeighborhoodNode[] = [];
  for (const item of rawNodes) {
    const node = (item ?? {}) as Record<string, unknown>;
    const id = node[model.nodeFields.id];
    if (id == null) continue;
    const type = node[model.nodeFields.type];
    let data = node[model.nodeFields.data];
    // A JSON scalar may arrive serialized, depending on the server's encoder.
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = {};
      }
    }
    nodes.push({
      id: String(id),
      type: type == null ? null : String(type),
      data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    });
  }
  const edges: NeighborhoodEdge[] = [];
  for (const item of rawEdges) {
    const edge = (item ?? {}) as Record<string, unknown>;
    const source = edge[model.edgeFields.source];
    const target = edge[model.edgeFields.target];
    if (source == null || target == null) continue;
    edges.push({
      source: String(source),
      target: String(target),
      type: String(edge[model.edgeFields.type] ?? ''),
    });
  }
  const rawNotices = model.notices ? payload[model.notices] : undefined;
  const notices = Array.isArray(rawNotices) ? rawNotices.map(String) : [];
  return { nodes, edges, notices };
}
