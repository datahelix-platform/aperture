import { useEffect, useMemo, useState } from 'react';
import { useControlPlane } from '../control/ControlPlaneContext';
import type { BatchOpError, BatchResult } from '../data/batch';
import { useDataSource } from '../data/DataSourceContext';
import type { MosaicSource, WriteValues } from '../data/mosaicSource';
import type { FormDraft } from '../features/collections/formShared';
import {
  clientValidate,
  FormFieldRow,
  initialDraft,
  toWriteValues,
} from '../features/collections/formShared';
import { useCollectionUrlState } from '../features/collections/urlState';
import type { WorkflowConfig, WorkflowStepConfig } from './config';
import {
  boundFields,
  buildOperations,
  goToStep,
  initRun,
  isComplete,
  schemaFingerprint,
  stageStep,
  workflowAvailability,
} from './engine';
import type { WorkflowRunState } from './engine';
import { clearDraft, loadDraft, saveDraft } from './draft';
import { useWorkflows } from './WorkflowsContext';
import './workflows.css';

/**
 * The Tier-1 guided workflow runner (W4.6–W4.9; ADR-0028): steps render via
 * the Tier-0 form generator, entities STAGE in the inert draft (persisted for
 * resume, version-pinned), every stage runs a whole-set dry-run over the
 * staged graph so far (continuous validation), and the review screen runs the
 * final whole-set dry-run before ONE atomic commit. No partial run is ever
 * visible; a rejected batch commits nothing.
 *
 * Live semantics (#15, hippo 0.10.3): `ingestBatch(dryRun: true)` is
 * permissive on partial sets (never a spurious failure), so the continuous
 * dry-run needs no per-step softening; commit-time constraint violations
 * (FK/NOT NULL) roll the whole batch back and surface as a thrown transport
 * error, displayed above the review screen.
 */
