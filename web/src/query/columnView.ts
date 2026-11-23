import type { CollectionModel, ColumnModel } from '../data/schemaModel';
import { slotName } from '../data/schemaModel';
import type { ManyMode, PathColumn } from '../data/selection';
import { MAX_PATH_HOPS, capExplode, pathLabel } from '../data/selection';
import type { ColumnSpec, DroppedColumn, QueryEdge } from './querySpec';
import { deriveEdges, translateColumns } from './querySpec';

/**
 * The `cols` URL parameter (ADR-0041 sub-question, aperture#73).
 *
 * Both halves of the column control ride one parameter, because a shared link
 * has to reproduce both: the *query* half (which traversals, and each one's
 * grain) and the *view* half (which anchor fields are hidden). They stay
 * separate keys here so each can graduate to its own artifact without a
 * migration -- ADR-0041's 2026-09-25 correction: the two separate when either
 * half first needs to persist.
 *
 * Schema-unaware on purpose, like the `qs` validator: nuqs calls it with no app
 * context. Resolution against the schema happens in `decodeColumns`.
 */
export interface ColumnsParam {
  /** Chosen traversals: GraphQL field path from the anchor, plus grain for to-many. */
  paths?: { path: string[]; mode?: ManyMode }[];
  /**
   * Anchor fields the reader hid. A HIDE set, not a show set: an anchor field
   * added to the schema later must still show by default.
   */
  hidden?: string[];
}

const MODES: readonly string[] = ['count', 'joinIds', 'explode'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

export function validateColumnsShape(value: unknown): ColumnsParam {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new Error('not a columns spec');
  }
  const { paths, hidden } = value as Record<string, unknown>;
  if (hidden !== undefined && !isStringArray(hidden)) throw new Error('hidden must be strings');
  if (paths !== undefined) {
    if (!Array.isArray(paths)) throw new Error('paths must be a list');
    for (const p of paths) {
      const entry = p as { path?: unknown; mode?: unknown };
      if (typeof p !== 'object' || p == null || !isStringArray(entry.path) || entry.path.length === 0) {
        throw new Error('bad path entry');
      }
      if (entry.mode !== undefined && !MODES.includes(entry.mode as string)) {
        throw new Error('bad mode');
      }
    }
  }
  return value as ColumnsParam;
}

/** `null` when there is nothing to carry, so the default state leaves the URL clean. */
export function encodeColumns(
  pathColumns: PathColumn[],
  hiddenFields: ReadonlySet<string>,
): ColumnsParam | null {
  const out: ColumnsParam = {};
  if (pathColumns.length > 0) {
    out.paths = pathColumns.map((c) => (c.many ? { path: c.path, mode: c.many.mode } : { path: c.path }));
  }
  if (hiddenFields.size > 0) out.hidden = [...hiddenFields].sort();
  return out.paths || out.hidden ? out : null;
}

/** A path resolved against the live schema, hop by hop. */
export interface ResolvedPath {
  path: string[];
  column: ColumnModel;
  label: string;
  /** The edge taken at each hop, anchor first. */
  edges: QueryEdge[];
  /** 1-based hop that is to-many, or null when every hop is to-one. */
  manyAt: number | null;
  /** `Aliquot.volume_ul`, `Sample.Donor.age_at_death` -- see `PathColumn.exportName`. */
  exportName: string;
}

/**
 * Resolve a GraphQL field path (`inputSamples.donor.ageAtDeath`) against the
 * schema, following only edges `deriveEdges` offers with a selectable field.
 *
 * Returns null -- never a guess -- when a hop does not resolve, when the path
 * is longer than `MAX_PATH_HOPS`, or when it crosses MORE THAN ONE to-many
 * hop. Two lists on one path is a list of lists: neither "one row each" nor a
 * joined summary has a single meaning for it, so it is not offered (ADR-0041).
 *
 * The picker and the URL decoder both go through this, so a column the picker
 * can build is exactly a column a shared link can restore.
 */
export function resolvePath(
  path: string[],
  anchor: CollectionModel,
  collections: CollectionModel[],
): ResolvedPath | null {
  const hops = path.length - 1;
  if (hops < 1 || hops > MAX_PATH_HOPS) return null;
  let current = anchor;
  const edges: QueryEdge[] = [];
  const classes: string[] = [];
  let manyAt: number | null = null;
  for (let i = 0; i < hops; i += 1) {
    const edge = deriveEdges(current, collections).find((e) => e.selectField === path[i]);
    const next = edge && collections.find((c) => c.id === edge.relatedCollectionId);
    if (!edge || !next) return null;
    if (edge.toMany) {
      if (manyAt != null) return null;
      manyAt = i + 1;
    }
    edges.push(edge);
    classes.push(next.typeName);
    current = next;
  }
  const column = current.detailColumns.find((c) => c.field === path[hops]);
  if (!column) return null;
  return {
    path,
    column,
    label: pathLabel(path, anchor, collections),
    edges,
    manyAt,
    exportName: [...classes, column.slot ?? slotName(column.field)].join('.'),
  };
}

/**
 * The column a resolved path becomes. A path through a list defaults to
 * `count`, never `explode`: a grain change is asked for, not arrived at.
 */
