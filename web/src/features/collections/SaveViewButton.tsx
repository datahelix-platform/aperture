import { useState } from 'react';
import { useSavedViews } from '../../control/SavedViewsContext';
import type { MosaicSource } from '../../data/mosaicSource';
import { schemaFingerprint } from '../../workflows/engine';
import { formatSort, useCollectionUrlState } from './urlState';
import type { ColumnsParam } from '../../query/columnView';
import type { QuerySpec } from '../../query/querySpec';

/**
 * Saves the current query-state as a named view (Phase 4). Same name
 * overwrites — the store's (owner, kind, name) upsert rule, said out loud.
 *
 * Reusing the name of a view *someone else* shared is not an overwrite: it
 * creates your own copy alongside theirs (ADR-0032 ownership amendment), so
 * the button says "Save". This is also the fork path for a shared view —
 * apply it, then save it under any name.
 */
export function SaveViewButton({
  source,
  collectionId,
  query,
}: {
  source: MosaicSource;
  collectionId: string;
  /**
   * Save a QUERY (its executed spec and column choices) instead of the
   * collection page. Opening the view reruns that query with those columns.
   */
  query?: { qs: QuerySpec; cols?: ColumnsParam | null };
}) {
  const { save, views, canWrite } = useSavedViews();
  const { page, search, filters, ranges, sort } = useCollectionUrlState();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setBusy(true);
    setNote(null);
    try {
      await save({
        name: trimmed,
        state: {
          collection: collectionId,
          page,
          q: search || undefined,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
          ranges: Object.keys(ranges).length > 0 ? ranges : undefined,
          sort: sort ? formatSort(sort) : undefined,
          query: query ? { qs: query.qs, ...(query.cols ? { cols: query.cols } : {}) } : undefined,
        },
        schemaFingerprint: schemaFingerprint(source),
      });
      setOpen(false);
      setName('');
    } catch (error) {
      setNote(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        {note && (
          <span className="export-note" role="status">
            {note}
          </span>
        )}
        {/* data-testid attributes here and in the open form are the stable
            certification contract (datahelix golden-path suite; #15). */}
        <button
          type="button"
          className="action-button"
          data-testid="save-view"
          onClick={() => setOpen(true)}
        >
          Save view
        </button>
      </>
    );
  }

  const overwriting = views.some((v) => v.name === name.trim() && canWrite(v));
  return (
    <div className="save-view-form">
      <input
        type="text"
        className="form-input save-view-input"
        placeholder="View name…"
        data-testid="save-view-name"
        aria-label="View name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <button
        type="button"
        className="action-button action-primary"
        data-testid="save-view-confirm"
        disabled={busy || name.trim() === ''}
        onClick={() => void submit()}
      >
        {busy ? 'Saving…' : overwriting ? 'Overwrite' : 'Save'}
      </button>
      <button type="button" className="action-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
