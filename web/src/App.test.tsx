import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import { App } from './App';
import { capableSchema, fakeClient } from './data/testing/fixtures';
import type { GraphQLResult } from './data/scopedClient';

const bookRows = [
  {
    id: 'BK-0001',
    title: 'A First Book',
    published_on: '2021-03-04',
    page_count: 312,
    in_print: true,
    format: 'HARDCOVER',
    author: { id: 'AU-01' },
    reviews: [{ id: 'RV-1' }, { id: 'RV-2' }, { id: 'RV-3' }],
  },
  {
    id: 'BK-0002',
    title: 'A Second Book',
    published_on: null,
    page_count: 1024,
    in_print: false,
    format: 'EBOOK',
    author: null,
    reviews: [],
  },
];

function respond(query: string): GraphQLResult<unknown> {
  if (query.includes('books')) return { data: { books: bookRows }, error: null };
  if (query.includes('authors')) return { data: { authors: [] }, error: null };
  return { data: {}, error: null };
}

function renderApp(ui: ReactNode, searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory>
      {ui}
    </NuqsTestingAdapter>,
  );
}

const endpoint = { url: 'http://example.test/graphql' };

describe('App — the Phase-0 walking skeleton end to end', () => {
  it('shows an honest guidance panel when no endpoint is configured', () => {
    renderApp(<App endpoint={{ url: null }} />);
    expect(screen.getByText(/No data-plane endpoint configured/)).toBeInTheDocument();
    expect(screen.getAllByText(/VITE_GRAPHQL_URL/).length).toBeGreaterThan(0);
  });

  it('derives the collections nav from introspection and renders the first collection', async () => {
    renderApp(<App endpoint={endpoint} clientFactory={() => fakeClient(capableSchema(), respond)} />);

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(await within(nav).findByText('Books')).toBeInTheDocument();
    expect(within(nav).getByText('Authors')).toBeInTheDocument();

    // Table header derives from the column model.
    expect(await screen.findByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
    // Rows render through the slot-kind renderers. Await the first cell:
    // the column headers derive from introspection and can render while the
    // row query is still in flight (skeleton rows), so a sync getByText here
    // is a CI-timing flake. Once one cell is in, the whole row rendered.
    expect(await screen.findByText('BK-0001')).toBeInTheDocument(); // id → mono
    expect(screen.getByText('1,024')).toBeInTheDocument(); // number → formatted
    expect(screen.getByText('AU-01')).toBeInTheDocument(); // ref → target id field
    expect(screen.getByText('3')).toBeInTheDocument(); // refList → count badge
    // Null values render as an honest em dash, not "null".
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('reads the active collection from the URL (shareable state)', async () => {
    renderApp(
      <App endpoint={endpoint} clientFactory={() => fakeClient(capableSchema(), respond)} />,
      '?collection=authors',
    );
    expect(await screen.findByRole('heading', { name: 'Authors' })).toBeInTheDocument();
  });

  it('writes {collection, page} to the URL when navigating', async () => {
    const user = userEvent.setup();
    const client = fakeClient(capableSchema(), respond);
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);

    await user.click(await screen.findByRole('button', { name: /Authors/ }));
    expect(await screen.findByRole('heading', { name: 'Authors' })).toBeInTheDocument();

    // The list query for authors was actually issued (offset page derived from URL state).
    expect(
      client.recorded.some(
        (q) =>
          q.document.includes('authors(limit: $limit, offset: $offset)') &&
          q.variables['limit'] === 25 &&
          q.variables['offset'] === 0,
      ),
    ).toBe(true);
  });
});
