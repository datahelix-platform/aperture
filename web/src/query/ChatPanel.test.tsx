import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { capableSchema, fakeClient } from '../data/testing/fixtures';
import type { GraphQLResult } from '../data/scopedClient';

const endpoint = { url: 'http://example.test/graphql' };

interface WireTurn {
  id: string;
  utterance: string;
  status: string;
  message: string;
  query_spec: unknown;
}

/**
 * A planning endpoint with just enough behavior to drive the panel: each turn
 * proposes a spec, an unresolvable one asks for clarification, and an edit
 * replays the list so a turn that depended on the edited one suspends.
 */
function conversationalClient(
  options: {
    anchor?: string;
    criteria?: unknown[];
    /** A proposal's `columns` (aperture#89), slot-spelled. */
    columns?: unknown[];
    /** Rows the list queries answer with, so a Run has something to show. */
    books?: unknown[];
    /** Adds `Author.books` (a to-many edge) to the schema. */
    authorDetail?: boolean;
  } = {},
) {
  const anchor = options.anchor ?? 'Book';
  const criteria = options.criteria ?? [];
  const schema = capableSchema({ conversational: true, authorDetail: options.authorDetail });
  const client = fakeClient(schema, (query, variables) => {
    if (!query.includes('ApertureConverse')) {
      return { data: { books: options.books ?? [], authors: [] }, error: null } as GraphQLResult<unknown>;
    }
    const utterance = variables['utterance'] as string;
    const prior = (variables['turns'] as WireTurn[] | undefined) ?? [];
    const editId = variables['editTurnId'] as string | undefined;

    const plan = (text: string) =>
      /nothing|xyzzy/.test(text)
        ? { status: 'clarification', message: 'Which field did you mean?', query_spec: null }
        : {
            status: 'proposal',
            message: `Filtering to ${text}.`,
            query_spec: {
              v: 1,
              anchor,
              mode: 'AND',
              criteria,
              ...(options.columns ? { columns: options.columns } : {}),
            },
          };

    if (editId) {
      const i = prior.findIndex((t) => t.id === editId);
      const turns = prior.map((t, j) => {
        if (j === i) return { ...t, utterance, ...plan(utterance) };
        // Anything after the edited turn that had a spec loses it.
        if (j > i && t.status === 'proposal') {
          return { ...t, status: 'suspended', message: 'No longer applies.', query_spec: null };
        }
        return t;
      });
      return {
        data: {
          converseQuerySpec: {
            turn: turns[i],
            turns,
            suspended_turn_ids: turns.filter((t) => t.status === 'suspended').map((t) => t.id),
          },
        },
        error: null,
      };
    }

    const turn = { id: `t${prior.length + 1}`, utterance, ...plan(utterance) };
    return {
      data: {
        converseQuerySpec: { turn, turns: [...prior, turn], suspended_turn_ids: [] },
      },
      error: null,
    };
  });
  return client;
}

function renderApp(ui: ReactNode, searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory>
      {ui}
    </NuqsTestingAdapter>,
  );
}

