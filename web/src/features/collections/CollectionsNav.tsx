import { useSavedViews } from '../../control/SavedViewsContext';
import { useDataSource } from '../../data/DataSourceContext';
import type { CollectionModel } from '../../data/schemaModel';
import { typeColorStyle } from '../../data/typeColor';
import { useNavView } from '../../nav/NavConfigContext';
import { schemaFingerprint, workflowAvailability } from '../../workflows/engine';
import { useWorkflows } from '../../workflows/WorkflowsContext';
import { useCollectionUrlState } from './urlState';

/** Two-letter chip initial derived from the label (design-export nav). */
function initialFor(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  const raw =
    words.length >= 2 ? `${words[0][0]}${words[1][0]}` : label.slice(0, 2).padEnd(2, label[0]);
  return raw.charAt(0).toUpperCase() + raw.charAt(1).toLowerCase();
}

/**
 * Step 0.5 — the collections nav, derived from endpoint introspection with
 * the `config/nav` overrides applied (derive-all + reorder/relabel/hide,
 * R3.1). Bound into the layout's `primaryNav` slot.
 */
export function CollectionsNav() {
  const state = useDataSource();
  const view = useNavView();
  const {
    collection,
    workflow,
    view: openView,
    selectCollection,
    openWorkflow,
    applyView,
    openQueryBuilder,
  } = useCollectionUrlState();
  const { workflows, error: workflowsError } = useWorkflows();
  const savedViews = useSavedViews();

  if (state.status !== 'ready' || view == null) {
    return (
      <>
        <div className="nav-section-label">Collections</div>
        <div className="nav-status">
          {state.status === 'connecting' ? 'Negotiating with endpoint…' : 'No endpoint connected.'}
        </div>
      </>
    );
  }

  // Exactly one entry is current. `collection` survives in the URL while a
  // query view is open -- that is deliberate, it is how "back to collections"
  // knows where to return -- so marking it current here left the nav pointing
  // at one collection while the anchor control pointed at another. Two
  // controls disagreeing about where you are is worse than either being wrong.
  const inQueryView = openView === 'query' || openView === 'graph';
  const active = workflow == null && !inQueryView ? (collection ?? view.defaultId) : null;

  return (
    <>
      <div className="nav-section-label">Collections</div>
      {view.error && <div className="nav-status">{view.error}</div>}
      <div className="nav-list">
        {view.visible.map((c: CollectionModel) => (
          <button
            key={c.id}
            type="button"
            className="nav-item"
            // The collection's identity colour, the same hue it wears as a
            // graph node and a type badge. CSS reads it off the element.
            style={typeColorStyle(c.typeName)}
            title={navTitle(c)}
            aria-current={c.id === active}
            onClick={() => selectCollection(c.id)}
          >
            <span className="nav-item-chip">{initialFor(c.label)}</span>
            <span className="nav-item-label">{c.label}</span>
            {/* Interim, flat (ADR-0042): a family is one entry, marked, until
                the class-browser redesign settles how families nest. */}
            {c.family && (
              <span className="nav-item-family" data-testid={`nav-family-${c.id}`}>
                family
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="nav-section-label">Query</div>
      <div className="nav-list">
        <button
          type="button"
          className="nav-item"
          data-testid="nav-query-builder"
          title="Cross-class criteria query (ADR-0035)"
          aria-current={inQueryView}
          onClick={() => openQueryBuilder()}
        >
          <span className="nav-item-chip">Qy</span>
          <span className="nav-item-label">Query builder</span>
        </button>
      </div>
      {savedViews.status === 'ready' && savedViews.views.length > 0 && (
        <>
          <div className="nav-section-label">Saved views</div>
          <div className="nav-list">
            {savedViews.views.map((view) => {
              const stale = view.schemaFingerprint !== schemaFingerprint(state.source);
              // A view shared by someone else is read-only: apply it and save
              // under a new name to fork it (ADR-0032 ownership amendment).
              // Gating the affordance is honest UI, not enforcement.
              const mine = savedViews.canWrite(view);
              const titleParts = [view.name];
              if (stale) titleParts.push('saved under an older schema; review filters after opening');
              if (!mine) titleParts.push(`shared by ${view.owner} — read-only; save under a new name to make your own copy`);
              return (
                // Keyed by owner too: two viewers may each hold a view of the
                // same name (ADR-0032 ownership amendment), so the name alone
                // is no longer unique in this list.
                <div key={`${view.owner ?? ''}:${view.name}`} className="nav-item nav-item-removable">
                  <button
                    type="button"
                    className="nav-item-main"
                    // `saved-view-<name>` is the stable certification contract
                    // (datahelix golden-path suite; #15) and stays reserved for
                    // the viewer's own views; another owner's shared view gets
                    // an owner-qualified id so the two never collide.
                    data-testid={mine ? `saved-view-${view.name}` : `shared-view-${view.owner}-${view.name}`}
                    title={titleParts.join(' — ')}
                    onClick={() => applyView(view.state)}
                  >
                    <span className="nav-item-chip">
                      {stale ? '⚠' : mine ? initialFor(view.name) : '↗'}
                    </span>
                    <span className="nav-item-label">{view.name}</span>
                    {/* Without this two same-named views render identically. */}
                    {!mine && <span className="nav-item-owner">{view.owner}</span>}
                  </button>
                  {mine && (
                    <button
                      type="button"
                      className="nav-item-remove"
                      data-testid={`remove-saved-view-${view.name}`}
                      title={`Remove saved view "${view.name}"`}
                      aria-label={`Remove saved view "${view.name}"`}
                      onClick={() => void savedViews.remove(view.name)}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {(workflows.length > 0 || workflowsError) && (
        <>
          <div className="nav-section-label">Workflows</div>
          {workflowsError && <div className="nav-status">{workflowsError}</div>}
          <div className="nav-list">
            {workflows.map((w) => {
              const availability = workflowAvailability(w, state.source);
              return (
                <button
                  key={w.id}
                  type="button"
                  className="nav-item"
                  aria-current={w.id === workflow}
                  disabled={!availability.runnable}
                  title={
                    availability.runnable
                      ? w.description ?? w.label
                      : `Unavailable: ${availability.reasons.join('; ')}`
                  }
                  onClick={() => openWorkflow(w.id)}
                >
                  <span className="nav-item-chip">{initialFor(w.label)}</span>
                  <span className="nav-item-label">{w.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/** The nav entry's tooltip; a family's lists its kinds (ADR-0042). */
function navTitle(c: CollectionModel): string {
  if (!c.family) return `${c.label} → type: ${c.typeName}`;
  const kinds = c.family.kinds.length > 0 ? c.family.kinds.join(', ') : 'none advertised';
  return `${c.label} → family: ${c.typeName} (read-only). Kinds: ${kinds}`;
}
