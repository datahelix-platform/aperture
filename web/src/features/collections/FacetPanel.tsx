import { useEffect, useState } from 'react';
import { useCapabilities, useDataSource } from '../../data/DataSourceContext';
import type { RangeValues } from '../../data/mosaicSource';
import type { FacetModel } from '../../data/schemaModel';
import { activeCollection } from '../../nav/config';
import { useNavView } from '../../nav/NavConfigContext';
import { useCollectionUrlState } from './urlState';
import './collections.css';

/** Per-value counts for one facet field, keyed by the option's string form. */
type FacetCounts = Record<string, number>;

/** Advertised min/max bounds for one range facet (issue #61), when known. */
type FieldBounds = { min: unknown; max: unknown };

const RANGE_KINDS = new Set<FacetModel['kind']>(['number-range', 'date-range']);

/**
 * The filters panel (design-export inspector; R3.3): FTS box + equality
 * facets derived from the endpoint's filter surface. Capability-gated
 * (ADR-0029): renders nothing when the collection advertises neither facets
 * nor search (the layout collapses the empty inspector column). One value per
 * facet, AND across facets — the flat-equality semantics every conformant
 * filter input supports. Per-value counts (issue #20) appear once the
 * endpoint advertises a genuine `facetCounts` field (Hippo X1) — each
 * facet's own current selection is excluded from its own counts so its other
 * options stay visible, while every other active filter still narrows them.
 * Numeric/date range facets (issue #61) render a min/max widget, wired to
 * `GTE`/`LTE` conditions, once the endpoint advertises a genuine `FieldRange`
 * field — the widget's inputs are optionally pre-filled with the endpoint's
 * advertised bounds under the collection's active equality filters.
 */
