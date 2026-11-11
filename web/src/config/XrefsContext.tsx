import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useControlPlane } from '../control/ControlPlaneContext';
import { openPayload, sealPayload } from '../control/store';
import type { ResolvedXrefs } from './xrefs';
import { DEFAULT_XREF_TEMPLATES, parseXrefConfig } from './xrefs';

/**
 * External cross-link config (ADR-0015). Resolution order matches the nav and
 * workflows config (ADR-0003/0004/0012): a control-plane `config/xrefs`
 * document wins over the env-resolved default (`VITE_XREFS`) as a whole
 * document; an INVALID document falls back to env with the error surfaced —
 * never swallowed (ADR-0029).
 */
export const XREF_CONFIG_VERSION = 1;

export function sealXrefConfig(config: unknown): string {
  return sealPayload(XREF_CONFIG_VERSION, config);
}

const XrefsContext = createContext<ResolvedXrefs>({ templates: DEFAULT_XREF_TEMPLATES });

export function XrefsProvider({
  value,
  children,
}: {
  /** The env-resolved default (VITE_XREFS). */
  value: ResolvedXrefs;
  children: ReactNode;
}) {
  const { status: storeStatus, store } = useControlPlane();
  const [resolved, setResolved] = useState<ResolvedXrefs>(value);

  useEffect(() => {
    setResolved(value);
    if (storeStatus !== 'ready') return;
    let cancelled = false;
    store
      .get('config', 'xrefs')
      .then((document) => {
        if (cancelled || document == null) return;
        // The envelope check is version-only; parseXrefConfig is the
        // structural validator for the data inside.
        const isAny = (d: unknown): d is unknown => d !== undefined;
        const raw = openPayload(document.payload, XREF_CONFIG_VERSION, isAny);
        if (raw == null) {
          setResolved({
            templates: value.templates,
            error: 'The control-plane xref config has an invalid envelope — using the local config.',
          });
          return;
        }
        try {
          setResolved({ templates: parseXrefConfig(raw) });
        } catch (error) {
          setResolved({
            templates: value.templates,
            error: `The control-plane xref config is invalid: ${
              error instanceof Error ? error.message : String(error)
            } — using the local config.`,
          });
        }
      })
      .catch(() => {
        // Store unreachable → the env default stands.
      });
    return () => {
      cancelled = true;
    };
  }, [storeStatus, store, value]);

  return <XrefsContext.Provider value={resolved}>{children}</XrefsContext.Provider>;
}

export function useXrefs(): ResolvedXrefs {
  return useContext(XrefsContext);
}
