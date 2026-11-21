import { useMemo } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useCapabilities } from '../../data/DataSourceContext';
import type { MosaicSource } from '../../data/mosaicSource';
import type { CollectionModel } from '../../data/schemaModel';
import { typeColorStyle } from '../../data/typeColor';
import { isRightAligned, renderCell } from './cells';
import { ExportButtons } from './ExportButtons';
import { SaveViewButton } from './SaveViewButton';
import { rangeConditions, useCollectionUrlState } from './urlState';
import { useEntityPage } from './useEntityPage';
import './collections.css';

export const PAGE_SIZE = 25;
const SKELETON_ROWS = 8;

type Row = Record<string, unknown>;
const columnHelper = createColumnHelper<Row>();

/**
 * Step 0.5 — the schema-derived collection table (R3.2), bound into the
 * `main` slot: TanStack Table over one offset page, columns from the derived
 * column model, cells keyed by slot kind, with loading/empty/error states
 * from the design-export. Pagination controls are capability-gated
 * (ADR-0029): no offset pagination advertised → no pager, no fake counts.
 */
export function CollectionTable({
  source,
  collection,
}: {
  source: MosaicSource;
  collection: CollectionModel;
}) {
  const capabilities = useCapabilities();
  const {
    page,
    setPage,
    filters,
    ranges,
    search,
    sort,
    toggleSort,
    clearFilters,
    openEntity,
    openIn,
    openCreateForm,
  } = useCollectionUrlState();
  // Active range facets (issue #61) ride the same typed `conditions`
  // mechanism the cross-class query-builder planner already uses.
  const conditions = useMemo(() => rangeConditions(ranges), [ranges]);
  const columnByField = useMemo(
    () => new Map(collection.columns.map((c) => [c.field, c])),
    [collection],
  );
  // Only resolved when the sorted column's endpoint enum actually matched
  // (ADR-0029 — a stale/foreign sort in the URL just falls back to unsorted).
  const activeOrderBy = useMemo(() => {
    if (!sort) return undefined;
    const orderField = columnByField.get(sort.field)?.orderField;
    if (!orderField) return undefined;
    return { field: orderField, dir: sort.dir === 'desc' ? ('DESC' as const) : ('ASC' as const) };
  }, [sort, columnByField]);
  const result = useEntityPage(
    source,
    collection.id,
    page,
    PAGE_SIZE,
    filters,
    search,
    activeOrderBy,
    conditions,
  );
  const isFiltered = Object.keys(filters).length > 0 || Object.keys(ranges).length > 0 || search !== '';

  const columns = useMemo(
    () =>
      collection.columns.map((model) =>
        columnHelper.accessor((row: Row) => row[model.field], {
          id: model.field,
          header: model.label,
          cell: (info) => {
            const value = info.getValue();
            // The id column links to THIS entity's own detail (R3.7).
            if (model.field === collection.idColumn && collection.detail && value != null) {
              return (
                <button
                  type="button"
                  className="cell-id cell-id-link"
                  onClick={() => openEntity(String(value))}
                >
                  {String(value)}
                </button>
              );
            }
            // A single reference cross-links to the REFERENCED entity's detail
            // in *its own* collection (R3.8) — resolved by the reference's
            // target type, not the current collection. The detail view's
            // RelationRow already does this; the table did not (references were
            // dead text, and the only link — the id column — assumed the
            // current collection, so a mis-picked FK linked to the wrong one).
            if (model.kind === 'ref' && value != null) {
              const target = source.collections.find((c) => c.typeName === model.targetType);
              const refId = (value as Record<string, unknown>)[model.targetIdField ?? ''];
              if (target?.detail != null && refId != null) {
                return (
                  <button
                    type="button"
                    className="cell-ref cell-ref-link"
                    onClick={() => openIn(target.id, String(refId))}
                  >
                    {String(refId)}
                  </button>
                );
              }
            }
            return renderCell(model, value);
          },
          meta: { align: isRightAligned(model) ? 'right' : 'left' },
        }),
      ),
    [collection, source, openEntity, openIn],
  );

  const table = useReactTable({
    data: result.status === 'ready' ? result.page.rows : [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const showPager = capabilities.offsetPagination && result.status === 'ready';

  return (
    // The collection's identity colour scopes the whole view, so the header
    // rule, the type chip and the card's top edge all resolve to the same hue
    // the nav and the graph use for this type.
    <div className="collection-view" style={typeColorStyle(collection.typeName)}>
      <div className="collection-view-header">
        <div>
          <div className="collection-title-row">
            <h1 className="collection-title">{collection.label}</h1>
            <span className="collection-type-chip">type: {collection.typeName}</span>
          </div>
          <div className="collection-count">
            {/* Real totals only when the page envelope carries one — page-scoped honesty otherwise. */}
            {result.status === 'ready'
              ? result.page.total != null
                ? `Page ${page} · ${result.page.rows.length} of ${result.page.total} rows${isFiltered ? ' · filtered' : ''}`
                : `Page ${page} · ${result.page.rows.length}${result.page.mayHaveMore ? '+' : ''} rows${isFiltered ? ' · filtered' : ''}`
              : ' '}
          </div>
        </div>
        <div className="collection-actions">
          {/* Gated on the derived create path — never offered unadvertised (W4.3). */}
          {collection.write.create && (
            <button type="button" className="action-button action-primary" onClick={openCreateForm}>
              New {collection.typeName}
            </button>
          )}
          <SaveViewButton source={source} collectionId={collection.id} />
          <ExportButtons
            source={source}
            collection={collection}
            filters={filters}
            conditions={conditions}
            search={search}
            orderBy={activeOrderBy}
            disabled={result.status !== 'ready'}
          />
        </div>
      </div>

      <div className="collection-card">
        <div className="collection-scroll">
          {/* data-testid attributes here and below are the stable certification
              contract (datahelix golden-path suite; #15) — keep them. */}
          <table className="collection-table" data-testid="collection-table">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    // Sort is column-specific (ADR-0007 orderField), not just
                    // collection-level — never offer it where it can't work (ADR-0029).
                    const sortable = capabilities.sort && columnByField.get(header.column.id)?.orderField != null;
                    const label = flexRender(header.column.columnDef.header, header.getContext());
                    const active = sort?.field === header.column.id;
                    return (
                      <th
                        key={header.id}
                        className={
                          (header.column.columnDef.meta as { align?: string } | undefined)?.align ===
                          'right'
                            ? 'align-right'
                            : undefined
                        }
                        aria-sort={
                          active ? (sort?.dir === 'desc' ? 'descending' : 'ascending') : undefined
                        }
                      >
                        {sortable ? (
                          <button
                            type="button"
                            className="collection-sort-header"
                            onClick={() => toggleSort(header.column.id)}
                          >
                            {label}
                            <span className="sort-indicator" aria-hidden="true">
                              {active ? (sort?.dir === 'desc' ? '▼' : '▲') : ''}
                            </span>
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {result.status === 'loading' &&
                Array.from({ length: SKELETON_ROWS }, (_, i) => (
                  <tr key={i} data-testid="skeleton-row">
                    {collection.columns.map((c) => (
                      <td key={c.field}>
                        <div
                          className="skeleton-bar"
                          style={{ width: `${45 + ((i * 17 + c.field.length * 7) % 40)}%` }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              {result.status === 'ready' &&
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} data-testid="collection-row">
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={
                          (cell.column.columnDef.meta as { align?: string } | undefined)?.align ===
                          'right'
                            ? 'align-right'
                            : undefined
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {result.status === 'ready' && result.page.rows.length === 0 && (
          <div className="collection-state" role="status">
            <div className="state-icon state-icon-empty" aria-hidden="true" />
            <div className="state-title">
              No {isFiltered ? 'matching ' : ''}
              {collection.label.toLowerCase()}
              {!isFiltered && page > 1 ? ' on this page' : ''}
            </div>
            <div className="state-detail">
              {isFiltered
                ? 'No records match the current filters. Try clearing filters or switching collections.'
                : page > 1
                  ? 'This page is past the end of the collection.'
                  : 'The endpoint returned no records for this collection.'}
            </div>
            {isFiltered && (
              <button type="button" className="state-button" onClick={clearFilters}>
                Clear filters
              </button>
            )}
            {!isFiltered && page > 1 && (
              <button type="button" className="state-button" onClick={() => setPage(1)}>
                Back to first page
              </button>
            )}
          </div>
        )}

        {result.status === 'error' && (
          <div className="collection-state" role="alert">
            <div className="state-icon state-icon-error" aria-hidden="true">
              !
            </div>
            <div className="state-title">Couldn’t load {collection.label.toLowerCase()}</div>
            <div className="state-detail">{result.message}</div>
            <button type="button" className="state-button state-button-primary" onClick={result.retry}>
              Retry
            </button>
          </div>
        )}

        {showPager && (
          <div className="collection-pager">
            <span className="pager-range">
              Page {page} · up to {PAGE_SIZE} per page
            </span>
            <div className="pager-buttons">
              <button
                type="button"
                className="pager-button"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="pager-button"
                disabled={result.status === 'ready' && !result.page.mayHaveMore}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
