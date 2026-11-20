import type { FilterValues, RangeValues } from '../data/mosaicSource';
import type { ColumnsParam } from '../query/columnView';
import type { QuerySpec } from '../query/querySpec';
import type { ControlPlaneDocument, Visibility } from './store';
import { openPayload, sealPayload } from './store';

/**
 * Saved views (R3.9 → Phase 4): the serializable query-state object,
 * persisted as a named control-plane document. The payload pins the schema
 * fingerprint it was saved under so opening after a schema change is
 * detectable (the L10 pattern, applied to views).
 */
export const SAVED_VIEW_VERSION = 1;

export interface SavedViewState {
  collection: string;
  page: number;
  q?: string;
  filters?: FilterValues;
  /** Active range-facet selections (issue #61) — absent for endpoints without range facets. */
  ranges?: RangeValues;
  /** `<column field>:<asc|desc>` (issue #20) — absent for endpoints/columns without sort. */
  sort?: string;
  /**
   * A saved QUERY rather than a collection page: the executed spec (`qs`) and
   * its column choices (`cols` -- traversals, grain, hidden fields), exactly
   * the two URL parameters that reproduce the query view. Optional and
   * additive, so `SAVED_VIEW_VERSION` stays 1 and every existing view still
   * opens. Shape-checked only here; `qs`/`cols` are validated again by their
   * own URL parsers when the view is applied, so a stale one degrades to
   * fewer columns rather than a crash.
   */
  query?: { qs: QuerySpec; cols?: ColumnsParam };
}

export interface SavedView {
  name: string;
  state: SavedViewState;
  schemaFingerprint: string;
  /**
   * Read-side ownership metadata (ADR-0032 ownership amendment). Absent when
   * constructing a view to save — the store stamps the owner on create, and
   * never accepts one from here. `null` means unowned.
   */
  owner?: string | null;
  visibility?: Visibility;
}

function isFilterValues(value: unknown): value is FilterValues {
  return (
    typeof value === 'object' &&
    value != null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string' || typeof v === 'boolean')
  );
}

function isRangeValues(value: unknown): value is RangeValues {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
  return Object.values(value).every((range) => {
    if (typeof range !== 'object' || range == null || Array.isArray(range)) return false;
    const { gte, lte } = range as Record<string, unknown>;
    return (
      (gte === undefined || typeof gte === 'string' || typeof gte === 'number') &&
      (lte === undefined || typeof lte === 'string' || typeof lte === 'number')
    );
  });
}

function isSavedViewData(data: unknown): data is Omit<SavedView, 'name'> {
  if (typeof data !== 'object' || data == null) return false;
  const d = data as Record<string, unknown>;
  const state = d['state'] as Record<string, unknown> | undefined;
  return (
    typeof d['schemaFingerprint'] === 'string' &&
    typeof state === 'object' &&
    state != null &&
    typeof state['collection'] === 'string' &&
    typeof state['page'] === 'number' &&
    (state['q'] === undefined || typeof state['q'] === 'string') &&
    (state['filters'] === undefined || isFilterValues(state['filters'])) &&
    (state['ranges'] === undefined || isRangeValues(state['ranges'])) &&
    (state['sort'] === undefined || typeof state['sort'] === 'string') &&
    (state['query'] === undefined || isSavedQuery(state['query']))
  );
}

function isSavedQuery(value: unknown): boolean {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
  const { qs, cols } = value as Record<string, unknown>;
  const spec = qs as Record<string, unknown> | null;
  return (
    typeof spec === 'object' &&
    spec != null &&
    typeof spec['anchor'] === 'string' &&
    Array.isArray(spec['criteria']) &&
    (cols === undefined || (typeof cols === 'object' && cols != null && !Array.isArray(cols)))
  );
}

export function sealSavedView(view: SavedView): ControlPlaneDocument {
  return {
    kind: 'savedView',
    name: view.name,
    payload: sealPayload(SAVED_VIEW_VERSION, {
      state: view.state,
      schemaFingerprint: view.schemaFingerprint,
    }),
  };
}

/** Invalid/foreign documents read as null — skipped, never a crash. */
export function openSavedView(document: ControlPlaneDocument): SavedView | null {
  const data = openPayload(document.payload, SAVED_VIEW_VERSION, isSavedViewData);
  if (!data) return null;
  return {
    name: document.name,
    ...data,
    owner: document.owner ?? null,
    visibility: document.visibility,
  };
}
