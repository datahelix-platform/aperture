import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useCapabilities } from '../../data/DataSourceContext';
import type { HippoSource, HistoryEntry } from '../../data/hippoSource';
import type { CollectionModel, ColumnModel } from '../../data/schemaModel';
import { xrefUrl } from '../../config/xrefs';
import type { XrefTemplates } from '../../config/xrefs';
import { useXrefs } from '../../config/XrefsContext';
import { renderCell } from './cells';
import { useCollectionUrlState } from './urlState';
import './collections.css';

/**
 * The entity detail view (R3.7/R3.8), rendered in `main` when `entity` is in
 * the URL: all derivable fields through the slot-kind renderers, resolved
 * relationships as cross-links (open the target entity, or pivot to the
 * related collection filtered by this entity), and change history when the
 * endpoint advertises it. Reached only through collections whose detail path
 * exists — gating happens at the link site (ADR-0029).
 */
type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; entity: Record<string, unknown> }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export function EntityDetail({
  source,
  collection,
  entityId,
}: {
  source: HippoSource;
  collection: CollectionModel;
  entityId: string;
}) {
  const { closeEntity, openEditForm } = useCollectionUrlState();
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const xrefs = useXrefs();

  const load = useCallback(
    (cancelledRef?: { current: boolean }, fresh?: boolean) => {
      setState({ status: 'loading' });
      return source
        .getEntity(collection.id, entityId, fresh)
        .then((entity) => {
          if (!cancelledRef?.current) {
            setState(entity ? { status: 'ready', entity } : { status: 'missing' });
          }
        })
        .catch((error: unknown) => {
          if (!cancelledRef?.current) {
            setState({
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
    },
    [source, collection.id, entityId],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    void load(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  const fieldColumns = collection.detailColumns.filter(
    (c) => c.kind !== 'ref' && c.kind !== 'refList',
  );
  const relationColumns = collection.detailColumns.filter(
    (c) => c.kind === 'ref' || c.kind === 'refList',
  );

  return (
    <div className="detail-view">
      <div className="detail-header">
        <button type="button" className="detail-back" onClick={closeEntity}>
          ← {collection.label}
        </button>
        <div className="detail-title-row">
          <span className="detail-title">{entityId}</span>
          <span className="detail-type-chip">{collection.typeName}</span>
          {/* Gated on the derived update path (W4.3); no hard delete (W4.4). */}
          {collection.write.update && state.status === 'ready' && (
            <button type="button" className="action-button" onClick={openEditForm}>
              Edit
            </button>
          )}
        </div>
        {state.status === 'ready' && (
          <LifecycleActions
            source={source}
            collection={collection}
            entityId={entityId}
            entity={state.entity}
            onChanged={() => void load(undefined, true)}
          />
        )}
      </div>

      {state.status === 'loading' && (
        <div className="main-panel" role="status">
          <p className="main-panel-detail">Loading record…</p>
        </div>
      )}
      {state.status === 'missing' && (
        <div className="main-panel" role="status">
          <h1 className="main-panel-title">Record not found</h1>
          <p className="main-panel-detail">
            No {collection.typeName} with id “{entityId}” at the endpoint.
          </p>
        </div>
      )}
      {state.status === 'error' && (
        <div className="main-panel" role="alert">
          <h1 className="main-panel-title">Couldn’t load the record</h1>
          <p className="main-panel-detail">{state.message}</p>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="detail-body">
          <div className="detail-section-label">Fields</div>
          {/* Cross-link config problems are surfaced, not swallowed (ADR-0029). */}
          {xrefs.error && (
            <div className="detail-config-error" role="alert">
              {xrefs.error}
            </div>
          )}
          <div className="detail-card">
            {fieldColumns.map((column) => (
              <div key={column.field} className="detail-field-row">
                <span className="detail-field-label">{column.label}</span>
                <span className="detail-field-value">
                  <FieldValue
                    column={column}
                    value={state.entity[column.field]}
                    templates={xrefs.templates}
                  />
                </span>
              </div>
            ))}
          </div>

          {relationColumns.length > 0 && (
            <>
              <div className="detail-section-label">Relationships</div>
              {relationColumns.map((column) => (
                <RelationRow
                  key={column.field}
                  source={source}
                  collection={collection}
                  entityId={entityId}
                  column={column}
                  value={state.entity[column.field]}
                />
              ))}
            </>
          )}

          <HistorySection source={source} entityId={entityId} />
        </div>
      )}
    </div>
  );
}

/** The entity's own `isAvailable`-ish column, when the collection has one. */
function availabilityColumn(collection: CollectionModel): ColumnModel | undefined {
  return collection.detailColumns.find(
    (c) => c.kind === 'boolean' && /^is_?available$/i.test(c.field),
  );
}

/**
 * Availability transition + supersede affordances (W4.4), gated on the
 * derived lifecycle model — offered only when the endpoint advertises the
 * corresponding mutation (ADR-0029). Mirrors the Edit button's gating
 * pattern (`collection.write.update`).
 */
function LifecycleActions({
  source,
  collection,
  entityId,
  entity,
  onChanged,
}: {
  source: HippoSource;
  collection: CollectionModel;
  entityId: string;
  entity: Record<string, unknown>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const [replacementId, setReplacementId] = useState('');
  const [reason, setReason] = useState('');

  const { setAvailability, supersede } = collection.lifecycle;
  if (!setAvailability && !supersede) return null;

  const availCol = availabilityColumn(collection);
  // Unknown current state defaults to "available" — the honest default when
  // the endpoint doesn't expose the column even though it accepts the mutation.
  const isAvailable = availCol ? Boolean(entity[availCol.field]) : true;

  const runSetAvailability = async (nextAvailable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await source.setAvailability(collection.id, entityId, nextAvailable);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitSupersede = async (e: FormEvent) => {
    e.preventDefault();
    if (!replacementId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await source.supersede(collection.id, entityId, replacementId.trim(), reason.trim() || undefined);
      setSupersedeOpen(false);
      setReplacementId('');
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lifecycle-actions">
      <div className="collection-actions">
        {setAvailability && (
          <button
            type="button"
            className="action-button"
            disabled={busy}
            onClick={() => void runSetAvailability(!isAvailable)}
          >
            {isAvailable ? 'Archive' : 'Restore'}
          </button>
        )}
        {supersede && !supersedeOpen && (
          <button
            type="button"
            className="action-button"
            disabled={busy}
            onClick={() => setSupersedeOpen(true)}
          >
            Supersede…
          </button>
        )}
      </div>

      {error && (
        <div className="form-server-error" role="alert">
          {error}
        </div>
      )}

      {supersede && supersedeOpen && (
        <form className="lifecycle-supersede-form" onSubmit={(e) => void submitSupersede(e)}>
          <label className="lifecycle-supersede-label">
            Replacement id
            <input
              type="text"
              className="form-input"
              value={replacementId}
              onChange={(e) => setReplacementId(e.target.value)}
              required
            />
          </label>
          <label className="lifecycle-supersede-label">
            Reason (optional)
            <input
              type="text"
              className="form-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="submit"
              className="action-button action-primary"
              disabled={busy || !replacementId.trim()}
            >
              {busy ? 'Superseding…' : 'Confirm supersede'}
            </button>
            <button
              type="button"
              className="state-button"
              onClick={() => {
                setSupersedeOpen(false);
                setReplacementId('');
                setReason('');
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function FieldValue({
  column,
  value,
  templates,
}: {
  column: ColumnModel;
  value: unknown;
  templates: XrefTemplates;
}) {
  const external = xrefUrl(column.field, value, templates);
  if (external) {
    return (
      <a className="detail-xref" href={external} target="_blank" rel="noreferrer">
        {String(value)} ↗
      </a>
    );
  }
  return renderCell(column, value);
}

/**
 * A resolved relationship (R3.8): single refs cross-link to the target
 * entity's detail; multivalued refs offer a pivot to the target collection
 * filtered by this entity — each only when the target side supports it.
 */
function RelationRow({
  source,
  collection,
  entityId,
  column,
  value,
}: {
  source: HippoSource;
  collection: CollectionModel;
  entityId: string;
  column: ColumnModel;
  value: unknown;
}) {
  const { openIn, pivotTo } = useCollectionUrlState();
  const target = source.collections.find((c) => c.typeName === column.targetType);

  if (column.kind === 'ref') {
    const refId =
      value == null ? null : String((value as Record<string, unknown>)[column.targetIdField ?? '']);
    const canOpen = target?.detail != null && refId != null;
    return (
      <div className="detail-relation">
        <span className="detail-relation-label">{column.label}</span>
        <span className="detail-relation-value">
          {refId == null ? (
            <span className="cell-empty">—</span>
          ) : canOpen ? (
            <button type="button" className="detail-link" onClick={() => openIn(target.id, refId)}>
              {refId}
            </button>
          ) : (
            <span className="cell-ref">{refId}</span>
          )}
        </span>
      </div>
    );
  }

  const count = Array.isArray(value) ? value.length : 0;
  // Pivot needs the target collection to be filterable by its back-reference
  // to this entity type (an equality facet on that field).
  const backRef = target?.detailColumns.find(
    (c) => c.kind === 'ref' && c.targetType === collection.typeName,
  );
  const pivotField =
    backRef && target ? target.facets.find((f) => f.field === backRef.field)?.field : undefined;

  return (
    <div className="detail-relation">
      <span className="detail-relation-label">{column.label}</span>
      <span className="detail-relation-value">
        <span className={count === 0 ? 'cell-count cell-count-zero' : 'cell-count'}>{count}</span>
        {target && pivotField && count > 0 && (
          <button
            type="button"
            className="detail-link"
            onClick={() => pivotTo(target.id, pivotField, entityId)}
          >
            View in {target.label}
          </button>
        )}
      </span>
    </div>
  );
}

function HistorySection({ source, entityId }: { source: HippoSource; entityId: string }) {
  const capabilities = useCapabilities();
  const [entries, setEntries] = useState<HistoryEntry[] | 'loading' | 'error'>('loading');

  useEffect(() => {
    if (!capabilities.entityHistory) return;
    let cancelled = false;
    setEntries('loading');
    source
      .getHistory(entityId)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries('error');
      });
    return () => {
      cancelled = true;
    };
  }, [source, entityId, capabilities.entityHistory]);

  // Not advertised → no section at all (never an empty promise — ADR-0029).
  if (!capabilities.entityHistory || !source.history) return null;

  return (
    <>
      <div className="detail-section-label">History</div>
      {entries === 'loading' && <div className="detail-history-note">Loading history…</div>}
      {entries === 'error' && <div className="detail-history-note">History unavailable.</div>}
      {Array.isArray(entries) &&
        (entries.length === 0 ? (
          <div className="detail-history-note">No recorded history.</div>
        ) : (
          <div className="detail-card">
            <table className="detail-history-table">
              <thead>
                <tr>
                  {source.history.columns.map((c) => (
                    <th key={c.field}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={i}>
                    {source.history!.columns.map((c) => (
                      <td key={c.field}>{renderCell(c, entry[c.field])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
