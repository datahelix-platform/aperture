import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MosaicSource } from '../data/mosaicSource';
import type { CollectionModel } from '../data/schemaModel';
import { slotName } from '../data/schemaModel';
import { renderPathCell, isPathRightAligned } from '../features/collections/cells';
import type { ManyMode, PathColumn } from '../data/selection';
import { explodeKey, flattenRows, normalizeExplode, pathKey, selectionForPaths } from '../data/selection';
import { toCSVPaths, toJSONExportPaths } from '../features/collections/export';
import { useCollectionUrlState } from '../features/collections/urlState';
import { useNavView } from '../nav/NavConfigContext';
import { downloadFile } from '../features/collections/export';
import type { QueryRunResult } from './planner';
import { runQuerySpec, SEMIJOIN_CAP } from './planner';
import type {
  Criterion,
  DroppedColumn,
  FieldCondition,
  FilterSlot,
  QueryEdge,
  QueryOp,
  QuerySpec,
  RelatedCondition,
} from './querySpec';
import {
  deriveEdges,
  emptyQuerySpec,
  filterSlots,
  opsForKind,
  filterOpMember,
  resolveAnchor,
  canonicalizeQuerySpec,
  readQuerySpec,
  validateQuerySpec,
} from './querySpec';
import {
  decodeColumns,
  encodeColumns,
  resolvePath,
  seedFromProposal,
  toPathColumn,
  wireColumns,
} from './columnView';
import { currentQuerySpec } from '../data/conversation';
import { useConversation } from './ConversationContext';
import { OP_LABELS } from './specProse';
import type { ColumnModel } from '../data/schemaModel';
import { FieldsPanel } from './FieldsPanel';
import { SaveViewButton } from '../features/collections/SaveViewButton';
import { namedSlots, subjectCollection } from './namedSlots';
import './query.css';

/**
 * The cross-class query builder (ADR-0035): anchor picker, criteria rows
 * (field / operator / value, offered per slot kind AND per the endpoint's
 * introspected FilterOp vocabulary), and Atlas-idiom relationship criteria
 * ("having at least one … where …"). The QuerySpec artifact lives in the URL;
 * Run compiles it through the planner (server-first, semijoin compensation).
 */

const PAGE_SIZE = 25;
const EXPORT_CAP = 5000;
const EXPORT_PAGE_SIZE = 100;

function availableOps(slot: FilterSlot, advertised: readonly string[]): QueryOp[] {
  const server = new Set(advertised);
  return opsForKind(slot.kind).filter((op) => server.has(filterOpMember(op)));
}

function coerceValue(slot: FilterSlot, op: QueryOp, raw: string): unknown {
  if (op === 'is_null') return raw === 'true';
  if (op === 'in') {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return slot.kind === 'number' ? parts.map(Number) : parts;
  }
  if (slot.kind === 'number') return raw === '' ? '' : Number(raw);
  if (slot.kind === 'boolean') return raw === 'true';
  return raw;
}

function rawValue(condition: FieldCondition): string {
  if (condition.op === 'in' && Array.isArray(condition.value)) {
    return condition.value.join(', ');
  }
  return condition.value == null ? '' : String(condition.value);
}

