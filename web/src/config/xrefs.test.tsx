import { render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import { App } from '../App';
import { capableSchema, fakeClient } from '../data/testing/fixtures';
import { parseXrefConfig, resolveXrefConfig, xrefUrl } from './xrefs';
import { sealXrefConfig } from './XrefsContext';

describe('xref config (ADR-0015, issue #96)', () => {
  it('has no templates by default', () => {
    expect(resolveXrefConfig({})).toEqual({ templates: {} });
    expect(resolveXrefConfig({ VITE_XREFS: '  ' })).toEqual({ templates: {} });
  });

  it('parses VITE_XREFS', () => {
    expect(
      resolveXrefConfig({ VITE_XREFS: '{"accession":"https://example.org/{value}"}' }),
    ).toEqual({ templates: { accession: 'https://example.org/{value}' } });
  });

  it('surfaces a bad VITE_XREFS and falls back to none (ADR-0029)', () => {
    const resolved = resolveXrefConfig({ VITE_XREFS: 'not-json' });
    expect(resolved.templates).toEqual({});
    expect(resolved.error).toMatch(/VITE_XREFS is invalid/);
  });

  it.each([
    [['a'], /JSON object/],
    [null, /JSON object/],
    [{ accession: 42 }, /accession must be a URL template/],
    [{ accession: '' }, /accession must be a URL template/],
    [{ accession: 'javascript:alert({value})' }, /http\(s\) URL template/],
    [{ accession: '/relative/{value}' }, /http\(s\) URL template/],
    [{ accession: 'https://example.org/' }, /\{value\} placeholder/],
  ])('rejects %j', (raw, message) => {
    expect(() => parseXrefConfig(raw)).toThrow(message);
  });

  it('builds a URL with the encoded value, only for configured fields', () => {
    const templates = { accession: 'https://example.org/{value}?q={value}' };
    expect(xrefUrl('accession', 'A B/1', templates)).toBe(
      'https://example.org/A%20B%2F1?q=A%20B%2F1',
    );
    expect(xrefUrl('other', 'x', templates)).toBeUndefined();
    expect(xrefUrl('accession', null, templates)).toBeUndefined();
    expect(xrefUrl('accession', '', templates)).toBeUndefined();
    expect(xrefUrl('toString', 'x', templates)).toBeUndefined();
  });
});

const endpoint = { url: 'http://example.test/graphql' };
const book = { id: 'BK-0007', title: 'A Deep Book', page_count: 512 };

function makeClient(seedDocs: { id: string; kind: string; name: string; payload: string }[] = []) {
  return fakeClient(capableSchema({ documents: true }), (query, variables) => {
    if (query.includes('apertureDocuments')) {
      const filter = (variables['filter'] ?? {}) as Record<string, string>;
      return {
        data: {
          apertureDocuments: seedDocs.filter(
            (d) =>
              (filter['kind'] == null || d.kind === filter['kind']) &&
              (filter['name'] == null || d.name === filter['name']),
          ),
        },
        error: null,
      };
    }
    if (query.includes('ApertureDetail')) return { data: { book }, error: null };
    if (query.includes('ApertureHistory')) return { data: { entityHistory: [] }, error: null };
    return { data: { books: [book], authors: [] }, error: null };
  });
}

const xrefDoc = (payload: string) => ({ id: 'DOC-X', kind: 'config', name: 'xrefs', payload });

function renderDetail(ui: ReactNode) {
  return render(
    <NuqsTestingAdapter searchParams="?collection=books&entity=BK-0007" hasMemory>
      {ui}
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => window.localStorage.clear());

describe('detail view external links (issue #96)', () => {
  it('renders no external link without config', async () => {
    const client = makeClient();
    renderDetail(<App endpoint={endpoint} clientFactory={() => client} />);
    expect(await screen.findByText('A Deep Book')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /A Deep Book/ })).toBeNull();
  });

  it('renders an external link for a field named by the env config', async () => {
    const client = makeClient();
    renderDetail(
      <App
        endpoint={endpoint}
        clientFactory={() => client}
        xrefs={resolveXrefConfig({ VITE_XREFS: '{"title":"https://example.org/t/{value}"}' })}
      />,
    );
    const link = await screen.findByRole('link', { name: /A Deep Book/ });
    expect(link).toHaveAttribute('href', 'https://example.org/t/A%20Deep%20Book');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('a config/xrefs control-plane document overrides the env default', async () => {
    const client = makeClient([
      xrefDoc(sealXrefConfig({ title: 'https://registry.example.org/{value}' })),
    ]);
    renderDetail(
      <App
        endpoint={endpoint}
        clientFactory={() => client}
        xrefs={resolveXrefConfig({ VITE_XREFS: '{"title":"https://example.org/t/{value}"}' })}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('link', { name: /A Deep Book/ })).toHaveAttribute(
        'href',
        'https://registry.example.org/A%20Deep%20Book',
      ),
    );
  });

  it('an invalid document falls back to env and shows the error (ADR-0029)', async () => {
    const client = makeClient([xrefDoc(sealXrefConfig({ title: 'not-a-url' }))]);
    renderDetail(
      <App
        endpoint={endpoint}
        clientFactory={() => client}
        xrefs={resolveXrefConfig({ VITE_XREFS: '{"title":"https://example.org/t/{value}"}' })}
      />,
    );
    expect(await screen.findByText(/control-plane xref config is invalid/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /A Deep Book/ })).toHaveAttribute(
      'href',
      'https://example.org/t/A%20Deep%20Book',
    );
  });

  it('an invalid env config is shown on the detail view', async () => {
    const client = makeClient();
    renderDetail(
      <App
        endpoint={endpoint}
        clientFactory={() => client}
        xrefs={resolveXrefConfig({ VITE_XREFS: '{' })}
      />,
    );
    expect(await screen.findByText(/VITE_XREFS is invalid/)).toBeInTheDocument();
  });
});
