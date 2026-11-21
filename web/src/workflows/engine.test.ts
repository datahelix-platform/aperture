import { createLocalStore } from '../control/store';
import { connectMosaicSource } from '../data/mosaicSource';
import { capableSchema, fakeClient } from '../data/testing/fixtures';
import { parseWorkflowConfigs, resolveWorkflows } from './config';
import type { WorkflowConfig } from './config';
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
import { clearDraft, loadDraft, saveDraft } from './draft';

const REGISTER: WorkflowConfig = {
  id: 'register-work',
  version: '1',
  label: 'Register a work',
  steps: [
    { id: 'author-step', label: 'Register author', entityType: 'Author' },
    {
      id: 'book-step',
      label: 'Add book',
      entityType: 'Book',
      bindings: [{ field: 'author', fromStep: 'author-step' }],
    },
  ],
};

describe('workflow config (W4.6 — steps-as-data)', () => {
  it('parses and validates a config', () => {
    const parsed = parseWorkflowConfigs([REGISTER]);
    expect(parsed).toEqual([REGISTER]);
    // Round-trips as plain JSON (config-as-data).
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it('rejects malformed configs with a pointed message', () => {
    expect(() => parseWorkflowConfigs([{ id: 'x' }])).toThrow(/version must be a string/);
    expect(() =>
      parseWorkflowConfigs([
        { ...REGISTER, steps: [REGISTER.steps[1]] }, // binding to a step that isn't earlier
      ]),
    ).toThrow(/not an earlier step/);
  });

  it('resolves from env; an invalid value is reported, not swallowed', () => {
    expect(resolveWorkflows({ VITE_WORKFLOWS: JSON.stringify([REGISTER]) }).workflows).toHaveLength(1);
    expect(resolveWorkflows({}).workflows).toEqual([]);
    const bad = resolveWorkflows({ VITE_WORKFLOWS: 'not-json' });
    expect(bad.workflows).toEqual([]);
    expect(bad.error).toMatch(/VITE_WORKFLOWS is invalid/);
  });
});

describe('workflow engine (pure, serializable state = the draft)', () => {
  it('stages steps forward, supports back-edit, completes, and serializes', () => {
    let state = initRun(REGISTER, 'fp-1');
    expect(state.currentStep).toBe(0);
    expect(isComplete(REGISTER, state)).toBe(false);

    state = stageStep(REGISTER, state, 'author-step', { name: 'A' });
    expect(state.currentStep).toBe(1);
    state = stageStep(REGISTER, state, 'book-step', { title: 'T', page_count: 3 });
    expect(state.currentStep).toBe(2); // review
    expect(isComplete(REGISTER, state)).toBe(true);

    // Back-edit an earlier step; restaging returns to review (all staged).
    state = goToStep(REGISTER, state, 0);
    expect(state.currentStep).toBe(0);
    state = stageStep(REGISTER, state, 'author-step', { name: 'B' });
    expect(state.currentStep).toBe(2);

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('never jumps forward over unstaged steps', () => {
    const state = initRun(REGISTER, 'fp-1');
    expect(goToStep(REGISTER, state, 2).currentStep).toBe(0);
  });

  it('builds batch operations with binding fields as intra-batch ref tokens', () => {
    let state = initRun(REGISTER, 'fp-1');
    state = stageStep(REGISTER, state, 'author-step', { name: 'A' });
    state = stageStep(REGISTER, state, 'book-step', { title: 'T' });
    expect(buildOperations(REGISTER, state)).toEqual([
      { ref: 'author-step', type: 'Author', data: { name: 'A' } },
      { ref: 'book-step', type: 'Book', data: { title: 'T', author: 'author-step' } },
    ]);
    expect([...boundFields(REGISTER.steps[1])]).toEqual(['author']);
  });
});

describe('workflowAvailability (honest gating — ADR-0029)', () => {
  it('is runnable when batch + create paths + binding fields all exist', async () => {
    const source = await connectMosaicSource(fakeClient(capableSchema({ authorWrite: true })));
    expect(workflowAvailability(REGISTER, source)).toEqual({ runnable: true, reasons: [] });
  });

  it('reports each missing prerequisite by name', async () => {
    const source = await connectMosaicSource(fakeClient(capableSchema()));
    const availability = workflowAvailability(REGISTER, source);
    expect(availability.runnable).toBe(false);
    expect(availability.reasons.join(' ')).toMatch(/Author.*no create mutation/);

    const badBinding: WorkflowConfig = {
      ...REGISTER,
      steps: [
        REGISTER.steps[0],
        { ...REGISTER.steps[1], bindings: [{ field: 'nonsense', fromStep: 'author-step' }] },
      ],
    };
    const withWrite = await connectMosaicSource(fakeClient(capableSchema({ authorWrite: true })));
    expect(workflowAvailability(badBinding, withWrite).reasons.join(' ')).toMatch(
      /unknown field “nonsense”/,
    );
  });
});

describe('drafts (W4.8 — inert, version-pinned, resumable control-plane documents)', () => {
  beforeEach(() => window.localStorage.clear());

  it('save → load round-trips the run state; clear removes it', async () => {
    const store = createLocalStore();
    let state = initRun(REGISTER, 'fp-9');
    state = stageStep(REGISTER, state, 'author-step', { name: 'A' });
    await saveDraft(store, state);

    const draft = await loadDraft(store, 'register-work');
    expect(draft?.state).toEqual(state);
    expect(draft?.state.schemaFingerprint).toBe('fp-9'); // the drift pin

    await clearDraft(store, 'register-work');
    expect(await loadDraft(store, 'register-work')).toBeNull();
  });

  it('a corrupt draft reads as absent, never crashes resume', async () => {
    const store = createLocalStore();
    window.localStorage.setItem('aperture:cp:workflowDraft:register-work', '{nope');
    expect(await loadDraft(store, 'register-work')).toBeNull();
  });
});

describe('schemaFingerprint (interim schema-version pin)', () => {
  it('is stable for the same schema and changes when the schema changes', async () => {
    const a = await connectMosaicSource(fakeClient(capableSchema()));
    const b = await connectMosaicSource(fakeClient(capableSchema()));
    const c = await connectMosaicSource(fakeClient(capableSchema({ authorDetail: true })));
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
    expect(schemaFingerprint(a)).not.toBe(schemaFingerprint(c));
  });
});
