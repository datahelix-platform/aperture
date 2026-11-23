import type { CollectionModel, ColumnModel } from './schemaModel';
import { humanize } from './schemaModel';
import { valueText } from './valueText';

/**
 * Path-addressed result columns and the GraphQL selection they compile to
 * (ADR-0041).
 *
 * A `ColumnSpec` in ADR-0041's sense is a path from the anchor: `['donor',
 * 'cohort']` reads the cohort of a Sample's Donor. Mosaic's references are
 * edge-only (its ADR-0005) — the raw foreign key is not a GraphQL field — so a
 * referenced value is reachable ONLY through a nested selection, which is why
 * this module exists at all rather than the table reading a flat row.
 *
 * The split ADR-0041 draws lives here: this file decides **what is fetched**
 * (traversal, and whether a to-many hop changes the grain). Which of the
 * fetched paths a reader currently sees is view state and is not this file's
 * business — hiding a column must never change the query.
 */

/** How a to-many hop resolves. `explode` is the only one that changes grain. */
export type ManyMode = 'count' | 'joinIds' | 'explode';

export interface PathColumn {
  /**
   * GraphQL field names from the anchor down to the leaf — the wire spelling
   * (`donor`, not `donor_id`), because this is a client-side projection
   * instruction that never travels as a filter. Length 1 is an anchor slot.
   */
  path: string[];
  /** The leaf column: carries kind/label/enumValues for rendering and export. */
  column: ColumnModel;
  /** Path-labelled for the header, e.g. "Donor → Cohort" (cross-class-query §8). */
  label: string;
  /**
   * Set when some hop on the path is to-many. `count` and `joinIds` keep anchor
   * grain; `explode` changes it, and ADR-0041 requires that be explicit and
   * stated on screen.
   */
  many?: {
    mode: ManyMode;
    /** The edge's own label, so a grain note names the relationship. */
    edgeLabel?: string;
    /**
     * How many path segments lead up to and include the to-many hop. A
     * one-hop column (`aliquots.volumeUl`) has depth 1; a two-hop column whose
     * list is the first hop (`inputSamples.donor.ageAtDeath`) also has depth
     * 1; one whose list is the second hop (`donor.diagnoses.conditionName`)
     * has depth 2. Absent means "the hop just before the leaf", which is what
     * every one-hop column already was. At most ONE hop on a path is to-many.
     */
    depth?: number;
  };
  /**
   * The column's name in exported files: anchor fields by slot
   * (`sample_type`), traversed ones by the classes they pass through plus the
   * slot (`Aliquot.volume_ul`, `Sample.Donor.age_at_death`). The screen keeps
   * the arrow label; a file goes to R or pandas, where a dotted name is the
   * convention and an arrow is a nuisance. Falls back to `label`.
   */
  exportName?: string;
}

/** Segments up to and including the to-many hop (see `PathColumn.many.depth`). */
export function manyDepth(column: PathColumn): number {
  return column.many?.depth ?? column.path.length - 1;
}

/**
 * Identifies the to-many LINK a column reads through, e.g. `aliquots` or
 * `inputSamples`. Every column through one link shares it, which is what
 * makes "one row each" a property of the link rather than of a column:
 * exploding `aliquots.containerType` and `aliquots.isDepleted` is one row per
 * aliquot, not a cross product, and the two must never disagree.
 */
export function explodeKey(column: PathColumn): string | null {
  if (!column.many) return null;
  return pathKey(column.path.slice(0, manyDepth(column)));
}

/**
 * Enforce the one-exploded-link cap (ADR-0041 v1) by LINK, not by column.
 *
 * `prefer` names the link the user just chose; otherwise the first exploded
 * column wins. Columns through the winning link all explode together; any
 * column exploding through a different link is demoted to `count`.
 */
export function normalizeExplode(columns: PathColumn[], prefer?: string | null): PathColumn[] {
  const winner =
    prefer ?? columns.map((c) => (c.many?.mode === 'explode' ? explodeKey(c) : null)).find((k) => k != null) ?? null;
  return columns.map((c) => {
    if (!c.many) return c;
    const key = explodeKey(c);
    if (winner != null && key === winner && c.many.mode !== 'explode') {
      return { ...c, many: { ...c.many, mode: 'explode' } };
    }
    if (c.many.mode === 'explode' && key !== winner) {
      return { ...c, many: { ...c.many, mode: 'count' } };
    }
    return c;
  });
}

/**
 * The one-exploded-link cap WITHOUT promotion (aperture#89 review).
 *
 * For columns that arrive already moded — a proposal, or `cols` restored from
 * a link — rather than chosen in the builder. Mosaic accepts `explode` and
 * `joinIds`/`count` on the same link, and Mosaic's rules win, so a sibling
 * keeps the mode it came with. Only an `explode` through a second link is
 * demoted to `count` (the first exploded link wins).
 */