describe('ChatPanel (ADR-0039)', () => {
  it('stays off when the endpoint advertises no conversational mutation', async () => {
    const client = fakeClient(capableSchema(), () => ({
      data: { books: [], authors: [] },
      error: null,
    }));
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');
    await screen.findByTestId('query-builder');
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  });

  it('stays out of the inspector while browsing a collection', async () => {
    const client = conversationalClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />);
    await screen.findByTestId('facet-panel');
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  });

  it('composes turns and shows the draft spec', async () => {
    const user = userEvent.setup();
    const client = conversationalClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Filtering to recent books.')).toBeInTheDocument();
    // The artifact reads back as language, in the builder's own words.
    const prose = await screen.findByTestId('spec-prose');
    expect(prose).toHaveTextContent('Rows are');
  });

  it('sends the prior turns and the draft back on the next turn', async () => {
    const user = userEvent.setup();
    const client = conversationalClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    const input = screen.getByRole('textbox', { name: 'Describe the query' });
    await user.type(input, 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to recent books.');
    await user.type(input, 'only hardbacks');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to only hardbacks.');

    const second = client.recorded.filter((r) => r.document.includes('ApertureConverse'))[1];
    expect((second.variables['turns'] as WireTurn[]).map((t) => t.utterance)).toEqual([
      'recent books',
    ]);
    expect(second.variables['querySpec']).toMatchObject({ anchor: 'Book' });
  });

  // The v2 canonicalization (task 4.1) is what makes this work: the planner
  // names its anchor by LinkML class (`Book`) and the artifact now speaks the
  // same vocabulary, so the handoff runs instead of degrading.
  it('hands a spec anchored by LinkML class name to the builder', async () => {
    const user = userEvent.setup();
    const client = conversationalClient({ anchor: 'Book' });
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to recent books.');

    expect(screen.getByRole('button', { name: 'Run this query' })).toBeEnabled();
    expect(screen.queryByText(/exposes no type/)).not.toBeInTheDocument();
  });

  // Honest degradation survives v2 for the case that is still real (ADR-0029):
  // an anchor this endpoint has no type for.
  it('refuses a spec whose anchor the endpoint exposes no type for', async () => {
    const user = userEvent.setup();
    const client = conversationalClient({ anchor: 'Ghost' });
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to recent books.');

    expect(screen.getByRole('button', { name: 'Run this query' })).toBeDisabled();
    expect(screen.getByText(/exposes no type/)).toBeInTheDocument();
  });

  /**
   * The handoff writes the spec to the URL, which auto-runs it — but the
   * builder's draft is its own state. Without an adopt-on-change sync the
   * planner's criteria never appear in the editor, and the next Run silently
   * executes whatever empty draft was on screen instead of the query the user
   * just approved.
   */
  it('loads the proposed criteria into the builder, not just the URL', async () => {
    const user = userEvent.setup();
    const client = conversationalClient({
      criteria: [{ kind: 'field', slot: 'title', op: 'eq', value: 'Dune' }],
    });
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'books named Dune');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to books named Dune.');

    // No second click: a proposal reaches the builder on arrival. Leaving it
    // behind a transfer button produced a locked builder ("the composer is
    // building this query") still showing the previous anchor, beside a
    // proposal it claimed to own -- which reads as nothing having happened.
    const rows = await screen.findAllByTestId('query-condition');
    expect(rows).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Field' })).toHaveValue('title');
  });

  it('still requires an explicit Run — planning is not executing (ADR-0039)', async () => {
    const user = userEvent.setup();
    const client = conversationalClient({
      criteria: [{ kind: 'field', slot: 'title', op: 'eq', value: 'Dune' }],
    });
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'books named Dune');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to books named Dune.');
    await screen.findAllByTestId('query-condition');

    // The spec is in the builder, and nothing has run. Auto-applying removes a
    // transfer step; it must not remove the user's decision to execute.
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
  });

  /**
   * Design Decision 11. Not presentation: Mosaic asserts the wire query_spec
   * agrees with what it derives from `turns` and 400s otherwise, so a hand-edit
   * under a live conversation would break the next turn.
   */
  it('locks the manual builder once a conversation owns the spec, and unlocks on clear', async () => {
    const user = userEvent.setup();
    const client = conversationalClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    expect(screen.getByRole('combobox', { name: 'Anchor' })).toBeEnabled();

    await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to recent books.');

    // Read-only, not hidden — the query stays legible.
    expect(screen.getByRole('combobox', { name: 'Anchor' })).toBeDisabled();
    expect(screen.getByText(/composer is building this query/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Clear conversation/i }));
    expect(screen.getByRole('combobox', { name: 'Anchor' })).toBeEnabled();
  });

  /**
   * A query the chat built and ran must be savable. Save view used to sit in the
   * builder's fieldset, so the lock above disabled it exactly when a
   * conversation owned the query -- the one case with no manual way round it.
   */
  it('lets a query the conversation built and ran be saved as a view', async () => {
    const user = userEvent.setup();
    const client = conversationalClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to recent books.');
    await user.click(screen.getByRole('button', { name: 'Run this query' }));
    await screen.findByTestId('query-results');

    // The builder is still locked; saving is not an edit, so it is not.
    expect(screen.getByRole('combobox', { name: 'Anchor' })).toBeDisabled();
    const save = screen.getByTestId('save-view');
    expect(save).toBeEnabled();

    await user.click(save);
    await user.type(screen.getByLabelText('View name'), 'Recent books');
    await user.click(screen.getByTestId('save-view-confirm'));

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(await within(nav).findByText('Recent books')).toBeInTheDocument();
  });

  it('flags turns an edit invalidated instead of dropping them', async () => {
    const user = userEvent.setup();
    const client = conversationalClient();
    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');

    await screen.findByTestId('chat-panel');
    const input = screen.getByRole('textbox', { name: 'Describe the query' });
    await user.type(input, 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to recent books.');
    await user.type(input, 'only hardbacks');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to only hardbacks.');

    // Rewind turn 1; turn 2 depended on it.
    await user.click(screen.getAllByRole('button', { name: /Rewrite turn 1/ })[0]);
    await user.clear(input);
    await user.type(input, 'xyzzy');
    await user.click(screen.getByRole('button', { name: 'Redo turn' }));

    expect(await screen.findByText('No longer applies.')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /1 turn needs re-wording/ }),
    ).toBeInTheDocument();
    // Flagged, not dropped — the original wording is still on screen.
    expect(screen.getByText('only hardbacks')).toBeInTheDocument();
  });

  /**
   * Mosaic's MCP boundary re-validates every candidate spec and, on failure,
   * returns a bare error turn with NO `turns` list at all (`mcp/server.py`;
   * the ADR-0010 relay re-validates the proposed turn and every recomputed
   * one). Its own message says "Nothing was applied", so the conversation is
   * still current — the error is one more turn on the end, not a reset. This
   * is the reverse-edge case of mosaic#204 arriving as a real response.
   */
  it('keeps the transcript when the server rejects a spec with a listless error turn', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const client = fakeClient(capableSchema({ conversational: true }), (query, variables) => {
      if (!query.includes('ApertureConverse')) {
        return { data: { books: [], authors: [] }, error: null } as GraphQLResult<unknown>;
      }
      calls += 1;
      const utterance = variables['utterance'] as string;
      if (calls === 1) {
        const turn = {
          id: 't1',
          utterance,
          status: 'proposal',
          message: 'Filtering to recent books.',
          query_spec: { v: 1, anchor: 'Book', mode: 'AND', criteria: [] },
        };
        return {
          data: { converseQuerySpec: { turn, turns: [turn], suspended_turn_ids: [] } },
          error: null,
        };
      }
      // The boundary's rejection shape: a turn, no list, no suspensions.
      return {
        data: {
          converseQuerySpec: {
            turn: {
              id: 'err',
              utterance,
              status: 'error',
              message: 'Planner proposed a QuerySpec that failed validation (UNKNOWN_EDGE). Nothing was applied.',
              query_spec: null,
            },
            suspended_turn_ids: [],
          },
        },
        error: null,
      };
    });

    renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');
    await screen.findByTestId('chat-panel');
    const input = screen.getByRole('textbox', { name: 'Describe the query' });

    await user.type(input, 'recent books');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Filtering to recent books.');

    await user.type(input, 'the donors of those samples');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/failed validation/);

    // The first turn survived the rejection — both turns are on screen.
    expect(screen.getByText('Filtering to recent books.')).toBeInTheDocument();
    expect(screen.getAllByTestId('chat-turn')).toHaveLength(2);
  });

  // aperture#89: a proposal's `columns` reach the result table.
  describe('proposal columns', () => {
    const columns = [
      { path: ['author', 'name'] },
      { path: ['author', 'books', 'title'], mode: 'explode' },
      { path: ['publisher', 'name'] },
    ];
    const books = [
      {
        id: 'b1',
        title: 'Dune',
        author: { id: 'a1', name: 'Herbert', books: [{ id: 'b1', title: 'Dune' }, { id: 'b2', title: 'Children of Dune' }] },
      },
    ];

    async function propose(user: ReturnType<typeof userEvent.setup>, client: ReturnType<typeof conversationalClient>) {
      renderApp(<App endpoint={endpoint} clientFactory={() => client} />, '?view=query');
      await screen.findByTestId('chat-panel');
      await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'books with authors');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Filtering to books with authors.');
    }

    it('seeds a to-one and an exploded to-many path, and states the grain', async () => {
      const user = userEvent.setup();
      const client = conversationalClient({ columns, books, authorDetail: true });
      await propose(user, client);

      // The builder is locked under a conversation; the panel's handoff runs it.
      await user.click(screen.getByRole('button', { name: 'Run this query' }));
      const table = await screen.findByRole('table');
      expect(within(table).getByRole('columnheader', { name: /Author → Name/ })).toBeInTheDocument();
      expect(within(table).getByRole('columnheader', { name: /Author → Book → Title/ })).toBeInTheDocument();
      // One book, exploded by its author's two books: two rows, and the note says so.
      expect(await screen.findByTestId('query-grain')).toHaveTextContent(/2\s+rows from 1/);
      // The draft does not keep the columns; `cols` holds them (GraphQL spelling).
      const run = client.recorded.filter((r) => r.document.includes('books')).pop()!;
      expect(run.document).toMatch(/author\s*\{[^}]*name/);
    });

    it('lists a column whose hop does not resolve, with its reason', async () => {
      const user = userEvent.setup();
      const client = conversationalClient({ columns, books, authorDetail: true });
      await propose(user, client);

      const dropped = await screen.findByTestId('query-columns-dropped');
      expect(dropped).toHaveTextContent('publisher → name');
      expect(dropped).toHaveTextContent(/no field “publisher”/);
    });

    it('sends the table columns back, slot-spelled, and the derived spec verbatim when unchanged', async () => {
      const user = userEvent.setup();
      const client = conversationalClient({ columns: columns.slice(0, 2), books, authorDetail: true });
      await propose(user, client);

      await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'only hardbacks');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Filtering to only hardbacks.');

      const second = client.recorded.filter((r) => r.document.includes('ApertureConverse'))[1]!;
      const sent = second.variables['querySpec'] as { columns: unknown };
      const derived = (second.variables['turns'] as WireTurn[])[0]!.query_spec as { columns: unknown };
      expect(sent).toEqual(derived);
      expect(sent.columns).toEqual(columns.slice(0, 2));
    });

    it('clears a path column that no longer resolves when a proposal moves the anchor', async () => {
      // aperture#89 review: a column-less proposal on another anchor left the
      // Book-relative `author → name` in the table state, and the round trip
      // dropped it without a word. It is cleared with the anchor change.
      const user = userEvent.setup();
      const client = conversationalClient({ anchor: 'Author', books, authorDetail: true });
      const urls: string[] = [];
      render(
        <NuqsTestingAdapter
          searchParams={`?view=query&cols=${encodeURIComponent(JSON.stringify({ paths: [{ path: ['author', 'name'] }] }))}`}
          hasMemory
          onUrlUpdate={(e) => urls.push(e.queryString)}
        >
          <App endpoint={endpoint} clientFactory={() => client} />
        </NuqsTestingAdapter>,
      );
      await screen.findByTestId('chat-panel');
      await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'all authors');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Filtering to all authors.');

      await waitFor(() => expect(urls.length).toBeGreaterThan(0));
      const cols = new URLSearchParams(urls[urls.length - 1]).get('cols');
      expect(cols ?? '').not.toContain('author');
    });

    it('keeps the reader\'s columns when a proposal says nothing about columns', async () => {
      const user = userEvent.setup();
      const client = conversationalClient({ books, authorDetail: true });
      renderApp(
        <App endpoint={endpoint} clientFactory={() => client} />,
        `?view=query&cols=${encodeURIComponent(JSON.stringify({ paths: [{ path: ['author', 'name'] }] }))}`,
      );
      await screen.findByTestId('chat-panel');
      await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'recent books');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Filtering to recent books.');

      await user.type(screen.getByRole('textbox', { name: 'Describe the query' }), 'only hardbacks');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Filtering to only hardbacks.');

      // The proposal carried no columns, the table has one: that is an edit,
      // so it goes back as one.
      const second = client.recorded.filter((r) => r.document.includes('ApertureConverse'))[1]!;
      expect((second.variables['querySpec'] as { columns: unknown }).columns).toEqual([{ path: ['author', 'name'] }]);
    });
  });
});
