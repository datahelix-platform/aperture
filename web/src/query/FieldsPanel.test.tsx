/**
 * The fields panel — what the surface shows when it has no results.
 *
 * The behaviour worth protecting is the one that is easiest to lose: `+ filter` must NOT
 * run anything. In this builder a spec in the URL *is* an executed query, so an affordance
 * that wrote there would execute off a single click on a field listing — which ADR-0039
 * rules out ("the user must then explicitly run").
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { capableSchema, certIntrospection, demoIntrospection, fakeClient } from '../data/testing/fixtures';
import { deriveCollections } from '../data/schemaModel';
import type { CollectionModel } from '../data/schemaModel';
import type { PathColumn } from '../data/selection';
import { deriveEdges } from './querySpec';
import { FieldsPanel } from './FieldsPanel';
import type { TraversalProps } from './FieldsPanel';

const endpoint = { url: 'http://fields.test/graphql' };

function renderApp(ui: ReactNode, searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory>
      {ui}
    </NuqsTestingAdapter>,
  );
}

const client = () =>
  fakeClient(capableSchema(), () => ({ data: { books: [], authors: [] }, error: null }));

describe('FieldsPanel', () => {
  it('shows the anchor’s fields instead of an empty state', async () => {
    renderApp(<App endpoint={endpoint} clientFactory={client} />, '?view=query');
    await screen.findByTestId('query-builder');
    await screen.findByTestId('fields-panel');

    // The placeholder this replaced covered most of the screen to say there was nothing
    // to show, while the page held the entire schema.
    expect(screen.queryByText(/nothing run yet/i)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('fields-row').length).toBeGreaterThan(0);
  });

  it('adds a criterion to the draft without executing', async () => {
    const user = userEvent.setup();
    renderApp(<App endpoint={endpoint} clientFactory={client} />, '?view=query');
    await screen.findByTestId('query-builder');
    await screen.findByTestId('fields-panel');

    expect(screen.queryAllByTestId('query-condition')).toHaveLength(0);

    await user.click(screen.getAllByRole('button', { name: '+ filter' })[0]!);

    // In the builder…
    expect(await screen.findAllByTestId('query-condition')).toHaveLength(1);
    // …and nothing ran. Results appear only after Run.
    expect(screen.queryByTestId('query-results')).not.toBeInTheDocument();
    expect(screen.getByTestId('fields-panel')).toBeInTheDocument();
  });

  it('keeps Run present as the only execution gesture', async () => {
    renderApp(<App endpoint={endpoint} clientFactory={client} />, '?view=query');
    await screen.findByTestId('query-builder');
    expect(screen.getByTestId('query-run')).toBeInTheDocument();
  });

  it('degrades without slot enrichment', async () => {
    // An endpoint advertising no `mosaicSchema` has no per-field descriptions. The panel
    // must still list every field from the generic type surface (ADR-0029).
    renderApp(<App endpoint={endpoint} clientFactory={client} />, '?view=query');
    await screen.findByTestId('fields-panel');
    const rows = screen.getAllByTestId('fields-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toBeTruthy();
  });
});

/**
 * The panel follows the answer, not the anchor.
 *
 * Rendered directly rather than through `App`: driving a conversational turn end to end
 * needs a planner, and the behaviour under test is the panel's, not the planner's.
 */
describe('FieldsPanel — showing a collection the query is not anchored on', () => {
  const collection = {
    id: 'toxicology_reports',
    label: 'Toxicology reports',
    typeName: 'ToxicologyReport',
    description: 'A post-mortem toxicology screen.',
    filterFields: ['panel_type'],
    detailColumns: [
      { field: 'panelType', slot: 'panel_type', label: 'Panel type', kind: 'scalar' as const },
    ],
  } as never;

  const props = {
    collection,
    highlighted: new Set(['panel_type']),
    hiddenFields: new Set<string>(),
    onAddFilter: () => {},
    onToggleField: () => {},
    showColumnToggles: false,
  };

  it('says why it is showing fields the user did not anchor on', () => {
    render(<FieldsPanel {...props} asideFromAnchor onAdoptAnchor={() => {}} />);
    // Without this the reader sees unfamiliar fields and cannot tell an answer from a bug.
    expect(screen.getByTestId('fields-panel-aside')).toBeInTheDocument();
  });

  it('says nothing when the shown collection IS the anchor', () => {
    render(<FieldsPanel {...props} />);
    expect(screen.queryByTestId('fields-panel-aside')).not.toBeInTheDocument();
  });

  it('offers to make it the anchor, and does not act until asked', async () => {
    // Discovery leads into query building by a deliberate gesture. Adopting silently would
    // move the reader's query out from under them.
    let adopted = 0;
    render(<FieldsPanel {...props} asideFromAnchor onAdoptAnchor={() => { adopted += 1; }} />);
    expect(adopted).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: /return rows of toxicology reports/i }));
    expect(adopted).toBe(1);
  });
});

