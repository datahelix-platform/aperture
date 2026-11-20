import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import { App } from '../App';
import { capableSchema, fakeClient, fieldRangeSchema } from '../data/testing/fixtures';
import { sealPayload } from './store';

const endpoint = { url: 'http://example.test/graphql' };

/** Fake client with an in-memory document backend + book rows. */
function makeClient(seedDocs: { id: string; kind: string; name: string; payload: string }[] = []) {
  const docs = [...seedDocs];
  const client = fakeClient(capableSchema({ documents: true }), (query, variables) => {
    if (query.includes('apertureDocuments')) {
      const filter = (variables['filter'] ?? {}) as Record<string, string>;
      return {
        data: {
          apertureDocuments: docs.filter(
            (d) =>
              (filter['kind'] == null || d.kind === filter['kind']) &&
              (filter['name'] == null || d.name === filter['name']),
          ),
        },
        error: null,
      };
    }
    if (query.includes('createApertureDocument')) {
      const input = variables['input'] as Record<string, string>;
      const doc = { id: `DOC-${docs.length + 1}`, ...input } as (typeof docs)[number];
      docs.push(doc);
      return { data: { createApertureDocument: doc }, error: null };
    }
    if (query.includes('updateApertureDocument')) {
      const doc = docs.find((d) => d.id === variables['id']);
      if (doc) Object.assign(doc, variables['input']);
      return { data: { updateApertureDocument: doc ?? null }, error: null };
    }
    return { data: { books: [{ id: 'BK-0001' }], authors: [] }, error: null };
  });
  return { client, docs };
}

function renderApp(ui: ReactNode, searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory>
      {ui}
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => window.localStorage.clear());

