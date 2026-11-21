import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Capabilities } from './capabilities';
import { NO_CAPABILITIES } from './capabilities';
import type { EndpointConfig } from './endpoint';
import type { MosaicSource } from './mosaicSource';
import { connectMosaicSource } from './mosaicSource';
import type { ScopedDataClient } from './scopedClient';
import { createPassthroughClient } from './scopedClient';

/**
 * Step 0.4 — the capability seam (ADR-0029): the UI reads negotiated
 * capabilities from here and gates features on them. `unconfigured` /
 * `error` are honest states the shell surfaces, not silent fallbacks.
 */
export type DataSourceState =
  | { status: 'unconfigured' }
  | { status: 'connecting' }
  | { status: 'ready'; source: MosaicSource }
  | { status: 'error'; message: string };

const DataSourceContext = createContext<DataSourceState>({ status: 'unconfigured' });

interface DataSourceProviderProps {
  endpoint: EndpointConfig;
  /** Test seam: inject a fake ScopedDataClient instead of a network client. */
  clientFactory?: (url: string) => ScopedDataClient;
  children: ReactNode;
}

export function DataSourceProvider({ endpoint, clientFactory, children }: DataSourceProviderProps) {
  const [state, setState] = useState<DataSourceState>(
    endpoint.url ? { status: 'connecting' } : { status: 'unconfigured' },
  );
  const makeClient = useMemo(() => clientFactory ?? createPassthroughClient, [clientFactory]);

  useEffect(() => {
    if (!endpoint.url) {
      setState({ status: 'unconfigured' });
      return;
    }
    let cancelled = false;
    setState({ status: 'connecting' });
    connectMosaicSource(makeClient(endpoint.url))
      .then((source) => {
        if (!cancelled) setState({ status: 'ready', source });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint.url, makeClient]);

  return <DataSourceContext.Provider value={state}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSourceState {
  return useContext(DataSourceContext);
}

/** Negotiated capabilities; NO_CAPABILITIES until a source is ready (never faked). */
export function useCapabilities(): Capabilities {
  const state = useDataSource();
  return state.status === 'ready' ? state.source.capabilities : NO_CAPABILITIES;
}