function ConditionEditor({
  condition,
  slots,
  advertisedOps,
  onChange,
  onRemove,
}: {
  condition: FieldCondition;
  slots: FilterSlot[];
  advertisedOps: readonly string[];
  onChange: (next: FieldCondition) => void;
  onRemove: () => void;
}) {
  const slot = slots.find((s) => s.slot === condition.slot) ?? slots[0];
  const ops = slot ? availableOps(slot, advertisedOps) : [];

  const setSlot = (name: string) => {
    const next = slots.find((s) => s.slot === name);
    if (!next) return;
    const nextOps = availableOps(next, advertisedOps);
    const op = nextOps.includes(condition.op) ? condition.op : (nextOps[0] ?? 'eq');
    onChange({ ...condition, slot: name, op, value: op === 'is_null' ? true : '' });
  };
  const setOp = (op: QueryOp) =>
    onChange({ ...condition, op, value: op === 'is_null' ? true : condition.value });

  return (
    <div className="query-condition" data-testid="query-condition">
      <select
        aria-label="Field"
        className="query-select"
        value={condition.slot}
        onChange={(e) => setSlot(e.target.value)}
      >
        {slots.map((s) => (
          <option key={s.slot} value={s.slot}>
            {s.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Operator"
        className="query-select"
        value={condition.op}
        onChange={(e) => setOp(e.target.value as QueryOp)}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>
      {condition.op === 'is_null' || slot?.kind === 'boolean' ? (
        <select
          aria-label="Value"
          className="query-select"
          value={String(condition.value)}
          onChange={(e) =>
            onChange({ ...condition, value: coerceValue(slot!, condition.op, e.target.value) })
          }
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : slot?.kind === 'enum' && condition.op !== 'in' ? (
        <select
          aria-label="Value"
          className="query-select"
          value={String(condition.value)}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        >
          <option value="">…</option>
          {(slot.enumValues ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label="Value"
          className="query-input"
          placeholder={condition.op === 'in' ? 'value, value, …' : 'value'}
          value={rawValue(condition)}
          onChange={(e) =>
            onChange({ ...condition, value: coerceValue(slot!, condition.op, e.target.value) })
          }
        />
      )}
      <button type="button" className="query-remove" aria-label="Remove criterion" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function RelatedEditor({
  condition,
  edges,
  collections,
  advertisedOps,
  onChange,
  onRemove,
}: {
  condition: RelatedCondition;
  edges: QueryEdge[];
  collections: CollectionModel[];
  advertisedOps: readonly string[];
  onChange: (next: RelatedCondition) => void;
  onRemove: () => void;
}) {
  const edge = edges.find((e) => e.key === condition.edge);
  const related = edge && collections.find((c) => c.id === edge.relatedCollectionId);
  const relatedSlots = related ? filterSlots(related) : [];

  return (
    <div className="query-related" data-testid="query-related">
      <div className="query-condition">
        <span className="query-keyword">having</span>
        <select
          aria-label="Quantifier"
          className="query-select"
          value={condition.quantifier}
          onChange={(e) =>
            onChange({ ...condition, quantifier: e.target.value as 'some' | 'none' })
          }
        >
          <option value="some">at least one</option>
          {/* "exactly zero" needs a to-many edge: over a single reference it
              would mean "unset or fails", which the typed input cannot say. */}
          <option value="none" disabled={edge ? !edge.toMany : false}>
            exactly zero
          </option>
        </select>
        <select
          aria-label="Relationship"
          className="query-select"
          value={condition.edge}
          onChange={(e) => onChange({ ...condition, edge: e.target.value, criteria: [] })}
        >
          {edges.map((e) => (
            <option key={e.key} value={e.key}>
              {e.label}
            </option>
          ))}
        </select>
        <span className="query-keyword">where</span>
        <button type="button" className="query-remove" aria-label="Remove criterion" onClick={onRemove}>
          ×
        </button>
      </div>
      <div className="query-subgroup">
        {condition.criteria.map((sub, i) => (
          <ConditionEditor
            key={i}
            condition={sub}
            slots={relatedSlots}
            advertisedOps={advertisedOps}
            onChange={(next) =>
              onChange({
                ...condition,
                criteria: condition.criteria.map((c, j) => (j === i ? next : c)),
              })
            }
            onRemove={() =>
              onChange({ ...condition, criteria: condition.criteria.filter((_, j) => j !== i) })
            }
          />
        ))}
        <button
          type="button"
          className="query-add"
          disabled={relatedSlots.length === 0}
          onClick={() =>
            onChange({
              ...condition,
              criteria: [
                ...condition.criteria,
                { kind: 'field', slot: relatedSlots[0]!.slot, op: 'eq', value: '' },
              ],
            })
          }
        >
          + condition on the related record
        </button>
      </div>
    </div>
  );
}

/** Table zoom levels, largest first. View state only: nothing is fetched or saved. */
const TABLE_ZOOM_STEPS = [1, 0.9, 0.8, 0.7, 0.6];

/** The next zoom step out (+1) or in (-1) from `current`, clamped to the ends. */
function stepZoom(current: number, direction: 1 | -1): number {
  const i = TABLE_ZOOM_STEPS.findIndex((z) => z <= current + 1e-9);
  const at = i === -1 ? TABLE_ZOOM_STEPS.length - 1 : i;
  const next = Math.min(TABLE_ZOOM_STEPS.length - 1, Math.max(0, at + direction));
  return TABLE_ZOOM_STEPS[next]!;
}

export function QueryBuilderView({ source }: { source: MosaicSource }) {
  const { collections, capabilities } = source;
  const urlState = useCollectionUrlState();
  const navView = useNavView();
  const conversation = useConversation();
  const locked = conversation?.locked ?? false;
  const anchored = collections.filter((c) => c.args.filter);
  // The URL may still carry a v1 spec from a bookmarked or shared link, so
  // upgrade on the way in (schema-aware — v1 addressed the anchor by
  // collection id). `null` means the v1 anchor names a collection this
  // endpoint no longer exposes; fall back to a fresh spec rather than run a
  // half-translated query.
  // Cold start: the deployment's declared default, not `anchored[0]`. That
  // index is alphabetical, so growing the schema silently moved the opening
  // screen to whichever collection happened to sort first -- a page that lands
  // on `Aliquot` because A precedes D tells the reader nothing about the
  // deployment. `defaultId` is the same answer the collections nav already
  // opens on, so the two agree. Falls back to `anchored[0]` when nothing is
  // declared, or when what is declared cannot anchor a query.
  const navDefault = navView?.defaultId
    ? anchored.find((c) => c.id === navView.defaultId)?.typeName
    : undefined;
  const initial =
    (urlState.querySpec ? canonicalizeQuerySpec(urlState.querySpec, collections) : null) ??
    emptyQuerySpec(
      (urlState.collection && anchored.find((c) => c.id === urlState.collection)?.typeName) ||
        navDefault ||
        anchored[0]?.typeName ||
        '',
    );

  const [draft, setDraft] = useState<QuerySpec>(initial);
  const [run, setRun] = useState<QueryRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  /**
   * Which result fields to show.
   *
   * The goal this surface exists for ends in "the specific data elements they
   * wish to include in a query". Mosaic has accepted `QuerySpec.columns` since
   * v0.16.0 (mosaic#236), but Aperture does not send it for execution yet: it
   * still requests full envelopes and projects client-side, as Mosaic's old
   * COLUMNS_NOT_SUPPORTED message prescribed. This is that projection. Every field still crosses the wire; the user
   * chooses what to read and what to export.
   *
   * Held as HIDDEN rather than shown so a schema that gains a field shows it by
   * default — the opposite would silently omit new data from every saved view.
   */
  // Seeded from `cols` so a shared link reproduces the grain and the visibility
  // the sender saw (aperture#73); both halves are written back by an effect below.
  const [seed] = useState(() =>
    decodeColumns(urlState.columns, resolveAnchor(initial, collections), collections),
  );
  const [hiddenFields, setHiddenFields] = useState<ReadonlySet<string>>(seed.hiddenFields);

  /**
   * Columns reached through a reference (ADR-0041).
   *
   * Held as an INCLUDE set, unlike `hiddenFields` above. The asymmetry is
   * deliberate: an anchor's own fields should appear by default, so a schema
   * that gains one shows it; a traversal is only ever there because someone
   * asked for it, and defaulting every reachable field on would fetch a graph
   * nobody requested.
   */
  const [pathColumns, setPathColumns] = useState<PathColumn[]>(seed.pathColumns);
  /**
   * Anchor fields the current proposal named as columns (aperture#89). They
   * show by default anyway; this remembers that the planner ASKED for them, so
   * the round trip can tell it which of them the reader still shows.
   */
  const [proposedFields, setProposedFields] = useState<string[]>([]);
  /** Proposal columns that could not be shown, each with its reason (ADR-0029). */
  const [droppedColumns, setDroppedColumns] = useState<DroppedColumn[]>([]);
  const [pickingFields, setPickingFields] = useState(false);
  /** View-only scale of the results table, so a wide or long result can be taken in at once. */
  const [tableZoom, setTableZoom] = useState(1);

  const anchor = resolveAnchor(draft, collections);
  /**
   * Add a condition on this field to the DRAFT.
   *
   * Deliberately not `urlState.setQuerySpec`: in this builder a spec in the URL is an
   * EXECUTED query (`executed = urlState.querySpec`, run by an effect). Writing there would
   * run the query off a single click on a field listing, which is exactly what ADR-0039
   * rules out — the user's run has to stay a deliberate act. Run is still the only way to
   * execute.
   */
  /**
   * Slot names the current turn named — emphasis only.
   *
   * The wire contract carries no structured list of them, so they are recovered from the
   * message (see `namedSlots`). A miss dims a row; the panel still lists every field, so
   * being wrong here never withholds anything.
   */
  const latestTurn = conversation?.turns[conversation.turns.length - 1];
  const highlightedSlots = useMemo(() => {
    // Matched against EVERY collection's slots, not just the anchor's. Scoping this to
    // the anchor meant a turn about another collection highlighted nothing and, worse,
    // left `subject` below with nothing to go on -- the panel could not follow an answer
    // it could not see.
    const known = collections.flatMap((c) => c.detailColumns.map((col) => col.slot ?? col.field));
    return namedSlots(latestTurn?.message, currentQuerySpec(conversation?.turns ?? []), known);
  }, [latestTurn?.message, conversation?.turns, collections]);

  /**
   * The collection the panel shows: what the last answer was about, falling back to the
   * anchor. Never the draft's anchor by itself -- see `subjectCollection`.
   */
  const subject = useMemo(
    () => subjectCollection(collections, highlightedSlots, anchor) ?? anchor,
    [collections, highlightedSlots, anchor],
  );
  const subjectIsAside = subject != null && anchor != null && subject.typeName !== anchor.typeName;

  /** Adopt the shown collection as the anchor. Draft only -- Run stays the only execution. */
  const adoptSubject = useCallback(() => {
    if (!subject) return;
    setDraft((prev) => ({ ...prev, anchor: subject.typeName, criteria: [] }));
  }, [subject]);

  const addFilterFor = useCallback(
    (column: ColumnModel) => {
      const slot = column.slot ?? column.field;
      setDraft((prev) => ({
        ...prev,
        criteria: [...prev.criteria, { kind: 'field', slot, op: 'eq', value: '' }],
      }));
    },
    [],
  );

  /**
   * Add or remove a traversal column by its GraphQL path (one or two hops).
   *
   * Resolution goes through `resolvePath`, the same function that restores a
   * shared link's `cols`, so the picker can only build columns a link can
   * reproduce. A column added through a link that is already exploded joins
   * the explosion: "one row each" belongs to the link, not to a column.
   */
  const togglePath = useCallback(
    (path: string[]) => {
      if (!anchor) return;
      const key = pathKey(path);
      setPathColumns((prev) => {
        if (prev.some((c) => pathKey(c.path) === key)) {
          return prev.filter((c) => pathKey(c.path) !== key);
        }
        const resolved = resolvePath(path, anchor, collections);
        if (!resolved) return prev;
        const added = toPathColumn(resolved);
        const linkExploded = prev.some(
          (c) => c.many?.mode === 'explode' && explodeKey(c) === explodeKey(added),
        );
        return normalizeExplode([
          ...prev,
          linkExploded && added.many ? { ...added, many: { ...added.many, mode: 'explode' as ManyMode } } : added,
        ]);
      });
    },
    [anchor, collections],
  );

  /**
   * Set a to-many column's mode.
   *
   * `count` and `list them` are per column. "One row each" is per LINK: it
   * applies to every column through that link at once (otherwise two aliquot
   * columns would describe different aliquots on the same row), and choosing
   * it on one link demotes any other exploded link to `count` -- the
   * one-explosion cap of ADR-0041 v1, enforced by link instead of by column.
   * Turning it off for one column turns it off for the link.
   */
  const setPathMode = useCallback((path: string[], mode: ManyMode) => {
    const key = pathKey(path);
    setPathColumns((prev) => {
      const target = prev.find((c) => pathKey(c.path) === key);
      if (!target?.many) return prev;
      const link = explodeKey(target);
      if (mode === 'explode') return normalizeExplode(prev, link);
      const leavingExplode = target.many.mode === 'explode';
      return prev.map((c) => {
        if (!c.many) return c;
        const sameLink = explodeKey(c) === link;
        if (pathKey(c.path) === key || (leavingExplode && sameLink)) {
          return { ...c, many: { ...c.many, mode } };
        }
        return c;
      });
    });
  }, []);

  const toggleField = useCallback((field: string) => {
    setHiddenFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }, []);

  // What the results table and the exports actually use. Derived rather than
  // stored, so it stays correct when the anchor's column set changes.
  // The anchor's own columns, as paths, so the table has one column vocabulary
  // instead of two. A traversal column and an anchor column differ only in
  // path length from here on.
  const anchorColumns: PathColumn[] = (anchor?.columns ?? [])
    .filter((c) => !hiddenFields.has(c.field))
    .map((c) => ({ path: [c.field], column: c, label: c.label, exportName: c.slot ?? slotName(c.field) }));
  const shownColumns: PathColumn[] = [...anchorColumns, ...pathColumns];
  const slots = useMemo(() => (anchor ? filterSlots(anchor) : []), [anchor]);
  const edges = useMemo(
    () => (anchor ? deriveEdges(anchor, collections) : []),
    [anchor, collections],
  );
  const flat = useMemo(
    () => (run ? flattenRows(run.rows, shownColumns, anchor?.idColumn) : null),
    [run, shownColumns, anchor?.idColumn],
  );

  const validation = useMemo(
    () => validateQuerySpec(draft, collections, capabilities),
    [draft, collections, capabilities],
  );

  /**
   * The chosen paths, read through a ref inside `execute`.
   *
   * `execute` is memoised on the source and the spec; adding the columns to its
   * dependencies would re-run the query on every checkbox, turning a
   * presentation choice into a fetch. The ref keeps the latest value available
   * without making the callback identity depend on it. A column that needs
   * data the last read lacks triggers a re-read of the SAME executed query
   * (see `neededSelection` below); executing a new spec stays Run's alone
   * (ADR-0039).
   */
  const pathsRef = useRef<PathColumn[]>(pathColumns);
  pathsRef.current = pathColumns;

  /**
   * Bumped by Run, so Run always executes.
   *
   * Without it, Run wrote the same spec to the URL and the effect below — keyed
   * on that spec — never fired, so choosing a traversal column produced a
   * header with no data behind it. The columns deliberately stay out of the
   * effect's dependencies (a checkbox must not fetch); this is what makes the
   * user's explicit Run the thing that picks them up.
   */
  const [runNonce, setRunNonce] = useState(0);

  const executed = urlState.querySpec;
  const page = urlState.page;
  const execute = useCallback(
    async (spec: QuerySpec, pageNo: number) => {
      setRunning(true);
      setError(null);
      try {
        setRun(
          await runQuerySpec(source, collections, capabilities, spec, pageNo, PAGE_SIZE, pathsRef.current),
        );
      } catch (e) {
        setRun(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
      }
    },
    [source, collections, capabilities],
  );

  useEffect(() => {
    if (executed) void execute(executed, page);
  }, [executed, page, execute, runNonce]);

  /**
   * Re-read the SAME executed query when the chosen columns need fields the
   * last read did not fetch.
   *
   * ADR-0039 keeps Run as the only gesture that executes a query, and that
   * stands: nothing here runs a new spec, changes the row set, or fires on a
   * mode change (count / list / one row each are computed client-side from
   * data already in hand). But a traversal column added after a run used to
   * render a header over blanks and zeros until the user happened to press Run
   * again -- data the screen claims to show, silently absent. Fetching the
   * extra nested fields for the already-run query closes that gap without
   * re-deciding what was asked.
   */
  const neededSelection = useMemo(
    () => (anchor && pathColumns.length > 0 ? selectionForPaths(pathColumns, anchor, collections) || '' : ''),
    [anchor, pathColumns, collections],
  );
  const fetchedSelection = run?.pathSelection ?? '';
  useEffect(() => {
    if (!executed || !run || running) return;
    if (neededSelection === '' || neededSelection === fetchedSelection) return;
    void execute(executed, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededSelection, fetchedSelection, running]);

  /**
   * Adopt a spec that arrives in the URL from somewhere other than this
   * builder — the chat panel's "Use in builder" being the one that matters
   * (ADR-0039). Without this the handoff would set the URL and auto-run while
   * the visible builder still showed an empty draft, so the next Run would
   * silently replace the planner's query with whatever was on screen.
   *
   * Keyed on the URL value *changing*, not on it differing from the draft: the
   * user editing rows must not be clobbered by a re-sync, and Run writes
   * draft → URL, which lands here as a no-op adopt of the same value.
   */
  /**
   * Show the conversation's current proposal in the builder, as a DRAFT.
   *
   * The builder treats a spec in the URL as already executed, so the chat
   * panel's handoff button both populated and ran. That left the panel's
   * proposal invisible until the user found the button: a locked builder
   * saying "the composer is building this query" while still displaying the
   * previous anchor, beside a results pane reading "Nothing run yet". A user
   * reasonably reads that as nothing having happened.
   *
   * Adopting into the DRAFT fixes the contradiction without touching what
   * ADR-0039 actually protects. The proposal is visible the moment it arrives;
   * it still does not execute until the user presses Run, "exactly like a spec
   * they built by hand". Model plans, user runs — unchanged.
   *
   * Keyed on the proposal changing, so a user editing rows between turns is not
   * clobbered by a re-sync.
   */
  const proposal = currentQuerySpec(conversation?.turns ?? []);
  const proposalJson = proposal ? JSON.stringify(proposal) : null;
  const lastProposal = useRef<string | null>(null);
  useEffect(() => {
    if (proposalJson === lastProposal.current) return;
    lastProposal.current = proposalJson;
    // A drop notice belongs to the proposal that caused it.
    setDroppedColumns([]);
    if (!proposal) {
      setProposedFields([]);
      return;
    }
    const parsed = readQuerySpec(proposal);
    const canonical = parsed ? canonicalizeQuerySpec(parsed, collections) : null;
    if (!canonical) return;
    // The draft never keeps `columns` (aperture#89): they seed the result
    // table below, and `cols` is the one view source from then on. A copy left
    // on the draft would ride into `qs` on Run and go stale the first time the
    // reader changed a column.
    const { columns, ...rest } = canonical;
    setDraft(rest);
    // A proposal WITHOUT `columns` says nothing about them, so the reader's
    // choices stand -- a planner that does not emit columns yet must not wipe
    // the table on every refinement. An explicit list, even an empty one,
    // replaces them.
    if (!columns) return;
    const target = resolveAnchor(rest, collections);
    if (!target) return;
    const seeded = seedFromProposal(columns, target, collections);
    setPathColumns(seeded.pathColumns);
    setProposedFields(seeded.showFields);
    setDroppedColumns(seeded.dropped);
    if (seeded.showFields.length > 0) {
      setHiddenFields((prev) => {
        const next = new Set(prev);
        for (const f of seeded.showFields) next.delete(f);
        return next;
      });
    }
  }, [proposalJson, proposal, collections]);

  // Publish the table's columns, slot-spelled, for the conversational round
  // trip: the panel sends them back as the draft's `columns` so a refinement
  // turn sees what the reader has chosen (aperture#89).
  const setConversationColumns = conversation?.setColumns;
  const wireJson = JSON.stringify(
    anchor
      ? wireColumns(
          proposedFields.filter((f) => !hiddenFields.has(f)),
          pathColumns,
          anchor,
          collections,
        )
      : [],
  );
  useEffect(() => {
    setConversationColumns?.(JSON.parse(wireJson));
  }, [wireJson, setConversationColumns]);

  // A hidden-field set belongs to one entity type. Carrying it across an anchor
  // change would hide fields by coincidence of name, or hide nothing at all
  // while looking like it had.
  const anchorName = draft.anchor;
  const lastAnchor = useRef(anchorName);
  useEffect(() => {
    if (anchorName === lastAnchor.current) return;
    lastAnchor.current = anchorName;
    setHiddenFields(new Set());
  }, [anchorName]);

  // Mirror the column choices into the URL. This is view state: `cols` is not
  // an input to the run effect, so a checkbox still never fetches.
  const colsJson = JSON.stringify(encodeColumns(pathColumns, hiddenFields));
  const urlColsJson = JSON.stringify(urlState.columns ?? null);
  useEffect(() => {
    if (colsJson !== urlColsJson) urlState.setColumns(JSON.parse(colsJson));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsJson]);

  const urlSpecJson = executed ? JSON.stringify(executed) : null;
  const lastUrlSpec = useRef(urlSpecJson);
  useEffect(() => {
    if (urlSpecJson === lastUrlSpec.current) return;
    lastUrlSpec.current = urlSpecJson;
    if (!executed) return;
    const canonical = canonicalizeQuerySpec(executed, collections);
    if (canonical) setDraft(canonical); // regression-guarded in ChatPanel.test.tsx
  }, [urlSpecJson, executed, collections]);

  if (!anchor) {
    return (
      <div className="main-panel" role="status">
        <h1 className="main-panel-title">No filterable collections</h1>
        <p className="main-panel-detail">The endpoint advertises no filter arguments to build on.</p>
      </div>
    );
  }

  const setCriterion = (i: number, next: Criterion) =>
    setDraft({ ...draft, criteria: draft.criteria.map((c, j) => (j === i ? next : c)) });
  const removeCriterion = (i: number) =>
    setDraft({ ...draft, criteria: draft.criteria.filter((_, j) => j !== i) });

  const exportRows = async (format: 'csv' | 'json') => {
    if (!run) return;
    setExportNote(null);
    const rows: Record<string, unknown>[] = [];
    let pageNo = 1;
    let truncated = false;
    for (;;) {
      const result = await source.listEntities(anchor.id, {
        page: pageNo,
        pageSize: EXPORT_PAGE_SIZE,
        conditions: run.anchorConditions,
        filterMode: run.filterMode,
        // The same typed filter and the same traversal selection the run used.
        // Re-deriving either here would let the file drift from the screen it
        // was exported from.
        where: run.where,
        pathSelection: run.pathSelection,
      });
      rows.push(...result.rows);
      if (rows.length >= EXPORT_CAP) {
        truncated = result.mayHaveMore || rows.length > EXPORT_CAP;
        rows.length = EXPORT_CAP;
        break;
      }
      if (!result.mayHaveMore) break;
      pageNo += 1;
    }
    // Export what the user chose to see, at the grain they are seeing it.
    // A file carrying fields they hid — or one row per anchor when the screen
    // shows one per pair — would quietly contradict the screen it came from.
    const flatExport = flattenRows(rows, shownColumns, anchor.idColumn);
    const content =
      format === 'csv'
        ? toCSVPaths(shownColumns, flatExport.rows)
        : toJSONExportPaths(shownColumns, flatExport.rows);
    downloadFile(
      `query-${anchor.id}.${format}`,
      format === 'csv' ? 'text/csv' : 'application/json',
      content,
    );
    // The cap counts ANCHOR rows fetched, which is not what an exploded file
    // contains — saying "5,000 rows" over a 12,000-line file would be wrong.
    const unit = anchor.label.toLowerCase();
    const exploded = flatExport.grain != null;
    setExportNote(
      truncated
        ? `Exported the first ${rows.length.toLocaleString('en-US')} ${unit}` +
          (exploded ? ` — ${flatExport.rows.length.toLocaleString('en-US')} rows` : '') +
          ' — the set is larger (cap).'
        : `Exported ${flatExport.rows.length.toLocaleString('en-US')} rows` +
          (exploded ? ` from ${rows.length.toLocaleString('en-US')} ${unit}.` : '.'),
    );
  };

  return (
    <div className="main-panel query-view query-builder-view" data-testid="query-builder">
      <div className="query-header">
        <h1 className="main-panel-title">Query</h1>
        <button type="button" className="detail-link" onClick={urlState.closeQueryViews}>
          Back to collections
        </button>
      </div>

      {/* Once a conversation owns the spec the manual form goes read-only
          (design Decision 11). Not presentation: Mosaic asserts the wire
          `query_spec` agrees with what it derives from `turns` and 400s
          otherwise, so a hand-edit underneath a live conversation would break
          the next turn. The note stays visible rather than disappearing, with
          an explicit way back to manual editing — it now lives inside the
          frame, beside the controls it describes. */}
      {/* Demoted from a full-width amber banner to a caption. It was the loudest thing on
          the page — louder than the user's own answer — to report a hand-edit they had not
          attempted.

          It sits OUTSIDE the fieldset deliberately: `fieldset[disabled]` disables every
          descendant control, so moving this inside silently disabled the one button that
          escapes the lock. Caught by ChatPanel.test.tsx, which clicks it. */}
      {locked && (
        <p className="query-locked-note" role="status">
          The composer is building this query.{' '}
          <button type="button" className="chat-inline-link" onClick={() => conversation?.clear()}>
            Clear conversation &amp; edit manually
          </button>
        </p>
      )}
      <fieldset className="query-frame" disabled={locked} data-locked={locked || undefined}>
        <div className="query-condition">
          <span className="query-keyword">Rows are</span>
          <select
            aria-label="Anchor"
            className="query-select"
            data-testid="query-anchor"
            value={draft.anchor}
            onChange={(e) => setDraft(emptyQuerySpec(e.target.value))}
          >
            {anchored.map((c) => (
              <option key={c.id} value={c.typeName}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="query-keyword">matching</span>
          <select
            aria-label="Combine mode"
            className="query-select"
            value={draft.mode}
            disabled={!anchor.filterModeArg}
            title={anchor.filterModeArg ? undefined : 'The endpoint advertises no OR combinator'}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as 'AND' | 'OR' })}
          >
            <option value="AND">all of</option>
            <option value="OR">any of</option>
          </select>
        </div>

        {draft.criteria.map((criterion, i) =>
          criterion.kind === 'field' ? (
            <ConditionEditor
              key={i}
              condition={criterion}
              slots={slots}
              advertisedOps={capabilities.filterOps}
              onChange={(next) => setCriterion(i, next)}
              onRemove={() => removeCriterion(i)}
            />
          ) : (
            <RelatedEditor
              key={i}
              condition={criterion}
              edges={edges}
              collections={collections}
              advertisedOps={capabilities.filterOps}
              onChange={(next) => setCriterion(i, next)}
              onRemove={() => removeCriterion(i)}
            />
          ),
        )}

        <div className="query-actions">
          <button
            type="button"
            className="query-add"
            disabled={slots.length === 0}
            onClick={() =>
              setDraft({
                ...draft,
                criteria: [
                  ...draft.criteria,
                  { kind: 'field', slot: slots[0]!.slot, op: 'eq', value: '' },
                ],
              })
            }
          >
            + field condition
          </button>
          <button
            type="button"
            className="query-add"
            disabled={edges.length === 0}
            title={edges.length === 0 ? 'No relationship edges derive from this anchor' : undefined}
            onClick={() =>
              setDraft({
                ...draft,
                criteria: [
                  ...draft.criteria,
                  { kind: 'related', edge: edges[0]!.key, quantifier: 'some', criteria: [] },
                ],
              })
            }
          >
            + relationship condition
          </button>
          <button
            type="button"
            className="action-button"
            data-testid="query-run"
            disabled={validation.errors.length > 0 || running}
            onClick={() => {
              urlState.openQueryBuilder(draft);
              setRunNonce((n) => n + 1);
            }}
          >
            {running ? 'Running…' : 'Run'}
          </button>
        </div>

        {validation.errors.length > 0 && draft.criteria.length > 0 && (
          <ul className="query-problems" role="alert">
            {validation.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </fieldset>

      {droppedColumns.length > 0 && (
        <ul className="query-notes" role="status" data-testid="query-columns-dropped">
          {droppedColumns.map((d) => (
            <li key={d.path.join('.')}>
              Proposed column “{d.path.join(' → ')}” is not shown: {d.reason}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="query-notes" role="alert">
          {error}
        </div>
      )}
      {run && run.notes.length > 0 && (
        <ul className="query-notes" role="status" data-testid="query-notes">
          {run.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {/* No results yet? Show the schema, not a placeholder saying there is nothing to
          show. The page always knows the fields; a user who has run nothing is the one who
          most needs them. This is also where a conversational answer that names fields but
          builds no query finally has somewhere to land. */}
      {!run && !running && !error && (
        <FieldsPanel
          collection={subject ?? anchor}
          highlighted={highlightedSlots}
          hiddenFields={hiddenFields}
          onAddFilter={addFilterFor}
          onToggleField={toggleField}
          showColumnToggles={false}
          asideFromAnchor={subjectIsAside}
          onAdoptAnchor={subjectIsAside ? adoptSubject : undefined}
        />
      )}

      {run && (
        <div className="query-results" data-testid="query-results">
          <div className="query-results-bar">
            <span className="query-total" role="status">
              {run.total != null
                ? `${run.total.toLocaleString('en-US')} matching ${anchor.label.toLowerCase()}`
                : `page ${page}${run.mayHaveMore ? ' (more available)' : ''}`}
              {run.relationshipTier === 'compensated' && (
                <span
                  className="query-tier"
                  title={`Relationship criteria ran client-planned over a native "in" (cap ${SEMIJOIN_CAP})`}
                >
                  {' '}
                  · semijoin tier
                </span>
              )}
            </span>
            <div className="collection-actions">
              <div className="query-zoom" role="group" aria-label="Table zoom">
                <button
                  type="button"
                  className="action-button"
                  aria-label="Zoom out"
                  disabled={tableZoom <= TABLE_ZOOM_STEPS[TABLE_ZOOM_STEPS.length - 1]}
                  onClick={() => setTableZoom((z) => stepZoom(z, +1))}
                >
                  −
                </button>
                <span className="query-zoom-level" data-testid="query-zoom-level">
                  {Math.round(tableZoom * 100)}%
                </span>
                <button
                  type="button"
                  className="action-button"
                  aria-label="Zoom in"
                  disabled={tableZoom >= TABLE_ZOOM_STEPS[0]}
                  onClick={() => setTableZoom((z) => stepZoom(z, -1))}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                className="action-button"
                aria-expanded={pickingFields}
                onClick={() => setPickingFields((v) => !v)}
              >
                {hiddenFields.size > 0 || pathColumns.length > 0
                  ? `Fields (${shownColumns.length} of ${anchor.columns.length + pathColumns.length})`
                  : 'Fields'}
              </button>
              <button type="button" className="action-button" onClick={() => urlState.openGraphView()}>
                Explore as graph
              </button>
              {/* Saves what was RUN (the URL's spec and columns), not the unrun
                  draft: a saved view reopens a result the user has seen. It sits
                  with the result, not in the builder's fieldset: the fieldset is
                  disabled while a conversation owns the query, and saving is not
                  an edit -- a chat-built query must be savable too. */}
              {executed && (
                <SaveViewButton
                  source={source}
                  collectionId={resolveAnchor(executed, collections)?.id ?? anchor.id}
                  query={{ qs: executed, cols: urlState.columns ?? null }}
                />
              )}
              <button type="button" className="action-button" onClick={() => void exportRows('csv')}>
                Export CSV
              </button>
              <button type="button" className="action-button" onClick={() => void exportRows('json')}>
                Export JSON
              </button>
            </div>
          </div>
          {exportNote && (
            <span className="export-note" role="status">
              {exportNote}
            </span>
          )}
          {/* The same panel the surface shows before a run, now carrying the column
              toggles: "which fields exist" and "which do I want to see" are one question
              asked twice, and the standalone picker that answered the second half is
              retired into this. */}
          {/* `anchor`, not `subject`: these toggles hide columns of the table below,
              which is the anchor's rows. Showing another collection's fields beside
              toggles that cannot affect them would be a lie. */}
          {pickingFields && (
            <FieldsPanel
              collection={anchor}
              highlighted={highlightedSlots}
              hiddenFields={hiddenFields}
              onAddFilter={addFilterFor}
              onToggleField={toggleField}
              showColumnToggles
              traversal={{
                edges,
                collections,
                selected: pathColumns,
                onTogglePath: togglePath,
                onSetMode: setPathMode,
              }}
            />
          )}
          {/* A grain change is stated where the rows are. Without this the
              total above counts anchors while the table counts pairs, and
              nothing on screen reconciles them (ADR-0041). */}
          {flat?.grain && (
            <span className="query-grain" role="status" data-testid="query-grain">
              Exploded by {flat.grain.edgeLabel} — {flat.grain.rowCount.toLocaleString('en-US')}{' '}
              rows from {flat.grain.anchorCount.toLocaleString('en-US')}{' '}
              {anchor.label.toLowerCase()} on this page
            </span>
          )}
          {/* The table scrolls inside its own box, both ways, with the header
              pinned: a wide or long result stays in its area instead of running
              under the pager and the panels around it. */}
          <div className="query-table-scroll" data-testid="query-table-scroll">
          <table className="collection-table" style={{ zoom: tableZoom }}>
            <thead>
              <tr>
                {shownColumns.map((c) => (
                  <th
                    key={pathKey(c.path)}
                    className={isPathRightAligned(c) ? 'align-right' : undefined}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(flat?.rows ?? []).map((row) => (
                <tr
                  key={row.key}
                  className="query-row"
                  onClick={() => {
                    // Always the anchor, even on an exploded row: the row
                    // describes a pair, but the record it belongs to is the
                    // anchor entity.
                    if (row.anchorId != null) urlState.openIn(anchor.id, row.anchorId);
                  }}
                >
                  {shownColumns.map((c) => (
                    <td
                      key={pathKey(c.path)}
                      className={isPathRightAligned(c) ? 'align-right' : undefined}
                    >
                      {renderPathCell(c, row.values[pathKey(c.path)])}
                    </td>
                  ))}
                </tr>
              ))}
              {(flat?.rows.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={shownColumns.length} className="query-empty">
                    No matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
          <div className="query-pager">
            <button
              type="button"
              className="action-button"
              disabled={page <= 1 || running}
              onClick={() => urlState.setQueryPage(page - 1)}
            >
              Previous
            </button>
            <span>page {page}</span>
            <button
              type="button"
              className="action-button"
              disabled={!run.mayHaveMore || running}
              onClick={() => urlState.setQueryPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
