import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { Core, NodeSingular } from 'cytoscape';
import type { HippoSource } from '../data/hippoSource';
import type { CollectionModel, ColumnModel } from '../data/schemaModel';
import { useCollectionUrlState } from '../features/collections/urlState';
import { runQuerySpec } from './planner';
import { resolveAnchor, canonicalizeQuerySpec } from './querySpec';
import { readGraphTheme, useGraphTheme, type GraphTheme } from './graphTheme';
import { typeColor } from '../data/typeColor';
import { expandNode, graphTier, tierLegend } from './graphExpansion';
import './query.css';

/**
 * The graph exploration view (ADR-0037, Proposed): a Cytoscape canvas seeded
 * from the current QuerySpec's results (or the active collection's first
 * page), expanded one hop per click. When the endpoint advertises a
 * `neighbors` root (Mosaic v0.13.0+), each expansion is one server call;
 * otherwise it is the documented client-side fallback — per-entity detail
 * reads for forward reference edges plus filtered reverse lookups — exact but
 * slower. The legend names the tier in use (ADR-0029); the node budget is
 * visible, never silent, in both (see `graphExpansion.ts`).
 */

export const NODE_BUDGET = 250;
const SEED_LIMIT = 50;

/**
 * The Cytoscape stylesheet for a given resolved palette. Kept out of the mount
 * effect so the same definition can be re-applied when the theme changes; the
 * per-node `background-color` bypass set in addEntity survives a restyle.
 */
function graphStylesheet(theme: GraphTheme): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': '9px',
        color: theme.label,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        width: 18,
        height: 18,
        'border-width': 1,
        'border-color': theme['node-ring'],
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1,
        'line-color': theme.edge,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': theme.edge,
        'curve-style': 'bezier',
        'arrow-scale': 0.7,
      },
    },
    {
      selector: 'node:selected',
      style: { 'border-width': 3, 'border-color': theme.selected },
    },
  ];
}

function labelColumn(collection: CollectionModel): ColumnModel | undefined {
  return (
    collection.columns.find((c) => c.kind === 'text') ??
    collection.columns.find((c) => c.field === collection.idColumn)
  );
}

interface GraphNodeData {
  id: string;
  entityId: string;
  collectionId: string;
  typeName: string;
  label: string;
  expanded: boolean;
}

