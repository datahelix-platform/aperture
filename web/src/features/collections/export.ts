import type { FilterCondition, FilterValues, MosaicSource } from '../../data/mosaicSource';
import type { CollectionModel, ColumnModel } from '../../data/schemaModel';
import type { DisplayRow, PathColumn } from '../../data/selection';
import { pathKey } from '../../data/selection';
import { valueText } from '../../data/valueText';

/**
 * Export (R3.10, L8): client-side page-through of the current filtered set →
 * CSV or JSON over the derived columns. No server dependency (server bulk
 * export is Hippo X2, deferred). The page-through is capped and the cap is
 * reported — a truncated export always says so (ADR-0029).
 */
export const EXPORT_CAP = 5000;
const EXPORT_PAGE_SIZE = 100;

export interface CollectedRows {
  rows: Record<string, unknown>[];
  /** True when the cap cut the set short — surfaced to the user, never silent. */
  truncated: boolean;
}

export async function collectAllRows(
  source: MosaicSource,
  collection: CollectionModel,
  filters: FilterValues,
  search: string,
  cap: number = EXPORT_CAP,
  orderBy?: { field: string; dir?: 'ASC' | 'DESC' },
  /** Active range-facet conditions (issue #61) — exports inherit them too. */
  conditions?: FilterCondition[],
): Promise<CollectedRows> {
  // Without offset pagination the first fetch is all the endpoint offers.
  if (!source.capabilities.offsetPagination) {
    const page = await source.listEntities(collection.id, {
      page: 1,
      pageSize: EXPORT_PAGE_SIZE,
      filters,
      conditions,
      search,
      orderBy,
    });
    return { rows: page.rows.slice(0, cap), truncated: page.rows.length > cap };
  }

  const rows: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const result = await source.listEntities(collection.id, {
      page,
      pageSize: EXPORT_PAGE_SIZE,
      filters,
      conditions,
      search,
      orderBy,
    });
    rows.push(...result.rows);
    if (rows.length >= cap) return { rows: rows.slice(0, cap), truncated: result.mayHaveMore || rows.length > cap };
    if (!result.mayHaveMore) return { rows, truncated: false };
    page += 1;
  }
}

function csvEscape(field: string): string {
  return /[",\n\r]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

export function toCSV(columns: ColumnModel[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => csvEscape(valueText(c, row[c.field]))).join(','),
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}

export function toJSONExport(
  rows: Record<string, unknown>[],
  columns?: ColumnModel[],
): string {
  // Projecting is opt-in so every existing caller keeps exporting whole rows.
  // When columns ARE given, the export must match what the user chose to see:
  // a JSON file carrying fields they hid would quietly contradict the screen,
  // and CSV already honours the selection.
  if (!columns) return JSON.stringify(rows, null, 2);
  const fields = columns.map((c) => c.field);
  const projected = rows.map((row) =>
    Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f]])),
  );
  return JSON.stringify(projected, null, 2);
}

export function downloadFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * CSV over path-addressed columns and already-flattened rows (ADR-0041).
 *
 * Separate from `toCSV` rather than a widening of it: that one is keyed by
 * `column.field` and serves the ordinary collection table, where a row is an
 * entity. Here a row may be an anchor × member pair, the header is the path
 * label ("Donor → Cohort"), and the cell value was resolved upstream by the
 * flattener — including the `count`/`joinIds` summaries, which have no
 * representation in a `ColumnModel`.
 */
/**
 * Column names for an exported file: `exportName` (`sample_type`,
 * `Aliquot.volume_ul`, `Sample.Donor.age_at_death`), the dotted convention R and
 * pandas expect. Two columns that would share a name -- two links reaching the
 * same class, say `inputs` and `outputs` both to Sample -- fall back to their
 * GraphQL path (`inputs.sampleType`), so no header is ever ambiguous.
 */
export function exportHeaders(columns: PathColumn[]): string[] {
  const names = columns.map((c) => c.exportName ?? c.label);
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return names.map((n, i) => ((counts.get(n) ?? 0) > 1 ? pathKey(columns[i].path) : n));
}

export function toCSVPaths(columns: PathColumn[], rows: DisplayRow[]): string {
  const header = exportHeaders(columns).map(csvEscape).join(',');
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const value = row.values[pathKey(c.path)];
        if (value == null) return '';
        // `count` and `joinIds` were summarised to a number or text by the
        // flattener; any other cell still holds the leaf's own value, which may
        // be a reference envelope or a structured object.
        if (c.many?.mode === 'count' || c.many?.mode === 'joinIds') return csvEscape(String(value));
        return csvEscape(valueText(c.column, value));
      })
      .join(','),
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}

/**
 * JSON export of the same rows, keyed by path.
 *
 * Deliberately keyed by `pathKey` (`donor.cohort`) rather than the leaf name:
 * two traversals can end in the same leaf — `donor.name` and `storageLocation.name`
 * — and collapsing them to `name` would silently drop one column from the file
 * while both remain on screen.
 */
export function toJSONExportPaths(columns: PathColumn[], rows: DisplayRow[]): string {
  const keys = exportHeaders(columns);
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(columns.map((c, i) => [keys[i], row.values[pathKey(c.path)] ?? null])),
    ),
    null,
    2,
  );
}