export function capExplode(columns: PathColumn[]): PathColumn[] {
  const winner =
    columns.map((c) => (c.many?.mode === 'explode' ? explodeKey(c) : null)).find((k) => k != null) ?? null;
  return columns.map((c) =>
    c.many?.mode === 'explode' && explodeKey(c) !== winner ? { ...c, many: { ...c.many, mode: 'count' } } : c,
  );
}

/** Depth cap: 2 hops, well inside Mosaic's `DEFAULT_MAX_QUERY_DEPTH` of 10. */
export const MAX_PATH_HOPS = 2;

interface SelectionNode {
  /** Scalar leaves selected at this level. */
  leaves: Set<string>;
  /** Nested object selections, keyed by GraphQL field name. */
  children: Map<string, SelectionNode>;
}

function emptyNode(): SelectionNode {
  return { leaves: new Set(), children: new Map() };
}

function refColumn(collection: CollectionModel, field: string): ColumnModel | undefined {
  return collection.detailColumns.find(
    (c) => c.field === field && (c.kind === 'ref' || c.kind === 'refList'),
  );
}

function targetOf(
  collection: CollectionModel,
  field: string,
  collections: CollectionModel[],
): CollectionModel | undefined {
  const ref = refColumn(collection, field);
  return ref?.targetType ? collections.find((c) => c.typeName === ref.targetType) : undefined;
}

/**
 * Merge every path into one selection tree.
 *
 * Merging is the point: two chosen donor fields must compile to
 * `donor { cohort ageAtDeath }`, not to two sibling `donor` selections, which
 * GraphQL would accept and the server would answer twice.
 */
export function buildSelectionTree(
  paths: PathColumn[],
  anchor: CollectionModel,
  collections: CollectionModel[],
): SelectionNode {
  const root = emptyNode();

  for (const { path } of paths) {
    if (path.length === 0 || path.length > MAX_PATH_HOPS + 1) continue;
    let node = root;
    let collection: CollectionModel | undefined = anchor;

    for (let i = 0; i < path.length - 1; i += 1) {
      const next: CollectionModel | undefined = collection && targetOf(collection, path[i], collections);
      // An unresolvable hop is dropped rather than guessed at: emitting a
      // nested selection for a field we cannot type would fail server-side
      // validation with a less legible error than simply not offering it.
      if (!next) { node = emptyNode(); break; }
      let child = node.children.get(path[i]);
      if (!child) {
        child = emptyNode();
        node.children.set(path[i], child);
        // Every nested object carries its own identifier. Row-click navigation,
        // `joinIds` and stable row keys all read it, and it is cheap.
        if (next.idColumn) child.leaves.add(next.idColumn);
        // A family member names its kind, for its link (ADR-0042).
        if (next.family) child.leaves.add('__typename');
      }
      node = child;
      collection = next;
    }

    const leaf = path[path.length - 1];
    const leafColumn = collection?.detailColumns.find((c) => c.field === leaf);
    if (leafColumn && (leafColumn.kind === 'ref' || leafColumn.kind === 'refList')) {
      // A reference chosen as a leaf (rendered as its id, or joined for
      // `joinIds`) still needs an object selection — there is no scalar to ask
      // for under edge-only emission.
      const child = node.children.get(leaf) ?? emptyNode();
      if (leafColumn.targetIdField) child.leaves.add(leafColumn.targetIdField);
      if (leafColumn.targetIsFamily) child.leaves.add('__typename');
      node.children.set(leaf, child);
    } else {
      node.leaves.add(leaf);
    }
  }
  return root;
}

export function renderSelection(node: SelectionNode): string {
  const parts = [...node.leaves];
  for (const [field, child] of node.children) {
    parts.push(`${field} { ${renderSelection(child)} }`);
  }
  return parts.join(' ');
}

/** The extra selection a set of paths needs beyond the anchor's own columns. */
export function selectionForPaths(
  paths: PathColumn[],
  anchor: CollectionModel,
  collections: CollectionModel[],
): string {
  return renderSelection(buildSelectionTree(paths, anchor, collections));
}

/**
 * Read a path out of a row, following nested objects. `undefined` when any hop
 * is absent — which a masked field or an unset reference both produce, and
 * which the caller renders as "—" rather than an error (ADR-0029).
 */
