import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { runtimeEnv } from '../config/runtime';
import { useDataSource } from '../data/DataSourceContext';
import { connectMosaicSource } from '../data/mosaicSource';
import type { ScopedDataClient } from '../data/scopedClient';
import { createPassthroughClient } from '../data/scopedClient';
import type { ControlPlaneStore } from './store';
import { createMosaicStore, createLocalStore, findDocumentCollection } from './store';

/**
 * Resolves the control-plane store once per session (N5.4): the control
 * endpoint defaults to the data-plane endpoint (co-located for MVP;
 * `VITE_CONTROL_PLANE_URL` points elsewhere when split). If the
 * endpoint's schema advertises an Aperture document type, documents live
 * there; otherwise persistence falls back to this browser's localStorage —
 * and the UI says so (ADR-0029).
 *
 * `viewer` is the identity documents are owned by (ADR-0032 ownership
 * amendment). It is the seam the authentication capability fills in: today it
 * is always null, which yields exactly the pre-amendment single-namespace
 * behavior. It is deliberately NOT read from runtime config — a
 * client-declared identity would be a footgun, not a feature.
 */
export interface ControlPlaneState {
  status: 'resolving' | 'ready';
  store: ControlPlaneStore;
}

const ControlPlaneContext = createContext<ControlPlaneState>({
  status: 'resolving',
  store: createLocalStore(),
});

export function resolveControlPlaneUrl(
  env: Record<string, unknown> = runtimeEnv(),
): string | null {
  const raw = env['VITE_CONTROL_PLANE_URL'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function ControlPlaneProvider({
  controlUrl = resolveControlPlaneUrl(),
  clientFactory = createPassthroughClient,
  viewer = null,
  children,
}: {
  /** Explicit control-plane endpoint; null → co-located with the data plane. */
  controlUrl?: string | null;
  clientFactory?: (url: string) => ScopedDataClient;
  /**
   * The current viewer's stable identity (UPN/EDIPI, never email). null → no
   * identity, so documents are unowned and the store is a single namespace.
   */
  viewer?: string | null;
  children: ReactNode;
}) {
  const dataState = useDataSource();
  const [state, setState] = useState<ControlPlaneState>({
    status: 'resolving',
    store: createLocalStore(),
  });

  useEffect(() => {
    let cancelled = false;
    const fallback = () => {
      if (!cancelled) {
        setState({ status: 'ready', store: createLocalStore(window.localStorage, viewer) });
      }
    };

    if (controlUrl == null) {
      // Co-located: the data-plane source doubles as the control plane.
      if (dataState.status === 'connecting') return; // wait for the outcome
      if (dataState.status !== 'ready') return fallback();
      const collection = findDocumentCollection(dataState.source);
      if (!cancelled) {
        setState({
          status: 'ready',
          store: collection
            ? createMosaicStore(dataState.source, collection, viewer)
            : createLocalStore(window.localStorage, viewer),
        });
      }
      return;
    }

    connectMosaicSource(clientFactory(controlUrl))
      .then((source) => {
        if (cancelled) return;
        const collection = findDocumentCollection(source);
        setState({
          status: 'ready',
          store: collection
            ? createMosaicStore(source, collection, viewer)
            : createLocalStore(window.localStorage, viewer),
        });
      })
      .catch(fallback);
    return () => {
      cancelled = true;
    };
  }, [controlUrl, clientFactory, dataState, viewer]);

  return <ControlPlaneContext.Provider value={state}>{children}</ControlPlaneContext.Provider>;
}

export function useControlPlane(): ControlPlaneState {
  return useContext(ControlPlaneContext);
}
