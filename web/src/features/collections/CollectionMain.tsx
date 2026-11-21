import { useDataSource } from '../../data/DataSourceContext';
import { activeCollection } from '../../nav/config';
import { useNavView } from '../../nav/NavConfigContext';
import { useCollectionUrlState } from './urlState';
import { WorkflowRunner } from '../../workflows/WorkflowRunner';
import { CollectionTable } from './CollectionTable';
import { EntityDetail } from './EntityDetail';
import { EntityForm } from './EntityForm';
import { GraphView } from '../../query/GraphView';
import { QueryBuilderView } from '../../query/QueryBuilderView';
import './collections.css';

/**
 * The `main`-slot content: routes the data-source state to honest panels
 * (unconfigured / connecting / error — ADR-0029) and renders the active
 * collection's table once the source is ready. The active collection comes
 * from the URL (step 0.6), defaulting to the nav config's default collection
 * (or the first visible one). Deep links resolve against ALL derived
 * collections — nav-hidden ≠ inaccessible (R3.1, ADR-0029).
 */
export function CollectionMain() {
  const state = useDataSource();
  const view = useNavView();
  const urlState = useCollectionUrlState();
  const { collection, entity, form, workflow, closeEntity, closeForm } = urlState;

  // The guided workflow runner owns main when a workflow is open (W4.6).
  if (workflow != null) {
    return <WorkflowRunner key={workflow} workflowId={workflow} />;
  }

  // Cross-class query surfaces (ADR-0035/0037) own main when open.
  if (urlState.view === 'query' && state.status === 'ready') {
    return <QueryBuilderView source={state.source} />;
  }
  if (urlState.view === 'graph' && state.status === 'ready') {
    return <GraphView source={state.source} />;
  }

  if (state.status === 'unconfigured') {
    return (
      <div className="main-panel" role="status">
        <h1 className="main-panel-title">No data-plane endpoint configured</h1>
        <p className="main-panel-detail">
          Point Aperture at a GraphQL endpoint by setting{' '}
          <code>VITE_GRAPHQL_URL</code> (for example{' '}
          <code>VITE_GRAPHQL_URL=http://localhost:8000/graphql npm run dev</code>).
        </p>
      </div>
    );
  }

  if (state.status === 'connecting') {
    return (
      <div className="main-panel" role="status">
        <h1 className="main-panel-title">Connecting…</h1>
        <p className="main-panel-detail">Introspecting the endpoint and negotiating capabilities.</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="main-panel" role="alert">
        <h1 className="main-panel-title">Couldn’t connect to the endpoint</h1>
        <p className="main-panel-detail">{state.message}</p>
      </div>
    );
  }

  const active = view != null ? activeCollection(view, collection) : undefined;
  if (active == null) {
    return (
      <div className="main-panel" role="status">
        <h1 className="main-panel-title">No browsable collections</h1>
        <p className="main-panel-detail">
          The endpoint's schema exposes no list queries to derive collections from.
        </p>
      </div>
    );
  }

  if (form != null) {
    const path = form === 'new' ? active.write.create : active.write.update;
    const valid = form === 'new' ? path != null : path != null && entity != null;
    if (!valid) {
      // Deep link to a form the endpoint doesn't offer (ADR-0029).
      return (
        <div className="main-panel" role="status">
          <h1 className="main-panel-title">
            No {form === 'new' ? 'create' : 'edit'} form for {active.label}
          </h1>
          <p className="main-panel-detail">
            The endpoint advertises no matching mutation.{' '}
            <button type="button" className="detail-link" onClick={closeForm}>
              Back
            </button>
          </p>
        </div>
      );
    }
    return (
      <EntityForm
        key={`${active.id}:${form}:${entity ?? ''}`}
        source={state.source}
        collection={active}
        mode={form}
        entityId={entity ?? undefined}
      />
    );
  }

  if (entity != null) {
    if (!active.detail) {
      // Deep link into a collection with no single-entity fetch path (ADR-0029).
      return (
        <div className="main-panel" role="status">
          <h1 className="main-panel-title">No detail view for {active.label}</h1>
          <p className="main-panel-detail">
            The endpoint offers no way to fetch a single {active.typeName}.{' '}
            <button type="button" className="detail-link" onClick={closeEntity}>
              Back to the table
            </button>
          </p>
        </div>
      );
    }
    return (
      <EntityDetail
        key={`${active.id}:${entity}`}
        source={state.source}
        collection={active}
        entityId={entity}
      />
    );
  }

  return <CollectionTable key={active.id} source={state.source} collection={active} />;
}
