import { useControlPlane } from './ControlPlaneContext';

/**
 * The footer status line: where saved views/drafts/config actually live, and
 * whether they are partitioned per viewer — persistence scope stays legible
 * (ADR-0029). The scoping half matters because a shared namespace means a
 * colleague's saved view can be overwritten by name collision; users should
 * not have to discover that empirically.
 */
export function ControlPlaneStatus() {
  const { status, store } = useControlPlane();
  // data-testid is the stable certification contract (datahelix golden-path
  // suite; #15) — the scenario asserts the Mosaic-backed store is reported.
  if (status !== 'ready') {
    return <span data-testid="control-plane-status">Control plane: resolving…</span>;
  }
  const backend =
    store.backend === 'mosaic'
      ? 'LinkML-on-Mosaic document store'
      : 'this browser only (no document type advertised by the endpoint)';
  const scoping =
    store.scoping === 'per-user'
      ? `, your own (${store.viewer})`
      : ', shared by everyone using this endpoint';
  return (
    <span data-testid="control-plane-status">
      Control plane: {backend}
      {scoping}
    </span>
  );
}