export function FacetPanel() {
  const state = useDataSource();
  const view = useNavView();
  const capabilities = useCapabilities();
  const urlState = useCollectionUrlState();
  const { collection, filters, ranges, search, toggleFilter, setRange, setSearch, clearFilters } =
    urlState;

  const active =
    state.status === 'ready' && view != null ? activeCollection(view, collection) : undefined;
  const facets = active && capabilities.equalityFacets ? active.facets : [];
  const countableFields = capabilities.aggregation && active?.facetCounts
    ? facets.filter((f) => !RANGE_KINDS.has(f.kind) && f.kind !== 'ref').map((f) => f.field)
    : [];
  const rangeFields = capabilities.rangeFacets && active?.fieldRange
    ? facets.filter((f) => RANGE_KINDS.has(f.kind)).map((f) => f.field)
    : [];

  const [counts, setCounts] = useState<Record<string, FacetCounts>>({});
  useEffect(() => {
    if (state.status !== 'ready' || !active || countableFields.length === 0) {
      setCounts({});
      return;
    }
    let cancelled = false;
    state.source
      .getFacetCounts(active.id, countableFields, filters)
      .then((byField) => {
        if (cancelled) return;
        const next: Record<string, FacetCounts> = {};
        for (const [field, buckets] of Object.entries(byField)) {
          next[field] = Object.fromEntries(buckets.map((b) => [String(b.value), b.count]));
        }
        setCounts(next);
      })
      .catch(() => {
        if (!cancelled) setCounts({});
      });
    return () => {
      cancelled = true;
    };
    // countableFields is a derived array (new identity each render); its
    // content is exactly `active.id` + capability gates, already tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, active?.id, JSON.stringify(filters), countableFields.join(',')]);

  const [bounds, setBounds] = useState<Record<string, FieldBounds>>({});
  useEffect(() => {
    if (state.status !== 'ready' || !active || rangeFields.length === 0) {
      setBounds({});
      return;
    }
    let cancelled = false;
    state.source
      .getFieldRange(active.id, rangeFields, filters)
      .then((byField) => {
        if (!cancelled) setBounds(byField);
      })
      .catch(() => {
        if (!cancelled) setBounds({});
      });
    return () => {
      cancelled = true;
    };
    // rangeFields is a derived array (new identity each render); its content
    // is exactly `active.id` + capability gates, already tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, active?.id, JSON.stringify(filters), rangeFields.join(',')]);

  if (state.status !== 'ready' || view == null) return null;
  // The builder/graph views own the URL's filter semantics — hide the panel.
  if (urlState.view != null) return null;
  if (!active) return null;

  // Progressive disclosure into the cross-class builder (ADR-0035): the
  // current facet state carries over as the degenerate QuerySpec.
  const openAdvanced = () =>
    urlState.openQueryBuilder({
      v: 1,
      // The platform spelling is the LinkML class name, not the collection id
      // (ADR-0035 amendment). Readers canonicalize either dialect, but a
      // producer emitting the legacy one keeps it alive for no reason.
      anchor: active.typeName,
      mode: 'AND',
      criteria: Object.entries(filters).map(([slot, value]) => ({
        kind: 'field',
        slot,
        op: 'eq',
        value,
      })),
    });

  const searchable = capabilities.fullTextSearch && Boolean(active.args.search || active.search);
  if (!searchable && facets.length === 0) return null;

  const activeCount = Object.keys(filters).length + Object.keys(ranges).length + (search ? 1 : 0);

  return (
    // data-testid attributes here and on the options below are the stable
    // certification contract (datahelix golden-path suite; #15) — keep them.
    <div className="facet-panel" data-testid="facet-panel">
      <div className="facet-panel-header">
        <div className="facet-panel-title-row">
          <span className="facet-panel-title">Filters</span>
          {activeCount > 0 && <span className="facet-active-count">{activeCount}</span>}
        </div>
        {activeCount > 0 && (
          <button type="button" className="facet-clear-all" onClick={clearFilters}>
            Clear all
          </button>
        )}
        <button
          type="button"
          className="facet-clear-all"
          data-testid="facet-advanced"
          title="Cross-class criteria query (ADR-0035)"
          onClick={openAdvanced}
        >
          Advanced…
        </button>
      </div>
      <div className="facet-panel-body">
        {searchable && <SearchBox value={search} onApply={setSearch} />}
        {facets.map((facet) => (
          <FacetGroup
            key={facet.field}
            facet={facet}
            value={filters[facet.field]}
            counts={counts[facet.field]}
            range={ranges[facet.field]}
            bounds={bounds[facet.field]}
            onToggle={(value) => toggleFilter(facet.field, value)}
            onRangeChange={(range) => setRange(facet.field, range)}
          />
        ))}
        <div className="facet-footnote">
          Facets derive from the endpoint’s filter surface: one value per facet, combined with
          AND.{' '}
          {countableFields.length > 0
            ? 'Counts reflect the other active filters.'
            : 'Counts arrive with backend aggregation support.'}{' '}
          {rangeFields.length > 0 && 'Range bounds reflect the current equality filters.'}
        </div>
      </div>
    </div>
  );
}

function SearchBox({ value, onApply }: { value: string; onApply: (q: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="facet-group">
      <div className="facet-group-label">Search</div>
      <input
        type="search"
        className="facet-search-input"
        placeholder="Full-text search…"
        aria-label="Full-text search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onApply(draft);
        }}
        onBlur={() => {
          if (draft !== value) onApply(draft);
        }}
      />
    </div>
  );
}

function FacetGroup({
  facet,
  value,
  counts,
  range,
  bounds,
  onToggle,
  onRangeChange,
}: {
  facet: FacetModel;
  value: string | boolean | undefined;
  /** Per-value counts (issue #20), keyed by the option's string form. */
  counts?: FacetCounts;
  /** Active `{gte?, lte?}` selection for a range facet (issue #61). */
  range?: RangeValues[string];
  /** Advertised min/max bounds for a range facet (issue #61), when known. */
  bounds?: FieldBounds;
  onToggle: (value: string | boolean) => void;
  onRangeChange: (range: RangeValues[string]) => void;
}) {
  if (facet.kind === 'ref') {
    return <RefFacet facet={facet} value={typeof value === 'string' ? value : ''} onToggle={onToggle} />;
  }

  if (facet.kind === 'number-range' || facet.kind === 'date-range') {
    return <RangeFacet facet={facet} value={range} bounds={bounds} onChange={onRangeChange} />;
  }

  const options: { label: string; value: string | boolean }[] =
    facet.kind === 'boolean'
      ? [
          { label: 'true', value: true },
          { label: 'false', value: false },
        ]
      : (facet.options ?? []).map((v) => ({ label: v, value: v }));

  return (
    <div className="facet-group">
      <div className="facet-group-label">{facet.label}</div>
      <div className="facet-options">
        {options.map((option) => {
          const selected = value === option.value;
          const count = counts?.[String(option.value)];
          return (
            <button
              key={String(option.value)}
              type="button"
              className="facet-option"
              // Keyed by the filter FIELD identifier (the LinkML slot name the
              // server filters on) + the option value, e.g. facet-option-in_print-false.
              data-testid={`facet-option-${facet.field}-${String(option.value)}`}
              aria-pressed={selected}
              onClick={() => onToggle(option.value)}
            >
              <span className={selected ? 'facet-box facet-box-on' : 'facet-box'} aria-hidden="true">
                {selected ? '✓' : ''}
              </span>
              <span className="facet-option-label">{option.label}</span>
              {count != null && (
                <span className="facet-option-count" data-testid={`facet-count-${facet.field}-${String(option.value)}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RefFacet({
  facet,
  value,
  onToggle,
}: {
  facet: FacetModel;
  value: string;
  onToggle: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const apply = () => {
    const trimmed = draft.trim();
    if (trimmed === value) return;
    // toggleFilter clears on same-value; setting '' clears via toggle of old value.
    if (trimmed === '') {
      if (value) onToggle(value);
    } else {
      onToggle(trimmed);
    }
  };

  return (
    <div className="facet-group">
      <div className="facet-group-label">{facet.label}</div>
      <input
        type="text"
        className="facet-search-input"
        placeholder="Filter by id…"
        data-testid={`facet-option-${facet.field}`}
        aria-label={`Filter by ${facet.label}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply();
        }}
        onBlur={apply}
      />
    </div>
  );
}

/** `''` (unset) or the parsed bound; a non-numeric number-range draft is treated as unset. */
function parseRangeBound(raw: string, kind: 'number-range' | 'date-range'): string | number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (kind === 'number-range') {
    const n = Number(trimmed);
    return Number.isNaN(n) ? undefined : n;
  }
  return trimmed;
}

/**
 * Numeric/date range facet (issue #61): two inputs (min/max) wired to
 * `GTE`/`LTE` conditions via `onChange`, applied on blur/Enter (the same
 * draft-then-apply pattern as `RefFacet`/`SearchBox`). Placeholders show the
 * endpoint-advertised bounds when known — never faked when absent.
 */
function RangeFacet({
  facet,
  value,
  bounds,
  onChange,
}: {
  facet: FacetModel;
  value?: RangeValues[string];
  bounds?: FieldBounds;
  onChange: (range: RangeValues[string]) => void;
}) {
  const kind = facet.kind as 'number-range' | 'date-range';
  const inputType = kind === 'date-range' ? 'date' : 'number';

  const [minDraft, setMinDraft] = useState(value?.gte != null ? String(value.gte) : '');
  const [maxDraft, setMaxDraft] = useState(value?.lte != null ? String(value.lte) : '');
  useEffect(() => setMinDraft(value?.gte != null ? String(value.gte) : ''), [value?.gte]);
  useEffect(() => setMaxDraft(value?.lte != null ? String(value.lte) : ''), [value?.lte]);

  const apply = (nextMin: string, nextMax: string) => {
    const gte = parseRangeBound(nextMin, kind);
    const lte = parseRangeBound(nextMax, kind);
    if (gte === value?.gte && lte === value?.lte) return;
    onChange({ gte, lte });
  };

  return (
    <div className="facet-group">
      <div className="facet-group-label">{facet.label}</div>
      <div className="facet-range-inputs">
        <input
          type={inputType}
          className="facet-range-input"
          placeholder={bounds?.min != null ? String(bounds.min) : 'Min'}
          aria-label={`${facet.label} minimum`}
          data-testid={`facet-range-min-${facet.field}`}
          value={minDraft}
          onChange={(e) => setMinDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply(minDraft, maxDraft);
          }}
          onBlur={() => apply(minDraft, maxDraft)}
        />
        <span className="facet-range-sep" aria-hidden="true">
          –
        </span>
        <input
          type={inputType}
          className="facet-range-input"
          placeholder={bounds?.max != null ? String(bounds.max) : 'Max'}
          aria-label={`${facet.label} maximum`}
          data-testid={`facet-range-max-${facet.field}`}
          value={maxDraft}
          onChange={(e) => setMaxDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply(minDraft, maxDraft);
          }}
          onBlur={() => apply(minDraft, maxDraft)}
        />
      </div>
    </div>
  );
}