describe('saved views (Phase 4, R3.9)', () => {
  it('footer reports the Mosaic store when the document type is advertised', async () => {
    const { client } = makeClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);
    expect(await screen.findByText(/LinkML-on-Mosaic document store/)).toBeInTheDocument();
  });

  it('falls back to the browser store — and says so — without the document type', async () => {
    const client = fakeClient(capableSchema(), () => ({
      data: { books: [{ id: 'BK-0001' }], authors: [] },
      error: null,
    }));
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);
    expect(await screen.findByText(/this browser only/)).toBeInTheDocument();
  });

  it('saves the current query-state as a named document and lists it in the nav', async () => {
    const user = userEvent.setup();
    const { client, docs } = makeClient();
    renderApp(
      <App endpoint={endpoint} clientFactory={() => client} />,
      `?collection=books&filters=${encodeURIComponent('{"format":"EBOOK"}')}&q=deep`,
    );

    await user.click(await screen.findByRole('button', { name: 'Save view' }));
    await user.type(screen.getByLabelText('View name'), 'EBook deep dive');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The document went to the control plane with the full query-state payload.
    await vi.waitFor(() => expect(docs).toHaveLength(1));
    expect(docs[0].kind).toBe('savedView');
    expect(docs[0].name).toBe('EBook deep dive');
    const payload = JSON.parse(docs[0].payload);
    expect(payload.v).toBe(1);
    expect(payload.data.state).toEqual({
      collection: 'books',
      page: 1,
      q: 'deep',
      filters: { format: 'EBOOK' },
    });
    expect(typeof payload.data.schemaFingerprint).toBe('string');

    // …and the nav now lists it.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(await within(nav).findByText('EBook deep dive')).toBeInTheDocument();
  });

  it('opening a saved view applies the whole query-state', async () => {
    const seeded = {
      id: 'DOC-1',
      kind: 'savedView',
      name: 'Hardcovers p2',
      payload: sealPayload(1, {
        state: { collection: 'books', page: 2, filters: { format: 'HARDCOVER' } },
        schemaFingerprint: 'whatever',
      }),
    };
    const user = userEvent.setup();
    const { client } = makeClient([seeded]);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?collection=authors');

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await user.click(await within(nav).findByText('Hardcovers p2'));

    expect(await screen.findByRole('heading', { name: 'Books' })).toBeInTheDocument();
    expect(await screen.findByText(/· filtered/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'HARDCOVER' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Fingerprint mismatch → the item is marked stale (drift is visible, not silent).
    expect(within(nav).getByTitle(/saved under an older schema/)).toBeInTheDocument();
  });

  it('opening a saved QUERY reopens the query view with its spec', async () => {
    const seeded = {
      id: 'DOC-1',
      kind: 'savedView',
      name: 'All books query',
      payload: sealPayload(1, {
        state: {
          collection: 'books',
          page: 1,
          query: { qs: { v: 1, anchor: 'Book', mode: 'AND', criteria: [] }, cols: { hidden: ['title'] } },
        },
        schemaFingerprint: 'whatever',
      }),
    };
    const user = userEvent.setup();
    const { client } = makeClient([seeded]);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?collection=authors');

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await user.click(await within(nav).findByText('All books query'));

    // A saved query lands in the query view, not on a collection page.
    expect(await screen.findByTestId('query-builder')).toBeInTheDocument();
  });

  it('keeps opening views saved before queries could be saved', async () => {
    const { openSavedView } = await import('./savedViews');
    const old = openSavedView({
      kind: 'savedView',
      name: 'old',
      payload: sealPayload(1, { state: { collection: 'books', page: 1 }, schemaFingerprint: 'x' }),
    } as never);
    expect(old?.state.query).toBeUndefined();
    const bad = openSavedView({
      kind: 'savedView',
      name: 'bad',
      payload: sealPayload(1, { state: { collection: 'books', page: 1, query: { qs: 'nope' } }, schemaFingerprint: 'x' }),
    } as never);
    // A malformed query part is skipped like any other invalid payload.
    expect(bad).toBeNull();
  });

  it('skips documents whose payload fails validation', async () => {
    const { client } = makeClient([
      { id: 'DOC-1', kind: 'savedView', name: 'broken', payload: '{"v":99}' },
      { id: 'DOC-2', kind: 'savedView', name: 'garbage', payload: 'not-json' },
    ]);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);
    await screen.findByText(/LinkML-on-Mosaic/);
    expect(screen.queryByText('broken')).not.toBeInTheDocument();
    expect(screen.queryByText('garbage')).not.toBeInTheDocument();
  });

  it('removing a saved view retires it server-side (W4.4) and drops it from the nav', async () => {
    const seeded = {
      id: 'DOC-1',
      kind: 'savedView',
      name: 'Hardcovers p2',
      payload: sealPayload(1, {
        state: { collection: 'books', page: 2, filters: { format: 'HARDCOVER' } },
        schemaFingerprint: 'whatever',
      }),
    };
    const user = userEvent.setup();
    const { client, docs } = makeClient([seeded]);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await within(nav).findByText('Hardcovers p2');

    await user.click(
      within(nav).getByRole('button', { name: 'Remove saved view "Hardcovers p2"' }),
    );

    // No hard delete — the document survives, payload cleared.
    await vi.waitFor(() => expect(docs[0].payload).toBe(''));
    expect(within(nav).queryByText('Hardcovers p2')).not.toBeInTheDocument();
  });

  it('range facets round-trip through saved views (issue #61)', async () => {
    const user = userEvent.setup();
    // No apertureDocuments collection on this schema — the store falls back
    // to localStorage; the round-trip should still carry `ranges`.
    const client = fakeClient(fieldRangeSchema(), (query) =>
      query.includes('ApertureFieldRange')
        ? { data: { f0: { min: null, max: null } }, error: null }
        : { data: { things: { items: [{ id: 'T-1', age: 42 }], total: 1 } }, error: null },
    );
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);
    expect(await screen.findByText('Filters')).toBeInTheDocument();

    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }));
    const minInput = await inspector.findByTestId('facet-range-min-age');
    await user.type(minInput, '10{Enter}');
    await screen.findByText(/· filtered/);

    await user.click(screen.getByRole('button', { name: 'Save view' }));
    await user.type(screen.getByLabelText('View name'), 'Adults');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Clear the range, then reapply the saved view from the nav.
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByText(/· filtered/)).not.toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await user.click(await within(nav).findByText('Adults'));

    expect(await screen.findByText(/· filtered/)).toBeInTheDocument();
    expect(inspector.getByTestId('facet-range-min-age')).toHaveValue(10);
  });
});

