import { useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilities, useDataSource } from '../data/DataSourceContext';
import type { ConversationTurn } from '../data/conversation';
import { currentQuerySpec } from '../data/conversation';
import type { CollectionModel } from '../data/schemaModel';
import { useCollectionUrlState } from '../features/collections/urlState';
import { canonicalizeQuerySpec, draftForWire, readQuerySpec } from './querySpec';
import { useConversation } from './ConversationContext';
import { SpecProse } from './specProse';
import './query.css';

/**
 * The conversational query panel (ADR-0039): describe a query in prose, watch
 * the `QuerySpec` assemble, hand it to the builder to run.
 *
 * Capability-gated and slot-resident. It renders only in the query context —
 * where the `queryWorkbench` layout gives it a composer column beside the
 * artifact it is building — and only when the endpoint advertises the
 * conversational mutation, so an endpoint without one shows no chat
 * affordance at all (ADR-0029).
 *
 * Aperture holds no conversation state beyond this component: the server owns
 * the turn list and returns it whole on every call (editing an earlier turn
 * recomputes the later ones server-side), so `turns` is always replaced, never
 * merged. A refresh loses the transcript by design — the `QuerySpec` it
 * produced survives in the URL, which is the artifact that matters.
 */
export function ChatPanel() {
  const state = useDataSource();
  const capabilities = useCapabilities();
  const urlState = useCollectionUrlState();

  // Shared with the builder, which locks while a conversation owns the spec.
  const conversation = useConversation();
  const turns = conversation?.turns ?? [];
  const suspended = conversation?.suspended ?? [];
  const setTurns = conversation?.setTurns ?? (() => {});
  const setSuspended = conversation?.setSuspended ?? (() => {});
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<ConversationTurn | null>(null);
  const [pending, setPending] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const inFlight = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const collections = state.status === 'ready' ? state.source.collections : [];
  const starters = useMemo(() => starterPrompts(collections), [collections]);

  /**
   * A real elapsed count, not fabricated progress. The planning call is one
   * opaque HTTP round trip with no intermediate signal, so staged text
   * ("drafting…", "validating…") would invent state that does not exist and
   * can visibly desync from reality. A turn may legitimately run to the
   * service's full timeout, and a silent wait that long reads as frozen —
   * worse live in front of a room (design Decision 10).
   */
  useEffect(() => {
    if (startedAt == null) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [startedAt]);

  // Abandon any in-flight turn if the panel goes away, so an aborted request
  // never resolves into an unmounted component.
  useEffect(() => () => inFlight.current?.abort(), []);

  // Keep the newest turn in view: the transcript outgrows the column quickly,
  // and a reply the user never sees reads as a hang.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [turns, pending]);

  if (state.status !== 'ready') return null;
  if (urlState.view !== 'query') return null;
  if (!capabilities.conversationalQuery) return null;

  const source = state.source;
  const spec = currentQuerySpec(turns);

  const cancel = () => {
    const controller = inFlight.current;
    if (!controller) return;
    // Orphan the turn FIRST, then tear the UI down here rather than waiting for
    // the request promise to settle: urql does not reliably settle an aborted
    // operation, so a teardown that depended on `send`'s finally would leave
    // the composer stuck "Planning" forever. The abort still fires, to release
    // the connection — a turn can run to the planner's full timeout.
    inFlight.current = null;
    controller.abort();
    setPending(false);
    setStartedAt(null);
  };

  const send = async (text?: string) => {
    const utterance = (text ?? draft).trim();
    if (utterance === '' || pending) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    setStartedAt(Date.now());
    setError(null);
    try {
      // Turns are strictly ordered and the server derives the draft from the
      // whole list, so exactly one is ever in flight (the composer is disabled
      // meanwhile) and the response's list replaces ours wholesale.
      const response = await source.converse(
        {
          utterance,
          // The turn-derived draft, with the result table's columns in
          // place of the proposal's when the reader has changed them
          // (aperture#89). Needs a Reel that accepts an edited draft.
          querySpec: draftForWire(spec, conversation?.columns ?? null),
          turns,
          editTurnId: editing?.id ?? null,
        },
        controller.signal,
      );
      // A cancelled turn may still resolve late; it no longer owns the slot,
      // so its response must not land on top of whatever replaced it.
      if (inFlight.current !== controller) return;
      // An authoritative list replaces ours wholesale (the server recomputes
      // downstream turns after an edit). Its absence means append, not reset:
      // the boundary returns a bare error turn carrying no list when a
      // candidate spec fails re-validation, and its own message says "Nothing
      // was applied" — so the prior transcript is still current and the error
      // is one more turn on the end. Collapsing to the error alone would lose
      // the user's conversation to a server-side rejection (ADR-0025).
      setTurns(response.turns ?? [...turns, response.turn]);
      setSuspended(response.suspendedTurnIds);
      setDraft('');
      setEditing(null);
    } catch (e) {
      // An abort is the user's own choice, not a failure to report. The draft
      // stays in the composer so the same utterance can be retried — which
      // Mosaic's own timeout message explicitly sanctions as safe.
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      // A newer turn may already own the slot if this one was abandoned.
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
        setStartedAt(null);
      }
    }
  };

  const beginEdit = (turn: ConversationTurn) => {
    setEditing(turn);
    setDraft(turn.utterance);
    inputRef.current?.focus();
  };

  const reset = () => {
    // Clears the turn list AND the spec it produced (see ConversationContext).
    conversation?.clear();
    setEditing(null);
    setError(null);
    setDraft('');
  };

  return (
    <section className="chat" data-testid="chat-panel" aria-label="Conversation">
      <header className="chat-head">
        <div className="chat-head-titles">
          <span className="chat-eyebrow">Composer</span>
          <h2 className="chat-title">Describe the query</h2>
        </div>
        {turns.length > 0 && (
          <button type="button" className="chat-ghost" onClick={reset}>
            Clear
          </button>
        )}
      </header>

      <div className="chat-body" ref={bodyRef}>
        {turns.length === 0 && !pending ? (
          <div className="chat-intro">
            <p className="chat-intro-lead">
              Ask in plain language. Each reply proposes a query you can read, refine, and run —
              the wording stays editable, so you can go back and change any turn.
            </p>
            {starters.length > 0 && (
              <div className="chat-starters">
                <span className="chat-eyebrow">Starting points</span>
                {starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chat-starter"
                    // Fills the composer rather than sending: these are shaped
                    // from the live schema, but the planner still has to agree,
                    // and a chip that fires blind would promise that it will.
                    onClick={() => {
                      setDraft(s);
                      inputRef.current?.focus();
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          turns.map((turn, i) => (
            <TurnView
              key={turn.id}
              turn={turn}
              index={i + 1}
              suspended={suspended.includes(turn.id)}
              editing={editing?.id === turn.id}
              onEdit={turn.editable ? () => beginEdit(turn) : undefined}
            />
          ))
        )}

        {pending && (
          <div className="chat-reply chat-reply-pending" role="status">
            <span className="chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="chat-pending-label">Planning</span>
            <span className="chat-elapsed" aria-hidden="true">
              {elapsed}s
            </span>
            <button type="button" className="chat-inline-link" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}

        {error && (
          <div className="chat-error" role="alert">
            {error}
          </div>
        )}
      </div>

      {spec != null && (
        <SpecPane
          spec={spec}
          collections={collections}
          showJson={showJson}
          onToggleJson={() => setShowJson(!showJson)}
        />
      )}

      <div className="chat-compose">
        {/* The transcript scrolls, so an invalidated turn can sit out of view —
            a standing count keeps it glanceable without relocating the turn
            away from where the break happened (ADR-0025). */}
        {suspended.length > 0 && (
          <button
            type="button"
            className="chat-suspended-banner"
            onClick={() => {
              const first = turns.find((t) => suspended.includes(t.id));
              if (first) beginEdit(first);
            }}
          >
            <span className="chat-dot chat-dot-warning" aria-hidden="true" />
            {suspended.length} turn{suspended.length > 1 ? 's' : ''} need
            {suspended.length > 1 ? '' : 's'} re-wording after your edit
          </button>
        )}
        {editing && (
          <div className="chat-editing-note">
            <span className="chat-dot chat-dot-warning" aria-hidden="true" />
            Rewriting turn {turns.findIndex((t) => t.id === editing.id) + 1} — later turns
            recompute.{' '}
            <button
              type="button"
              className="chat-inline-link"
              onClick={() => {
                setEditing(null);
                setDraft('');
              }}
            >
              Cancel
            </button>
          </div>
        )}
        <div className="chat-field">
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={2}
            value={draft}
            disabled={pending}
            aria-label="Describe the query"
            placeholder={pending ? 'Waiting for the last turn…' : 'Describe what you want…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="chat-field-foot">
            <span className="chat-hint">Enter to send · Shift+Enter for a new line</span>
            <button
              type="button"
              className="chat-send"
              disabled={pending || draft.trim() === ''}
              onClick={() => void send()}
            >
              {editing ? 'Redo turn' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// `clarification` covers two different turns that the wire cannot tell apart:
// a question back, and a schema-discovery reply that ANSWERED what was asked.
// Exon distinguishes them internally (`resolution: "answered"`), but that marker
// is deliberately not on the wire -- Mosaic's ConversationTurn does not carry it
// -- so the label has to be true of both. What they genuinely share is that the
// draft did not move, which is what this says. Labelling it "needs an answer"
// told a user who had just been answered that they still owed a reply.
const STATUS_LABELS: Record<string, string> = {
  proposal: 'proposed',
  clarification: 'no query change',
  suspended: 'needs re-wording',
  error: "couldn't run",
};

function TurnView({
  turn,
  index,
  suspended,
  editing,
  onEdit,
}: {
  turn: ConversationTurn;
  index: number;
  suspended: boolean;
  editing: boolean;
  onEdit?: () => void;
}) {
  const status = suspended ? 'suspended' : turn.status;
  return (
    <article className="chat-turn" data-testid="chat-turn" data-status={status}>
      <div className="chat-said">
        <p className="chat-bubble">{turn.utterance}</p>
        {/* Rewind addresses a turn by its server id; a turn the server never
            named (an error turn carries `id: null`) cannot be redone, so the
            affordance is absent rather than present-and-broken. */}
        {onEdit && (
          <button
            type="button"
            className="chat-edit"
            onClick={onEdit}
            disabled={editing}
            aria-label={`Rewrite turn ${index}`}
          >
            {editing ? 'editing…' : 'rewrite'}
          </button>
        )}
      </div>
      <div className={`chat-reply chat-reply-${status}`}>
        <p className="chat-message">{turn.message}</p>
        <div className="chat-meta">
          <span className={`chat-dot chat-dot-${status}`} aria-hidden="true" />
          <span className="chat-status">{STATUS_LABELS[status] ?? status}</span>
          <span className="chat-turn-index">turn {index}</span>
        </div>
        {status === 'suspended' && (
          <p className="chat-suspended-note">
            An earlier edit invalidated this — flagged, not dropped. Re-word it to bring it back.
          </p>
        )}
      </div>
    </article>
  );
}

/**
 * The spec the conversation has built, read back in the builder's own words.
 *
 * Since the v2 canonicalization the artifact is LinkML-spelled end to end, so
 * a proposal naming `anchor: "Sample"` and `edge: "donor"` resolves directly
 * against the introspected schema — no translation, and the handoff runs.
 *
 * The degradation stays for the case that is still real: an anchor this
 * endpoint exposes no type for. Running a spec whose anchor silently didn't
 * match would execute a different query than the words above it describe
 * (ADR-0029).
 */
function SpecPane({
  spec,
  collections,
  showJson,
  onToggleJson,
}: {
  spec: unknown;
  collections: readonly CollectionModel[];
  showJson: boolean;
  onToggleJson: () => void;
}) {
  const urlState = useCollectionUrlState();
  // A planning service already emits the platform spelling; canonicalizing is
  // for a spec replayed from an older transcript carrying the legacy dialect.
  // Non-throwing: `spec` is arbitrary server JSON off the wire, and a throw
  // here would unmount the app rather than degrade (no ErrorBoundary).
  const parsed = readQuerySpec(spec);
  const shaped = parsed ? canonicalizeQuerySpec(parsed, [...collections]) : null;

  return (
    <section className="chat-spec" aria-label="Proposed query">
      <header className="chat-spec-head">
        <span className="chat-eyebrow">Proposed query</span>
        <button type="button" className="chat-ghost" onClick={onToggleJson}>
          {showJson ? 'Hide JSON' : 'JSON'}
        </button>
      </header>

      {shaped ? (
        <SpecProse spec={shaped} collections={collections} />
      ) : (
        <p className="chat-spec-note">The proposed spec isn’t a shape this build reads.</p>
      )}

      {showJson && <pre className="chat-spec-json">{JSON.stringify(spec, null, 2)}</pre>}

      <div className="chat-spec-foot">
        {/*
          Naming what the click does. Writing the spec to the URL IS execution
          in this builder -- `executed = urlState.querySpec` -- so "Use in
          builder" undersold it: the query ran. ADR-0039 wants the user's run to
          be a deliberate act, which it cannot be while the button describes a
          transfer. The builder's own Run does the same thing; this is the copy
          of it that sits beside the proposal.
        */}
        <button
          type="button"
          className="chat-primary"
          disabled={!shaped}
          onClick={() => shaped && urlState.setQuerySpec(shaped)}
        >
          Run this query
        </button>
        {/* One branch, because canonicalization succeeding means the anchor
            resolves by construction — it is built from a collection that was
            just found. `null` is the only failure, and it means the anchor
            matched neither a type nor a collection. */}
        {parsed && !shaped && (
          <p className="chat-spec-note">
            <span className="chat-dot chat-dot-warning" aria-hidden="true" />
            This endpoint exposes no type <code>{String(parsed.anchor)}</code> — shown, but not
            run, since running it would query something other than what the words above describe.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Opening suggestions, shaped from the live schema rather than written in
 * source — Aperture carries no domain nouns (ADR-0002), so these have to come
 * from whatever the endpoint exposes. They fill the composer; they do not
 * promise the planner will agree.
 */
function starterPrompts(collections: readonly CollectionModel[]): string[] {
  const prompts: string[] = [];
  for (const collection of collections.slice(0, 3)) {
    const label = collection.label.toLowerCase();
    const facet = collection.detailColumns.find(
      (c) => c.kind === 'enum' && (c.enumValues?.length ?? 0) > 0,
    );
    if (facet?.enumValues?.[0]) {
      prompts.push(`${label} where ${facet.label.toLowerCase()} is ${facet.enumValues[0]}`);
    } else if (prompts.length === 0) {
      prompts.push(`all ${label}`);
    }
    if (prompts.length === 2) break;
  }
  return prompts;
}