describe('FieldsPanel — columns through a reference (ADR-0041)', () => {
  const demo = deriveCollections(demoIntrospection);
  const cert = deriveCollections(certIntrospection);
  const of = (list: CollectionModel[], id: string) => list.find((c) => c.id === id)!;

  function panel(
    collections: CollectionModel[],
    collectionId: string,
    selected: PathColumn[] = [],
    handlers: Partial<TraversalProps> = {},
  ) {
    const collection = of(collections, collectionId);
    return renderApp(
      <FieldsPanel
        collection={collection}
        highlighted={new Set()}
        hiddenFields={new Set()}
        onAddFilter={() => {}}
        onToggleField={() => {}}
        showColumnToggles
        traversal={{
          edges: deriveEdges(collection, collections),
          collections,
          selected,
          onTogglePath: () => {},
          onSetMode: () => {},
          ...handlers,
        }}
      />,
    );
  }

  it('groups a reference and reveals its fields on demand', async () => {
    panel(demo, 'samples');
    const group = screen.getByRole('button', { name: /Donor/i });
    // Collapsed by default — a fifteen-collection schema would otherwise open
    // as a wall of every reachable field.
    expect(screen.queryByText('Cohort')).not.toBeInTheDocument();
    await userEvent.click(group);
    expect(screen.getByText('Cohort')).toBeInTheDocument();
  });

  it('shows a gated edge with its reason instead of hiding it', () => {
    panel(demo, 'donors');
    // The demo schema declares no inverse slot, so Donor→Samples can filter but
    // cannot be read into the table. Omitting the row would read as "no such
    // data"; ADR-0029 wants the gate visible.
    // Several classes reference Donor — samples, diagnoses, assessments — so
    // every one of them is listed, and every one is gated for the same reason.
    const gated = screen.getAllByTestId('fields-related-gated');
    expect(gated.length).toBeGreaterThan(1);
    for (const row of gated) expect(row).toHaveTextContent(/filter only/i);
  });

  it('offers no mode choice for a to-one column', async () => {
    const donorCohort: PathColumn = {
      path: ['donor', 'cohort'],
      column: of(demo, 'donors').detailColumns.find((c) => c.field === 'cohort')!,
      label: 'Donor → Cohort',
    };
    panel(demo, 'samples', [donorCohort]);
    await userEvent.click(screen.getByRole('button', { name: /Donor/i }));
    // One sample has one donor: there is no grain question to answer.
    expect(screen.queryByText('one row each')).not.toBeInTheDocument();
  });

  it('makes the grain choice explicit for a to-many column', async () => {
    const accession = of(demo, 'samples').detailColumns.find((c) => c.field === 'accession')!;
    const picked: PathColumn = {
      path: ['inputSamples', 'accession'],
      column: accession,
      label: 'Sample → Accession',
      many: { mode: 'explode' },
    };
    panel(demo, 'workflows', [picked]);
    await userEvent.click(screen.getByRole('button', { name: /Sample/i }));
    expect(screen.getByText('one row each')).toBeInTheDocument();
    // The consequence is stated beside the choice, not left to be discovered.
    expect(screen.getByText(/changes what a row is/i)).toBeInTheDocument();
  });

  it('offers a declared reverse edge for columns, not just filtering', async () => {
    panel(cert, 'authors');
    // `inverse: author` in the certification fixture. Same component, same
    // props — the schema is what changed.
    expect(screen.queryByTestId('fields-related-gated')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Books/i }));
    expect(screen.getByText('Title')).toBeInTheDocument();
  });
});
