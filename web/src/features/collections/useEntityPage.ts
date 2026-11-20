import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityPage, FilterCondition, FilterValues, MosaicSource } from '../../data/mosaicSource';

export type EntityPageState =
  | { status: 'loading' }
  | { status: 'ready'; page: EntityPage }
  | { status: 'error'; message: string };

/** Fetches one offset page for the active collection; refetches on change. */
export function useEntityPage(
  source: MosaicSource,
  collectionId: string,
  page: number,
  pageSize: number,
  filters?: FilterValues,
  search?: string,
  orderBy?: { field: string; dir?: 'ASC' | 'DESC' },
  /** Typed range conditions (issue #61): `GTE`/`LTE` entries from active range facets. */
  conditions?: FilterCondition[],
): EntityPageState & { retry: () => void } {
  const [state, setState] = useState<EntityPageState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const filtersKey = JSON.stringify(filters ?? {});
  const stableFilters = useMemo(
    () => (filters && Object.keys(filters).length > 0 ? filters : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, not identity
    [filtersKey],
  );
  const conditionsKey = JSON.stringify(conditions ?? []);
  const stableConditions = useMemo(
    () => (conditions && conditions.length > 0 ? conditions : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, not identity
    [conditionsKey],
  );

  const orderByKey = orderBy ? `${orderBy.field}:${orderBy.dir ?? 'ASC'}` : '';

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    source
      .listEntities(collectionId, {
        page,
        pageSize,
        filters: stableFilters,
        conditions: stableConditions,
        search,
        orderBy,
      })
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', page: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- orderBy keyed by content, not identity
  }, [
    source,
    collectionId,
    page,
    pageSize,
    stableFilters,
    stableConditions,
    search,
    orderByKey,
    attempt,
  ]);

  return { ...state, retry };
}
