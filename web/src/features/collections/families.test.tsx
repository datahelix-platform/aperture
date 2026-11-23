import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { UrlUpdateEvent } from 'nuqs/adapters/testing';
import { App } from '../../App';
import { familyIntrospection, fakeClient } from '../../data/testing/fixtures';

// Families in the running app (Mosaic ADR-0014, Aperture ADR-0042), on the live
// mosaic v0.16.0 capture.
const endpoint = { url: 'http://example.test/graphql' };

const sampleRows = [
  { __typename: 'Brain', id: 'br1', label: 'brain', producedBy: { id: 'bb1' } },
  { __typename: 'Blood', id: 'bl1', label: 'blood', producedBy: { id: 'pr1' } },
];

function client() {
  return fakeClient(familyIntrospection, (query) => {
    if (query.includes('samples(')) {
      return { data: { samples: { items: sampleRows, total: 2, limit: 50, offset: 0 } }, error: null };
    }
    const m = /(\w+)\(/.exec(query.replace(/^\s*query\s+\w+(\([^)]*\))?\s*\{/, ''));
    const root = m?.[1] ?? 'none';
    return { data: { [root]: { items: [], total: 0, limit: 50, offset: 0 } }, error: null };
  });
}

function renderApp(searchParams: string, onUrlUpdate?: (e: UrlUpdateEvent) => void) {
  const fake = client();
  render(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory onUrlUpdate={onUrlUpdate}>
      <App endpoint={endpoint} clientFactory={() => fake} />
    </NuqsTestingAdapter>,
  );
  return fake;
}

describe('families (ADR-0042)', () => {
  it('lists a family as one nav entry, marked, with its kinds in the tooltip', async () => {
    renderApp('');
    const marker = await screen.findByTestId('nav-family-samples');
    const entry = marker.closest('button')!;
    expect(entry).toHaveTextContent('Samples');
    expect(entry.getAttribute('title')).toMatch(/family: Sample \(read-only\)\. Kinds: Blood, Brain/);
    // A kind is still its own entry, unmarked.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByText('Brains')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-family-brains')).toBeNull();
  });

  it('shows a Kind column and opens a row on its kind\'s record page', async () => {
    const urls: string[] = [];
    const fake = renderApp('?collection=samples', (e) => urls.push(e.queryString));
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: /Kind/ })).toBeInTheDocument();
    expect(await within(table).findByText('Brain')).toBeInTheDocument();
    // The list asks for each row's kind.
    expect(fake.queries.find((q) => q.includes('samples('))).toMatch(/__typename/);

    await userEvent.setup().click(within(table).getByRole('button', { name: 'br1' }));
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    const params = new URLSearchParams(urls[urls.length - 1]);
    expect(params.get('collection')).toBe('brains');
  });

  it('offers no create action on a family', async () => {
    renderApp('?collection=samples');
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /^(New|Create|Add)\b/ })).toBeNull();
  });
});
