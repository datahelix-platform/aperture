import type { ControlPlaneStore } from '../control/store';
import { openPayload, sealPayload } from '../control/store';
import type { WorkflowRunState } from './engine';

/**
 * Resumable drafts (W4.8/L10): the run state persists as an INERT
 * control-plane document — nothing enters the domain graph until the atomic
 * commit. On a Mosaic control plane the draft survives across browsers; on
 * the local fallback it lives in this browser (the footer says which). The
 * draft pins workflow + schema version via the fields inside
 * WorkflowRunState, so resume can detect drift instead of silently breaking.
 */
const DRAFT_VERSION = 1;

export interface WorkflowDraft {
  state: WorkflowRunState;
  savedAt: string;
}

function isDraftData(data: unknown): data is WorkflowDraft {
  if (typeof data !== 'object' || data == null) return false;
  const d = data as Record<string, unknown>;
  const state = d['state'] as Record<string, unknown> | undefined;
  return (
    typeof d['savedAt'] === 'string' &&
    typeof state === 'object' &&
    state != null &&
    typeof state['workflowId'] === 'string' &&
    typeof state['workflowVersion'] === 'string' &&
    typeof state['schemaFingerprint'] === 'string' &&
    typeof state['currentStep'] === 'number' &&
    typeof state['staged'] === 'object'
  );
}

export async function saveDraft(store: ControlPlaneStore, state: WorkflowRunState): Promise<void> {
  await store.put({
    kind: 'workflowDraft',
    name: state.workflowId,
    payload: sealPayload(DRAFT_VERSION, {
      state,
      savedAt: new Date().toISOString(),
    } satisfies WorkflowDraft),
  });
}

/** Corrupt/foreign drafts read as absent — resume never crashes. */
export async function loadDraft(
  store: ControlPlaneStore,
  workflowId: string,
): Promise<WorkflowDraft | null> {
  const document = await store.get('workflowDraft', workflowId);
  if (document == null) return null;
  return openPayload(document.payload, DRAFT_VERSION, isDraftData);
}

export async function clearDraft(store: ControlPlaneStore, workflowId: string): Promise<void> {
  await store.remove('workflowDraft', workflowId);
}