export function WorkflowRunner({ workflowId }: { workflowId: string }) {
  const { workflows, error } = useWorkflows();
  const state = useDataSource();
  const { closeWorkflow } = useCollectionUrlState();

  const workflow = workflows.find((w) => w.id === workflowId);

  if (state.status !== 'ready') {
    return (
      <div className="main-panel" role="status">
        <p className="main-panel-detail">Waiting for the data source…</p>
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="main-panel" role="status">
        <h1 className="main-panel-title">Unknown workflow “{workflowId}”</h1>
        <p className="main-panel-detail">
          {error ?? 'No configured workflow has this id.'}{' '}
          <button type="button" className="detail-link" onClick={closeWorkflow}>
            Back
          </button>
        </p>
      </div>
    );
  }

  const availability = workflowAvailability(workflow, state.source);
  if (!availability.runnable) {
    return (
      <div className="main-panel" role="status">
        <h1 className="main-panel-title">“{workflow.label}” can’t run against this endpoint</h1>
        <ul className="main-panel-detail wf-reasons">
          {availability.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
    );
  }

  return <Runner workflow={workflow} source={state.source} />;
}

type Notice =
  | { kind: 'resumed'; savedAt: string }
  | { kind: 'drift'; savedAt: string }
  | null;

function Runner({ workflow, source }: { workflow: WorkflowConfig; source: MosaicSource }) {
  const { closeWorkflow, openIn } = useCollectionUrlState();
  const { status: storeStatus, store } = useControlPlane();
  const fingerprint = useMemo(() => schemaFingerprint(source), [source]);

  const [notice, setNotice] = useState<Notice>(null);
  // null until the control-plane draft lookup resolves (W4.8 — async store).
  const [run, setRun] = useState<WorkflowRunState | null>(null);

  useEffect(() => {
    if (storeStatus !== 'ready' || run != null) return;
    let cancelled = false;
    loadDraft(store, workflow.id)
      .then((draft) => {
        if (cancelled) return;
        if (draft && draft.state.workflowVersion === workflow.version) {
          setRun(draft.state);
          setNotice(
            draft.state.schemaFingerprint === fingerprint
              ? { kind: 'resumed', savedAt: draft.savedAt }
              : { kind: 'drift', savedAt: draft.savedAt },
          );
        } else {
          setRun(initRun(workflow, fingerprint));
        }
      })
      .catch(() => {
        if (!cancelled) setRun(initRun(workflow, fingerprint));
      });
    return () => {
      cancelled = true;
    };
  }, [storeStatus, store, workflow, fingerprint, run]);

  const [batchErrors, setBatchErrors] = useState<BatchOpError[]>([]);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [draftIssue, setDraftIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<BatchResult | null>(null);

  const update = (next: WorkflowRunState) => {
    setRun(next);
    // The draft is the state — every change persists (W4.8). A store failure
    // must not block the run, but it must not be silent either.
    saveDraft(store, next)
      .then(() => setDraftIssue(null))
      .catch((error: unknown) =>
        setDraftIssue(
          `Draft could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  };

  const discard = () => {
    void clearDraft(store, workflow.id).catch(() => {});
    setRun(initRun(workflow, fingerprint));
    setNotice(null);
    setBatchErrors([]);
    setTransportError(null);
    setDraftIssue(null);
  };

  const runDryRun = async (state: WorkflowRunState): Promise<BatchOpError[] | null> => {
    setTransportError(null);
    try {
      const result = await source.runBatch(buildOperations(workflow, state), true);
      return result.errors;
    } catch (error) {
      setTransportError(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const commit = async () => {
    if (run == null) return;
    setBusy(true);
    setBatchErrors([]);
    setTransportError(null);
    try {
      const result = await source.runBatch(buildOperations(workflow, run), false);
      if (result.ok && result.errors.length === 0) {
        void clearDraft(store, workflow.id).catch(() => {});
        setCommitted(result);
      } else {
        setBatchErrors(result.errors);
      }
    } catch (error) {
      setTransportError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (committed) {
    return (
      <SuccessPanel workflow={workflow} source={source} result={committed} onClose={closeWorkflow} openIn={openIn} />
    );
  }

  if (run == null) {
    return (
      <div className="main-panel" role="status">
        <p className="main-panel-detail">Checking the control plane for a saved draft…</p>
      </div>
    );
  }

  const atReview = run.currentStep >= workflow.steps.length;
  const currentStep = atReview ? null : workflow.steps[run.currentStep];

  return (
    // data-testid attributes on the runner, its step/commit buttons, and the
    // success panel are the stable certification contract (datahelix
    // golden-path suite; #15) — keep them.
    <div className="wf-runner" data-testid="workflow-runner">
      <div className="detail-header">
        <button type="button" className="detail-back" onClick={closeWorkflow}>
          ← Close (draft saved)
        </button>
        <div className="detail-title-row">
          <span className="form-title">{workflow.label}</span>
          <span className="detail-type-chip">workflow · v{workflow.version}</span>
          <button type="button" className="action-button" onClick={discard}>
            Discard draft
          </button>
        </div>
        {workflow.description && <p className="wf-description">{workflow.description}</p>}
      </div>

      {notice && (
        <div className={notice.kind === 'drift' ? 'wf-notice wf-notice-warn' : 'wf-notice'} role="status">
          {notice.kind === 'resumed'
            ? `Resumed a saved draft from ${notice.savedAt}.`
            : `Resumed a draft from ${notice.savedAt}, but the schema has changed since it was saved — review staged values before committing.`}
        </div>
      )}
      {transportError && (
        <div className="form-server-error wf-margin" role="alert">
          {transportError}
        </div>
      )}
      {draftIssue && (
        <div className="wf-notice wf-notice-warn wf-margin" role="status">
          {draftIssue}
        </div>
      )}

      <Stepper workflow={workflow} run={run} onGoTo={(i) => update(goToStep(workflow, run, i))} />

      {currentStep ? (
        <StepForm
          key={currentStep.id}
          workflow={workflow}
          step={currentStep}
          source={source}
          run={run}
          busy={busy}
          batchErrors={batchErrors}
          onStage={async (values: WriteValues) => {
            setBusy(true);
            const next = stageStep(workflow, run, currentStep.id, values);
            // Continuous per-step dry-run over the staged graph so far (W4.7).
            const errors = await runDryRun(next);
            setBusy(false);
            if (errors == null) return; // transport failure — stay put
            const blocking = errors.filter((e) => e.ref === currentStep.id || e.ref == null);
            setBatchErrors(blocking);
            if (blocking.length === 0) update(next);
          }}
        />
      ) : (
        <ReviewScreen
          workflow={workflow}
          run={run}
          busy={busy}
          batchErrors={batchErrors}
          onEdit={(i) => update(goToStep(workflow, run, i))}
          onValidate={async () => {
            setBusy(true);
            const errors = await runDryRun(run);
            setBusy(false);
            if (errors != null) setBatchErrors(errors);
          }}
          onCommit={() => void commit()}
        />
      )}
    </div>
  );
}

function Stepper({
  workflow,
  run,
  onGoTo,
}: {
  workflow: WorkflowConfig;
  run: WorkflowRunState;
  onGoTo: (index: number) => void;
}) {
  const atReview = run.currentStep >= workflow.steps.length;
  return (
    <ol className="wf-stepper">
      {workflow.steps.map((step, i) => {
        const staged = run.staged[step.id] != null;
        const current = i === run.currentStep;
        return (
          <li key={step.id}>
            <button
              type="button"
              className="wf-step-chip"
              aria-current={current ? 'step' : undefined}
              data-staged={staged}
              disabled={!staged && !current}
              onClick={() => onGoTo(i)}
            >
              <span className="wf-step-index">{staged && !current ? '✓' : i + 1}</span>
              {step.label}
            </button>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          className="wf-step-chip"
          aria-current={atReview ? 'step' : undefined}
          disabled={!isComplete(workflow, run)}
          onClick={() => onGoTo(workflow.steps.length)}
        >
          <span className="wf-step-index">{workflow.steps.length + 1}</span>
          Review &amp; commit
        </button>
      </li>
    </ol>
  );
}

function StepForm({
  workflow,
  step,
  source,
  run,
  busy,
  batchErrors,
  onStage,
}: {
  workflow: WorkflowConfig;
  step: WorkflowStepConfig;
  source: MosaicSource;
  run: WorkflowRunState;
  busy: boolean;
  batchErrors: BatchOpError[];
  onStage: (values: WriteValues) => void | Promise<void>;
}) {
  const collection = source.collections.find((c) => c.typeName === step.entityType)!;
  const locked = boundFields(step);
  const fields = collection.write.create!.form.fields.filter((f) => !locked.has(f.name));

  const [draft, setDraft] = useState<FormDraft>(() => {
    const staged = run.staged[step.id];
    return staged ? initialDraft(fields, staged) : initialDraft(fields);
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const serverErrors = new Map(
    batchErrors.filter((e) => e.field != null).map((e) => [e.field!, e.message]),
  );
  const generalErrors = batchErrors.filter((e) => e.field == null);

  return (
    <form
      className="entity-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const errors = clientValidate(fields, draft);
        setFieldErrors(errors);
        if (Object.keys(errors).length > 0) return;
        void onStage(toWriteValues(fields, draft));
      }}
    >
      <div className="wf-step-heading">
        <h2 className="wf-step-title">{step.label}</h2>
        <span className="detail-type-chip">{step.entityType}</span>
      </div>
      {step.description && <p className="wf-description">{step.description}</p>}
      {generalErrors.length > 0 && (
        <div className="form-server-error" role="alert">
          {generalErrors.map((e) => e.message).join(' · ')}
        </div>
      )}
      {(step.bindings ?? []).map((binding) => {
        const from = workflow.steps.find((s) => s.id === binding.fromStep);
        return (
          <div key={binding.field} className="form-row">
            <span className="form-label">{binding.field}</span>
            <div className="form-control">
              <span className="wf-bound-value">
                from step “{from?.label ?? binding.fromStep}” (linked on commit)
              </span>
            </div>
          </div>
        );
      })}
      {fields.map((field) => (
        <FormFieldRow
          key={field.name}
          field={field}
          value={draft[field.name] ?? ''}
          error={fieldErrors[field.name] ?? serverErrors.get(field.name)}
          source={source}
          onChange={(v) =>
            setDraft((d) => {
              return { ...d, [field.name]: v };
            })
          }
        />
      ))}
      <div className="form-actions">
        <button type="submit" className="form-submit" data-testid="workflow-next" disabled={busy}>
          {busy ? 'Validating…' : 'Stage & continue'}
        </button>
        <span className="form-footnote">
          Staged entities stay in the draft — nothing commits until the final review.
        </span>
      </div>
    </form>
  );
}

function ReviewScreen({
  workflow,
  run,
  busy,
  batchErrors,
  onEdit,
  onValidate,
  onCommit,
}: {
  workflow: WorkflowConfig;
  run: WorkflowRunState;
  busy: boolean;
  batchErrors: BatchOpError[];
  onEdit: (index: number) => void;
  onValidate: () => void;
  onCommit: () => void;
}) {
  const [validated, setValidated] = useState(false);
  const clean = validated && batchErrors.length === 0;

  return (
    <div className="wf-review">
      <h2 className="wf-step-title">Review &amp; commit</h2>
      <p className="wf-description">
        {workflow.steps.length} staged {workflow.steps.length === 1 ? 'entity' : 'entities'} — the
        whole set validates together and commits atomically; a rejection commits nothing
        (ADR-0028).
      </p>
      {batchErrors.length > 0 && (
        <div className="form-server-error" role="alert">
          <strong>The server rejected the staged set.</strong>
          <ul className="wf-reasons">
            {batchErrors.map((e, i) => (
              <li key={i}>
                {e.ref ? `${workflow.steps.find((s) => s.id === e.ref)?.label ?? e.ref}: ` : ''}
                {e.field ? `${e.field} — ` : ''}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {workflow.steps.map((step, i) => {
        const values = run.staged[step.id] ?? {};
        return (
          <div key={step.id} className="wf-review-card">
            <div className="wf-review-card-header">
              <span className="wf-review-card-title">{step.label}</span>
              <span className="detail-type-chip">{step.entityType}</span>
              <button type="button" className="detail-link" onClick={() => onEdit(i)}>
                Edit
              </button>
            </div>
            <dl className="wf-review-values">
              {Object.entries(values).map(([key, value]) => (
                <div key={key} className="wf-review-value-row">
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
              {(step.bindings ?? []).map((binding) => (
                <div key={binding.field} className="wf-review-value-row">
                  <dt>{binding.field}</dt>
                  <dd className="wf-bound-value">
                    → “{workflow.steps.find((s) => s.id === binding.fromStep)?.label}”
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
      <div className="form-actions">
        <button
          type="button"
          className="state-button"
          data-testid="workflow-validate"
          disabled={busy}
          onClick={() => {
            setValidated(true);
            onValidate();
          }}
        >
          {busy ? 'Validating…' : 'Validate whole set'}
        </button>
        <button
          type="button"
          className="form-submit"
          data-testid="workflow-commit"
          disabled={busy || !clean}
          onClick={onCommit}
        >
          {busy ? 'Working…' : 'Commit atomically'}
        </button>
        {!clean && (
          <span className="form-footnote">Run a clean whole-set validation to enable commit.</span>
        )}
      </div>
    </div>
  );
}

function SuccessPanel({
  workflow,
  source,
  result,
  onClose,
  openIn,
}: {
  workflow: WorkflowConfig;
  source: MosaicSource;
  result: BatchResult;
  onClose: () => void;
  openIn: (collection: string, entity: string) => void;
}) {
  return (
    <div className="main-panel" role="status" data-testid="workflow-success">
      <h1 className="main-panel-title">“{workflow.label}” committed atomically</h1>
      <p className="main-panel-detail">All staged entities entered the graph in one transaction:</p>
      <ul className="wf-committed-list">
        {workflow.steps.map((step) => {
          const id = result.ids[step.id];
          const collection = source.collections.find((c) => c.typeName === step.entityType);
          return (
            <li key={step.id}>
              {step.label}:{' '}
              {id && collection?.detail ? (
                <button type="button" className="detail-link" onClick={() => openIn(collection.id, id)}>
                  {id}
                </button>
              ) : (
                <span className="cell-ref">{id ?? '(id not returned)'}</span>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className="state-button" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