export function valueAtPath(row: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = row;
  for (const segment of path) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** "Donor → Cohort": the path made legible, per cross-class-query.md §8. */
export function pathLabel(
  path: string[],
  anchor: CollectionModel,
  collections: CollectionModel[],
): string {
  const parts: string[] = [];
  let collection: CollectionModel | undefined = anchor;
  for (let i = 0; i < path.length - 1; i += 1) {
    const ref = collection && refColumn(collection, path[i]);
    parts.push(ref?.targetType ? humanize(ref.targetType) : humanize(path[i]));
    collection = collection && targetOf(collection, path[i], collections);
  }
  const leaf = collection?.detailColumns.find((c) => c.field === path[path.length - 1]);
  parts.push(leaf?.label ?? humanize(path[path.length - 1]));
  return parts.join(' → ');
}

/**
 * One row of the rendered table. `values` is keyed by `pathKey`, already read
 * through every hop, so the renderer does no traversal of its own.
 */
export interface DisplayRow {
  key: string;
  values: Record<string, unknown>;
  /** The anchor entity's id — row-click navigation always targets the anchor. */
  anchorId?: string;
  /** The anchor's `__typename`, when selected: a family row's kind (ADR-0042). */
  anchorKind?: string;
}

export interface FlattenResult {
  rows: DisplayRow[];
  /**
   * Set only when a path exploded. ADR-0041 requires the grain change be
   * stated wherever the rows are: a total that counts anchors sitting above a
   * table that counts pairs is a lie about what the reader is looking at.
   */
  grain?: { anchorCount: number; rowCount: number; edgeLabel: string };
}

export function pathKey(path: string[]): string {
  return path.join('.');
}

/**
 * Anchor rows → display rows, applying each to-many path's declared mode.
 *
 * `count` and `joinIds` keep anchor grain. `explode` does not: one display row
 * per member of the exploded path, with the anchor's own values repeated down
 * the block — the repetition the feature exists to produce.
 *
 * **At most one path may explode** (v1 cap, ADR-0041). Two exploded to-many
 * paths is a cartesian product with no user model behind it, so a second one
 * is ignored rather than silently multiplying the row count.
 */
export function flattenRows(
  rows: Record<string, unknown>[],
  columns: PathColumn[],
  anchorIdField?: string,
): FlattenResult {
  const exploded = columns.find((c) => c.many?.mode === 'explode');
  const explodeAt = exploded ? explodeKey(exploded) : null;
  const explodePath = exploded ? exploded.path.slice(0, manyDepth(exploded)) : null;

  const read = (row: Record<string, unknown>, column: PathColumn): unknown => {
    if (!column.many) return valueAtPath(row, column.path);
    // A to-many path kept at anchor grain resolves to a scalar summary. The
    // members are already in hand, so neither mode costs a round trip. The
    // list may sit at any hop: everything after it is read per member, so
    // `inputSamples.donor.ageAtDeath` lists each input sample's donor's age.
    const depth = manyDepth(column);
    const members = valueAtPath(row, column.path.slice(0, depth));
    const list = Array.isArray(members) ? members : [];
    if (column.many.mode === 'count') return list.length;
    const rest = column.path.slice(depth);
    // Each member's value as text for the leaf column, so a reference lists
    // its id and a structured value its fields rather than vanishing.
    return list
      .map((m) => (m == null ? '' : valueText(column.column, valueAtPath(m as Record<string, unknown>, rest))))
      .filter((v) => v !== '')
      .join('; ');
  };

  const out: DisplayRow[] = [];
  for (const [i, row] of rows.entries()) {
    const anchorId = anchorIdField ? row[anchorIdField] : undefined;
    const kind = row['__typename'];
    const anchorKind = typeof kind === 'string' ? { anchorKind: kind } : {};
    const baseKey = anchorId != null ? String(anchorId) : `row-${i}`;

    if (!explodePath) {
      out.push({
        key: baseKey,
        anchorId: anchorId == null ? undefined : String(anchorId),
        ...anchorKind,
        values: Object.fromEntries(columns.map((c) => [pathKey(c.path), read(row, c)])),
      });
      continue;
    }

    const members = valueAtPath(row, explodePath);
    const list = Array.isArray(members) ? members : [];
    // An anchor with no members still gets one row. Dropping it would silently
    // turn an explode into a filter — the table would stop agreeing with the
    // result total for a reason nothing on screen explains.
    const slots = list.length > 0 ? list : [null];

    slots.forEach((member, m) => {
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        // Every EXPLODED column through the exploded link reads from this
        // member, so two of them always describe the same related record. A
        // `count`/`joinIds` column on the same link (a proposal may mix them,
        // and Mosaic accepts it) keeps its own mode: the anchor's summary.
        const onExplodedPath = column.many?.mode === 'explode' && explodeKey(column) === explodeAt;
        if (onExplodedPath) {
          const rest = column.path.slice(explodePath.length);
          values[pathKey(column.path)] =
            member == null ? undefined : valueAtPath(member as Record<string, unknown>, rest);
        } else {
          values[pathKey(column.path)] = read(row, column);
        }
      }
      // Composite key: the anchor id alone collides across exploded siblings.
      out.push({
        key: `${baseKey}#${m}`,
        anchorId: anchorId == null ? undefined : String(anchorId),
        ...anchorKind,
        values,
      });
    });
  }

  if (!exploded) return { rows: out };
  return {
    rows: out,
    grain: {
      anchorCount: rows.length,
      rowCount: out.length,
      // The edge, not the column: "Samples" reads better than
      // "Sample → Accession" when describing what a row now is.
      edgeLabel: exploded.many?.edgeLabel ?? exploded.label,
    },
  };
}
