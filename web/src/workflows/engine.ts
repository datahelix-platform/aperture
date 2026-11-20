import type { BatchOperation } from '../data/batch';
import type { MosaicSource, WriteValues } from '../data/mosaicSource';
import type { WorkflowConfig, WorkflowStepConfig } from './config';

/**
 * The workflow engine (W4.6): a pure interpreter over the steps-as-data
 * config. State is a plain serializable object — it IS the draft (W4.8), so
 * stop/resume is "reload this document". Nothing here talks to the network;
 * the runner feeds staged state to the batch surface (stage → whole-set
 * dry-run → atomic commit, ADR-0028). Confirmed live (#15, hippo 0.10.3):
 * a whole-set dry-run of a PARTIAL staged set never fails spuriously —
 * dry-run validation is permissive (structural echo; constraint checks run
 * only at commit) — so the continuous whole-set dry-run stands unsoftened.
 * XState remains the reference runtime if
 * richer step logic ever needs it; this reducer keeps the MVP dependency-free
 * with the same config-in / serializable-state-out contract.
 */
export interface WorkflowRunState {
  workflowId: string;
  workflowVersion: string;
  /** Pin of the schema the run began under (L10 drift detection). */
  schemaFingerprint: string;
  /** Index of the step being edited; steps.length = the review screen. */
  currentStep: number;
  /** stepId → staged form values (the inert draft buffer). */
  staged: Record<string, WriteValues>;
}

export function initRun(workflow: WorkflowConfig, schemaFingerprint: string): WorkflowRunState {
  return {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    schemaFingerprint,
    currentStep: 0,
    staged: {},
  };
}

/** Stage a step's values and advance to the next unstaged step (or review). */
export function stageStep(
  workflow: WorkflowConfig,
  state: WorkflowRunState,
  stepId: string,
  values: WriteValues,
): WorkflowRunState {
  const index = workflow.steps.findIndex((s) => s.id === stepId);
  if (index === -1) throw new Error(`Unknown step “${stepId}”`);
  const staged = { ...state.staged, [stepId]: values };
  let next = index + 1;
  while (next < workflow.steps.length && staged[workflow.steps[next].id] != null) next += 1;
  return { ...state, staged, currentStep: next };
}

/** Jump back to edit an earlier (staged) step, or forward to review. */
export function goToStep(
  workflow: WorkflowConfig,
  state: WorkflowRunState,
  index: number,
): WorkflowRunState {
  const max = workflow.steps.length;
  const clamped = Math.max(0, Math.min(index, max));
  // Forward jumps only over staged ground — no skipping unstaged steps.
  for (let i = 0; i < clamped && i < max; i += 1) {
    if (state.staged[workflow.steps[i].id] == null) {
      return { ...state, currentStep: i };
    }
  }
  return { ...state, currentStep: clamped };
}

export function isComplete(workflow: WorkflowConfig, state: WorkflowRunState): boolean {
  return workflow.steps.every((s) => state.staged[s.id] != null);
}

/**
 * The staged graph as batch operations: op ref = step id, so a binding's
 * field value is simply the referenced step's ref token. The transport
 * (`buildIngestBatch`) pre-assigns a client id per operation and rewrites
 * these tokens to the referenced sibling's id — the real hippo intra-batch
 * mechanism (client-supplied `data.id`; no server-side ref tokens, #15).
 */
export function buildOperations(
  workflow: WorkflowConfig,
  state: WorkflowRunState,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  for (const step of workflow.steps) {
    const values = state.staged[step.id];
    if (values == null) continue;
    const data: Record<string, unknown> = { ...values };
    for (const binding of step.bindings ?? []) {
      data[binding.field] = binding.fromStep;
    }
    operations.push({ ref: step.id, type: step.entityType, data });
  }
  return operations;
}

/** Fields the engine owns (bound to prior steps) — locked in the step form. */
export function boundFields(step: WorkflowStepConfig): Set<string> {
  return new Set((step.bindings ?? []).map((b) => b.field));
}

export interface WorkflowAvailability {
  runnable: boolean;
  /** Human-readable reasons the workflow is disabled (honest — ADR-0029). */
  reasons: string[];
}

/**
 * A workflow is runnable only when the endpoint offers everything it needs:
 * the batch unit-of-work plus a create path (→ form model) per step type.
 */
export function workflowAvailability(
  workflow: WorkflowConfig,
  source: MosaicSource,
): WorkflowAvailability {
  const reasons: string[] = [];
  if (!source.batch) reasons.push('the endpoint does not advertise a batch unit-of-work');
  for (const step of workflow.steps) {
    const collection = source.collections.find((c) => c.typeName === step.entityType);
    if (!collection) {
      reasons.push(`no collection exposes type “${step.entityType}” (step “${step.label}”)`);
    } else if (!collection.write.create) {
      reasons.push(`type “${step.entityType}” has no create mutation (step “${step.label}”)`);
    } else {
      const formFields = new Set(collection.write.create.form.fields.map((f) => f.name));
      for (const binding of step.bindings ?? []) {
        if (!formFields.has(binding.field)) {
          reasons.push(
            `step “${step.label}” binds unknown field “${binding.field}” on ${step.entityType}`,
          );
        }
      }
    }
  }
  return { runnable: reasons.length === 0, reasons };
}

/**
 * A stable fingerprint of the derived schema (types + fields), pinned into
 * drafts so resume can detect drift (L10). Interim until the mosaicSchema
 * enrichment exposes a real schema_version.
 */
export function schemaFingerprint(source: MosaicSource): string {
  const parts = source.collections
    .map((c) => `${c.typeName}:${c.detailColumns.map((col) => `${col.field}.${col.kind}`).join(',')}`)
    .sort()
    .join('|');
  let hash = 5381;
  for (let i = 0; i < parts.length; i += 1) {
    hash = ((hash << 5) + hash + parts.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