export function toPathColumn(resolved: ResolvedPath, mode?: ManyMode): PathColumn {
  const { path, column, label, edges, manyAt, exportName } = resolved;
  return {
    path,
    column,
    label,
    exportName,
    many:
      manyAt == null
        ? undefined
        : { mode: mode ?? 'count', edgeLabel: edges[manyAt - 1].label, depth: manyAt },
  };
}

/**
 * Resolve a decoded parameter against the live schema.
 *
 * Anything that no longer resolves -- a renamed field, a gated reverse edge, a
 * hidden field the anchor lost -- is dropped rather than guessed at, so a stale
 * link degrades to fewer columns and not to a failed query (ADR-0029). Paths
 * resolve through `resolvePath`, exactly as the picker builds them.
 */
export function decodeColumns(
  param: ColumnsParam | null | undefined,
  anchor: CollectionModel | undefined,
  collections: CollectionModel[],
): { pathColumns: PathColumn[]; hiddenFields: Set<string> } {
  const empty = { pathColumns: [] as PathColumn[], hiddenFields: new Set<string>() };
  if (!param || !anchor) return empty;

  const hiddenFields = new Set((param.hidden ?? []).filter((f) => anchor.columns.some((c) => c.field === f)));
  const pathColumns: PathColumn[] = [];
  const seen = new Set<string>();

  for (const { path, mode } of param.paths ?? []) {
    const key = path.join('.');
    if (seen.has(key)) continue;
    const resolved = resolvePath(path, anchor, collections);
    if (!resolved) continue;
    seen.add(key);
    pathColumns.push(toPathColumn(resolved, mode));
  }
  // One exploded LINK at most (ADR-0041 v1 cap). A sibling on that link keeps
  // its own mode: `cols` may hold a proposal's mixed modes, which Mosaic
  // accepts, and a reload must show the same table (aperture#89 review).
  return { pathColumns: capExplode(pathColumns), hiddenFields };

}

/**
 * What a proposal's `columns` (slot-spelled, aperture#89) become in the builder.
 *
 * - A traversal (two or three segments) becomes a `PathColumn`, resolved
 *   through `resolvePath` exactly as the picker and the `cols` decoder do, so
 *   a proposal can only produce columns a user could have picked.
 * - An anchor slot (one segment) is not a path column: anchor fields already
 *   show by default, so it is returned in `showFields` for the caller to
 *   clear from `hiddenFields`.
 * - Anything that does not resolve is returned in `dropped` with its reason,
 *   for the caller to show (ADR-0029: listed, never silent).
 *
 * The one-exploded-link cap is applied last (`capExplode`). It never
 * promotes: Mosaic accepts `explode` beside `joinIds`/`count` on one link and
 * its rules win, so each column keeps the proposal's mode. Mosaic refuses a
 * second exploded link already, so on a validated proposal the cap changes
 * nothing.
 */
export function seedFromProposal(
  columns: ColumnSpec[],
  anchor: CollectionModel,
  collections: CollectionModel[],
): { pathColumns: PathColumn[]; showFields: string[]; dropped: DroppedColumn[] } {
  const pathColumns: PathColumn[] = [];
  const showFields: string[] = [];
  const dropped: DroppedColumn[] = [];
  const seen = new Set<string>();

  for (const spec of columns) {
    const { columns: [translated], dropped: [miss] } = translateColumns([spec], 'field', anchor, collections);
    if (miss) {
      dropped.push(miss);
      continue;
    }
    if (!translated) continue;
    const key = translated.path.join('.');
    if (seen.has(key)) continue;
    seen.add(key);

    if (translated.path.length === 1) {
      const field = translated.path[0]!;
      if (anchor.columns.some((c) => c.field === field)) showFields.push(field);
      else {
        dropped.push({
          path: spec.path,
          reason: `${anchor.label} shows “${spec.path[0]}” on its record page only, not in the result table.`,
        });
      }
      continue;
    }
    const resolved = resolvePath(translated.path, anchor, collections);
    if (!resolved) {
      dropped.push({
        path: spec.path,
        reason: 'This path cannot be read into the table (it crosses more than one list, or a hop has no field to select through).',
      });
      continue;
    }
    pathColumns.push(toPathColumn(resolved, spec.mode));
  }
  return { pathColumns: capExplode(pathColumns), showFields, dropped };
}

/**
 * The builder's current column choices as a slot-spelled `columns` list, for
 * the conversational wire (aperture#89 round trip).
 *
 * `shownFields` are the anchor slots a proposal named that the reader has not
 * since hidden; path columns follow in table order. A to-many path carries
 * its mode, as Mosaic requires; a to-one path carries none, as it also
 * requires. The `cols` URL parameter keeps its GraphQL spelling; only this
 * wire form uses slot names.
 */
export function wireColumns(
  shownFields: string[],
  pathColumns: PathColumn[],
  anchor: CollectionModel,
  collections: CollectionModel[],
): ColumnSpec[] {
  const specs: ColumnSpec[] = [
    ...shownFields.map((f) => ({ path: [f] })),
    // A family's Kind column (`__typename`) is not a slot: it stays off the wire (ADR-0042).
    ...pathColumns
      .filter((c) => !c.column.synthetic)
      .map((c) => (c.many ? { path: c.path, mode: c.many.mode } : { path: c.path })),
  ];
  return translateColumns(specs, 'slot', anchor, collections).columns;
}
