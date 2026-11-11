import { AppShell } from './shell/AppShell';
import { SHELL_LAYOUTS, shellContextFor } from './shell/contexts';
import { Brand } from './shell/Brand';
import type { AuthConfig } from './auth/config';
import { resolveAuthConfig } from './auth/config';
import { Identity } from './auth/Identity';
import { SessionExpiry } from './auth/SessionExpiry';
import { SessionProvider, useSession } from './auth/SessionContext';
import { DataSourceProvider } from './data/DataSourceContext';
import { resolveEndpoint } from './data/endpoint';
import type { EndpointConfig } from './data/endpoint';
import type { ScopedDataClient } from './data/scopedClient';
import { ControlPlaneProvider } from './control/ControlPlaneContext';
import { ControlPlaneStatus } from './control/ControlPlaneStatus';
import { SavedViewsProvider } from './control/SavedViewsContext';
import { CollectionsNav } from './features/collections/CollectionsNav';
import { CollectionMain } from './features/collections/CollectionMain';
import { FacetPanel } from './features/collections/FacetPanel';
import { ChatPanel } from './query/ChatPanel';
import { ConversationProvider } from './query/ConversationContext';
import { useCollectionUrlState } from './features/collections/urlState';
import type { ResolvedNavConfig } from './nav/config';
import { resolveNavConfig } from './nav/config';
import { NavConfigProvider } from './nav/NavConfigContext';
import type { ResolvedWorkflows } from './workflows/config';
import { resolveWorkflows } from './workflows/config';
import { WorkflowsProvider } from './workflows/WorkflowsContext';
import type { ResolvedXrefs } from './config/xrefs';
import { resolveXrefConfig } from './config/xrefs';
import { XrefsProvider } from './config/XrefsContext';

/**
 * The Phase-0 walking skeleton, end to end: endpoint config → Layer-D
 * adapter → capability negotiation → schema-derived nav + table in the
 * configured layout's slots, with {collection, page} in the URL.
 */

interface AppProps {
  /** Test seams; production uses env config + the real network client. */
  endpoint?: EndpointConfig;
  clientFactory?: (url: string) => ScopedDataClient;
  workflows?: ResolvedWorkflows;
  nav?: ResolvedNavConfig;
  xrefs?: ResolvedXrefs;
  controlUrl?: string | null;
  /**
   * Explicit override for the viewer that owns control-plane documents
   * (ADR-0032). Normally left unset: the identity capability supplies it from
   * the session (ADR-0038). Kept as a seam for tests and for a deployment that
   * resolves identity some other way.
   */
  viewer?: string | null;
  /** Identity configuration; defaults to the runtime overlay (ADR-0034/0038). */
  authConfig?: AuthConfig;
  /** Test seam for the identity request. */
  fetchImpl?: typeof fetch;
}

export function App({
  endpoint = resolveEndpoint(),
  clientFactory,
  workflows = resolveWorkflows(),
  nav = resolveNavConfig(),
  xrefs = resolveXrefConfig(),
  controlUrl,
  viewer,
  authConfig = resolveAuthConfig(),
  fetchImpl,
}: AppProps) {
  return (
    <SessionProvider config={authConfig} fetchImpl={fetchImpl}>
      <DataSourceProvider endpoint={endpoint} clientFactory={clientFactory}>
        <AppBody
          clientFactory={clientFactory}
          controlUrl={controlUrl}
          viewer={viewer}
          workflows={workflows}
          nav={nav}
          xrefs={xrefs}
        />
      </DataSourceProvider>
    </SessionProvider>
  );
}

/**
 * Inside both providers, so the control plane can take its document owner from
 * the session (ADR-0038 fills ADR-0032's viewer seam). An explicit `viewer`
 * prop still wins, for tests and for a deployment resolving identity elsewhere.
 */
function AppBody({
  clientFactory,
  controlUrl,
  viewer,
  workflows,
  nav,
  xrefs,
}: Pick<AppProps, 'clientFactory' | 'controlUrl' | 'viewer'> & {
  workflows: ResolvedWorkflows;
  nav: ResolvedNavConfig;
  xrefs: ResolvedXrefs;
}) {
  const session = useSession();
  // Browsing a collection and composing a cross-class query are different
  // screen shapes, so the portal selects a different layout for each — by
  // name, from the registry (ADR-0031). The bindings follow the context's
  // shape: facets refine a collection, the conversation composes a query.
  const context = shellContextFor(useCollectionUrlState().view);
  const inQuery = context === 'query';
  return (
    <ControlPlaneProvider
      controlUrl={controlUrl}
      clientFactory={clientFactory}
      viewer={viewer ?? session.viewer}
    >
      <SavedViewsProvider>
        <WorkflowsProvider value={workflows}>
          <NavConfigProvider value={nav}>
          <XrefsProvider value={xrefs}>
            {/* App-level, not layout chrome — so it needs no new slot (ADR-0031). */}
            <SessionExpiry />
            {/* Above the shell because the composer (aside) and the builder
                (main) are different slots that share one conversation. */}
            <ConversationProvider>
            <AppShell
              config={{ layout: SHELL_LAYOUTS[context] }}
              slots={{
                header: (
                  <>
                    <Brand />
                    <Identity />
                  </>
                ),
                primaryNav: <CollectionsNav />,
                main: <CollectionMain />,
                inspector: inQuery ? undefined : <FacetPanel />,
                aside: inQuery ? <ChatPanel /> : undefined,
                footer: <ControlPlaneStatus />,
              }}
            />
            </ConversationProvider>
          </XrefsProvider>
          </NavConfigProvider>
        </WorkflowsProvider>
      </SavedViewsProvider>
    </ControlPlaneProvider>
  );
}