describe('config-as-data through the control plane (Phase 4)', () => {
  const wfConfig = [
    {
      id: 'register-work',
      version: '1',
      label: 'Register a work',
      steps: [{ id: 'author-step', label: 'Register author', entityType: 'Author' }],
    },
  ];

  it('a valid control-plane workflows document wins over the env default', async () => {
    const { client } = makeClient([
      {
        id: 'DOC-1',
        kind: 'config',
        name: 'workflows',
        payload: sealPayload(1, wfConfig),
      },
    ]);
    renderApp(
      <App endpoint={endpoint} clientFactory={() => client} workflows={{ workflows: [] }} />,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(await within(nav).findByText('Register a work')).toBeInTheDocument();
  });

  it('an invalid document falls back to env with the error surfaced', async () => {
    const { client } = makeClient([
      {
        id: 'DOC-1',
        kind: 'config',
        name: 'workflows',
        payload: sealPayload(1, [{ id: 'broken' }]),
      },
    ]);
    renderApp(
      <App endpoint={endpoint} clientFactory={() => client} workflows={{ workflows: [] }} />,
    );
    expect(
      await screen.findByText(/control-plane workflows config is invalid/),
    ).toBeInTheDocument();
  });
});

describe('workflow drafts through the control plane (W4.8)', () => {
  it('staging a step writes a draft document to the Mosaic store', async () => {
    const user = userEvent.setup();
    const wf = [
      {
        id: 'solo',
        version: '1',
        label: 'Solo book',
        steps: [{ id: 'book-step', label: 'Add book', entityType: 'Book' }],
      },
    ];
    const { client, docs } = makeClient();
    renderApp(
      <App
        endpoint={endpoint}
        clientFactory={() => client}
        workflows={{ workflows: wf }}
      />,
      '?workflow=solo',
    );

    await user.type(await screen.findByLabelText(/Title/), 'Draft Book');
    await user.click(screen.getByRole('button', { name: 'Stage & continue' }));

    await vi.waitFor(() => {
      const draft = docs.find((d) => d.kind === 'workflowDraft' && d.name === 'solo');
      expect(draft).toBeDefined();
      const payload = JSON.parse(draft!.payload);
      expect(payload.data.state.staged['book-step'].title).toBe('Draft Book');
    });
  });
});


/* ------------------------------------------------------------------ */
/* Ownership in the UI (ADR-0032 ownership amendment)                  */
/* ------------------------------------------------------------------ */

interface OwnedDoc {
  id: string;
  kind: string;
  name: string;
  payload: string;
  owner?: string;
  visibility?: string;
}

/** As makeClient, but on the recipe-1.1.0 shape (owner + visibility). */
function makeOwnedClient(seedDocs: OwnedDoc[] = []) {
  const docs = [...seedDocs];
  const client = fakeClient(
    capableSchema({ documents: true, documentOwnership: true }),
    (query, variables) => {
      if (query.includes('apertureDocuments')) {
        const filter = (variables['filter'] ?? {}) as Record<string, string>;
        return {
          data: {
            apertureDocuments: docs.filter((d) =>
              (['kind', 'name', 'owner', 'visibility'] as const).every(
                (f) => filter[f] == null || String(d[f] ?? '') === filter[f],
              ),
            ),
          },
          error: null,
        };
      }
      if (query.includes('createApertureDocument')) {
        const input = variables['input'] as Record<string, string>;
        const doc = { id: `DOC-${docs.length + 1}`, ...input } as OwnedDoc;
        docs.push(doc);
        return { data: { createApertureDocument: doc }, error: null };
      }
      if (query.includes('updateApertureDocument')) {
        const doc = docs.find((d) => d.id === variables['id']);
        if (doc) Object.assign(doc, variables['input']);
        return { data: { updateApertureDocument: doc ?? null }, error: null };
      }
      return { data: { books: [{ id: 'BK-0001' }], authors: [] }, error: null };
    },
  );
  return { client, docs };
}

const aliceView = (): OwnedDoc => ({
  id: 'DOC-1',
  kind: 'savedView',
  name: 'Alice cohort',
  payload: sealPayload(1, {
    state: { collection: 'books', page: 1 },
    schemaFingerprint: 'unused',
  }),
  owner: 'alice',
  visibility: 'shared',
});

describe('shared views are read-only for non-owners', () => {
  it('shows a shared view but withholds its remove affordance from a non-owner', async () => {
    const { client } = makeOwnedClient([aliceView()]);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} viewer="bob" />);

    // Bob sees Alice's shared view under an owner-qualified id …
    expect(await screen.findByTestId('shared-view-alice-Alice cohort')).toBeInTheDocument();
    // … and is told whose it is, without an affordance to change it.
    expect(screen.getByTestId('shared-view-alice-Alice cohort')).toHaveAttribute(
      'title',
      expect.stringContaining('shared by alice'),
    );
    expect(screen.queryByTestId('remove-saved-view-Alice cohort')).not.toBeInTheDocument();
  });

  it('keeps the remove affordance for the owner', async () => {
    const { client } = makeOwnedClient([aliceView()]);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} viewer="alice" />);
    expect(await screen.findByTestId('remove-saved-view-Alice cohort')).toBeInTheDocument();
  });

  it('reports the per-user partition in the footer', async () => {
    const { client } = makeOwnedClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} viewer="bob" />);
    expect(await screen.findByText(/your own \(bob\)/)).toBeInTheDocument();
  });

  it('says the namespace is shared when there is no viewer — the default today', async () => {
    const { client } = makeOwnedClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);
    expect(await screen.findByText(/shared by everyone using this endpoint/)).toBeInTheDocument();
  });

  it('forks rather than overwrites when a non-owner reuses a shared name', async () => {
    const user = userEvent.setup();
    const { client, docs } = makeOwnedClient([aliceView()]);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} viewer="bob" />, '?collection=books');

    await user.click(await screen.findByRole('button', { name: 'Save view' }));
    await user.type(screen.getByLabelText('View name'), 'Alice cohort');
    // Not an "Overwrite" — it is Bob's own copy alongside Alice's.
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByTestId('remove-saved-view-Alice cohort'); // Bob's copy, removable
    // Both are listed, distinguishable, and no key collides.
    expect(screen.getByTestId('saved-view-Alice cohort')).toBeInTheDocument(); // Bob's
    expect(screen.getByTestId('shared-view-alice-Alice cohort')).toBeInTheDocument(); // Alice's
    expect(docs).toHaveLength(2);
    expect(docs[0].owner).toBe('alice');
    expect(docs[1].owner).toBe('bob');
  });
});
