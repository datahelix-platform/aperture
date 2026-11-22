import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { currentQuerySpec } from '../data/conversation';
import type { ConversationTurn } from '../data/conversation';
import type { ColumnSpec } from './querySpec';
import { useCollectionUrlState } from '../features/collections/urlState';

/**
 * The conversation's shared facts, lifted out of `ChatPanel` because two slots
 * need them and they sit in different columns of the workbench layout.
 *
 * Only the turn list and its suspensions live here — the facts another surface
 * can legitimately ask about. Composer-local concerns (the draft text, which
 * turn is being edited, whether a request is in flight) stay in `ChatPanel`,
 * because nothing outside it has any business reading them.
 *
 * The builder lock is the reason this exists (ADR-0039, design Decision 11):
 * Mosaic's `converse_query_spec` asserts that the wire `query_spec` agrees with
 * what it derives from `turns`, and 400s when they disagree. So once a
 * conversation owns the spec, hand-editing it is a correctness problem, not a
 * taste one — only the *presentation* of the lock is a design choice.
 */
export interface ConversationState {
  turns: ConversationTurn[];
  suspended: string[];
  setTurns: (turns: ConversationTurn[]) => void;
  setSuspended: (ids: string[]) => void;
  /**
   * A conversation owns the current spec, so manual editing is locked out.
   *
   * Keyed on the conversation having actually PRODUCED a spec, not on it
   * having turns. A schema-discovery turn answers a question about what the
   * data holds and deliberately leaves the draft alone, so until some turn
   * proposes a spec there is nothing for the conversation to own and nothing
   * for a hand edit to disagree with. Locking on `turns.length > 0` left the
   * builder disabled AND empty after a discovery turn — a dead panel saying it
   * was busy building something that did not exist.
   */
  locked: boolean;
  /**
   * Drop the conversation and release the lock, clearing the spec it produced.
   *
   * Clearing the URL spec is the part that is easy to forget and wrong to
   * omit: leaving `qs` behind would keep the builder re-running a query with
   * no conversation left on screen to explain where it came from. Nothing is
   * lost that would not already be lost — the transcript is session-only by
   * design, so a refresh discards it regardless (contract Decision 3).
   */
  clear: () => void;
  /**
   * The result table's current columns, slot-spelled (aperture#89), published
   * by the builder so the panel can send them back as the draft's `columns`.
   * `null` until a builder has published any. They live here because the
   * builder owns them and the panel sends them, and the two sit in different
   * columns of the layout.
   */
  columns: ColumnSpec[] | null;
  setColumns: (columns: ColumnSpec[] | null) => void;
}

const ConversationContext = createContext<ConversationState | null>(null);

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [suspended, setSuspended] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnSpec[] | null>(null);
  const urlState = useCollectionUrlState();

  const clear = useCallback(() => {
    setTurns([]);
    setSuspended([]);
    urlState.clearQuerySpec();
  }, [urlState]);

  const value = useMemo(
    () => ({
      turns,
      suspended,
      setTurns,
      setSuspended,
      locked: currentQuerySpec(turns) != null,
      clear,
      columns,
      setColumns,
    }),
    [turns, suspended, clear, columns],
  );

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

/**
 * Null-safe on purpose: the builder renders in deployments with no
 * conversational capability at all, where no provider is mounted. An absent
 * conversation is simply an unlocked one.
 */
export function useConversation(): ConversationState | null {
  return useContext(ConversationContext);
}