export function GraphView({ source }: { source: HippoSource }) {
  const { collections, capabilities } = source;
  const urlState = useCollectionUrlState();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [selected, setSelected] = useState<GraphNodeData | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nodeCount, setNodeCount] = useState(0);
  const graphTheme = useGraphTheme(containerEl);

  const byType = useMemo(
    () => new Map(collections.map((c) => [c.typeName, c])),
    [collections],
  );
  const byId = useMemo(() => new Map(collections.map((c) => [c.id, c])), [collections]);

  const addEntity = useCallback(
    (
      cy: Core,
      collection: CollectionModel,
      entityId: string,
      row?: Record<string, unknown>,
    ): string | null => {
      const nodeId = `${collection.typeName}:${entityId}`;
      if (cy.getElementById(nodeId).nonempty()) return nodeId;
      if (cy.nodes().length >= NODE_BUDGET) {
        setNote(
          `Node budget (${NODE_BUDGET}) reached — some neighbors are not shown. ` +
            `Narrow the query to explore further.`,
        );
        return null;
      }
      const labelCol = labelColumn(collection);
      const label =
        (row && labelCol && row[labelCol.field] != null && String(row[labelCol.field])) ||
        entityId.slice(0, 8);
      cy.add({
        group: 'nodes',
        data: {
          id: nodeId,
          entityId,
          collectionId: collection.id,
          typeName: collection.typeName,
          label,
          expanded: false,
        } satisfies GraphNodeData & { id: string },
        style: { 'background-color': typeColor(collection.typeName) },
      });
      setNodeCount(cy.nodes().length);
      return nodeId;
    },
    [],
  );

  const addEdge = useCallback((cy: Core, from: string, to: string, label: string) => {
    const edgeId = `${from}->${to}:${label}`;
    if (cy.getElementById(edgeId).nonempty()) return;
    if (cy.getElementById(from).empty() || cy.getElementById(to).empty()) return;
    cy.add({ group: 'edges', data: { id: edgeId, source: from, target: to, label } });
  }, []);

  const tier = graphTier(capabilities, source);

  /** One-hop expansion through whichever data tier the endpoint supports. */
  const expand = useCallback(
    async (node: GraphNodeData) => {
      const cy = cyRef.current;
      if (!cy) return;
      setBusy(true);
      try {
        await expandNode(
          tier,
          { source, collections, byType, byId },
          node,
          {
            addEntity: (collection, entityId, row) => addEntity(cy, collection, entityId, row),
            addEdge: (from, to, label) => addEdge(cy, from, to, label),
            note: setNote,
          },
        );
        cy.getElementById(node.id).data('expanded', true);
        cy.layout({ name: 'cose', animate: false }).run();
      } catch (error) {
        setNote(`Could not expand this node: ${(error as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [addEdge, addEntity, byId, byType, collections, source, tier],
  );

  // Mount cytoscape once.
  useEffect(() => {
    if (!containerRef.current) return;
    // Read synchronously at mount so the first paint is already themed; the
    // effect below keeps it in step with later theme changes.
    const cy = cytoscape({
      container: containerRef.current,
      style: graphStylesheet(readGraphTheme(containerRef.current)),
    });
    cy.on('tap', 'node', (event) => {
      const node = event.target as NodeSingular;
      setSelected(node.data() as GraphNodeData);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Re-skin the canvas when the theme changes (data-theme flip, OS preference).
  useEffect(() => {
    cyRef.current?.style(graphStylesheet(graphTheme)).update();
  }, [graphTheme]);

  // Seed from the QuerySpec results (or the active collection's first page).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        // A v2 spec names its anchor by LinkML class name, not collection id,
        // so resolve through the spec rather than treating the two as
        // interchangeable. A bookmarked v1 spec upgrades first; one whose
        // anchor no longer exists seeds from the browse collection instead of
        // rendering an empty canvas.
        const spec = urlState.querySpec
          ? canonicalizeQuerySpec(urlState.querySpec, collections)
          : null;
        const anchor =
          (spec ? resolveAnchor(spec, collections) : undefined) ??
          byId.get(urlState.collection ?? collections[0]?.id ?? '');
        if (!anchor) return;
        const rows = spec
          ? (await runQuerySpec(source, collections, capabilities, spec, 1, SEED_LIMIT)).rows
          : (
              await source.listEntities(anchor.id, { page: 1, pageSize: SEED_LIMIT })
            ).rows;
        if (cancelled) return;
        for (const row of rows) {
          const id = row[anchor.idColumn ?? ''];
          if (id != null) addEntity(cy, anchor, String(id), row);
        }
        cy.layout({ name: 'grid', animate: false }).run();
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Seed exactly once per mount — the URL spec is fixed while this view is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typesShown = useMemo(() => {
    const cy = cyRef.current;
    const names = new Set<string>();
    cy?.nodes().forEach((n) => {
      names.add(n.data('typeName') as string);
    });
    return [...names];
    // Recompute when the node count changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeCount]);

  return (
    <div className="main-panel query-view" data-testid="graph-view">
      <div className="query-header">
        <h1 className="main-panel-title">Graph</h1>
        <div className="collection-actions">
          <button
            type="button"
            className="detail-link"
            onClick={() => urlState.openQueryBuilder(urlState.querySpec ?? undefined)}
          >
            Back to query
          </button>
          <button type="button" className="detail-link" onClick={urlState.closeQueryViews}>
            Collections
          </button>
        </div>
      </div>
      <p className="query-graph-honesty" role="note">
        {tierLegend(tier, nodeCount, NODE_BUDGET, busy)}
      </p>
      {note && (
        <div className="query-notes" role="status">
          {note}
        </div>
      )}
      <div className="query-graph-wrap">
        <div
          ref={(el) => {
            containerRef.current = el;
            setContainerEl(el);
          }}
          className="query-graph-canvas"
          data-testid="graph-canvas"
        />
        <div className="query-graph-side">
          <div className="query-graph-legend">
            {typesShown.map((t) => (
              <span key={t} className="query-legend-item">
                <span className="query-legend-dot" style={{ backgroundColor: typeColor(t) }} />
                {t}
              </span>
            ))}
          </div>
          {selected ? (
            <div className="query-graph-selected">
              <div className="query-selected-title">
                {selected.typeName} · {selected.label}
              </div>
              <div className="collection-actions">
                <button
                  type="button"
                  className="action-button"
                  disabled={busy}
                  onClick={() => void expand(selected)}
                >
                  Expand neighbors
                </button>
                <button
                  type="button"
                  className="action-button"
                  onClick={() => urlState.openIn(selected.collectionId, selected.entityId)}
                >
                  Open detail
                </button>
              </div>
            </div>
          ) : (
            <p className="query-graph-hint">Tap a node to expand its neighbors.</p>
          )}
        </div>
      </div>
    </div>
  );
}
