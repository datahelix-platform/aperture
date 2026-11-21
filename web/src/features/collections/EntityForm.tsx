import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { MosaicSource } from '../../data/mosaicSource';
import type { CollectionModel } from '../../data/schemaModel';
import type { FormDraft } from './formShared';
import { clientValidate, FormFieldRow, initialDraft, toWriteValues } from './formShared';
import { useCollectionUrlState } from './urlState';
import './collections.css';

/**
 * The Tier-0 generated form (W4.1–W4.5): fields derive from the mutation's
 * input type, widget per slot kind, `required` honored. Client pre-validation
 * gives fast feedback; the SERVER stays the validation authority — its
 * rejection is surfaced verbatim and attributed to fields where the message
 * names one (a heuristic seam until Hippo's structured ValidationResult
 * shape is confirmed over GraphQL). Updates are partial-merge: only touched,
 * non-empty fields travel (clearing a field is a later affordance).
 */
export function EntityForm({
  source,
  collection,
  mode,
  entityId,
}: {
  source: MosaicSource;
  collection: CollectionModel;
  mode: 'new' | 'edit';
  entityId?: string;
}) {
  const { closeForm, openEntity, openIn } = useCollectionUrlState();
  const write = mode === 'new' ? collection.write.create : collection.write.update;
  const fields = useMemo(() => write?.form.fields ?? [], [write]);

  const [draft, setDraft] = useState<FormDraft>(() => initialDraft(fields));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'submitting'>(
    mode === 'edit' ? 'loading' : 'ready',
  );

  // Edit prefills from the entity along the detail path.
  useEffect(() => {
    if (mode !== 'edit' || !entityId) return;
    let cancelled = false;
    source
      .getEntity(collection.id, entityId)
      .then((entity) => {
        if (cancelled) return;
        setDraft(initialDraft(fields, entity ?? undefined));
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setServerError(error instanceof Error ? error.message : String(error));
        setPhase('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [source, collection.id, mode, entityId, fields]);

  if (!write) return null; // routing guards this; belt-and-braces

  const set = (name: string, value: string | boolean) => {
    setDraft((d) => ({ ...d, [name]: value }));
    setTouched((t) => new Set(t).add(name));
    setFieldErrors((errors) => {
      const next = { ...errors };
      delete next[name];
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const errors = clientValidate(fields, draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setPhase('submitting');
    try {
      if (mode === 'new') {
        const newId = await source.createEntity(collection.id, toWriteValues(fields, draft));
        if (newId && collection.detail) openIn(collection.id, newId);
        else closeForm();
      } else {
        await source.updateEntity(collection.id, entityId!, toWriteValues(fields, draft, touched));
        openEntity(entityId!);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setServerError(message);
      // Field attribution heuristic: mark fields the server names. Confirmed
      // live (#15, hippo 0.10.3): rejections are plain GraphQL error messages
      // — input-coercion names the field ("Field 'title' of required type…"),
      // NOT NULL names the column ("NOT NULL constraint failed: Author.name").
      const attributed: Record<string, string> = {};
      for (const field of fields) {
        if (message.toLowerCase().includes(field.name.toLowerCase())) {
          attributed[field.name] = 'See server message above.';
        }
      }
      // A bare "FOREIGN KEY constraint failed" names no field (verified live)
      // — attribute it to the form's reference fields.
      if (Object.keys(attributed).length === 0 && /foreign key/i.test(message)) {
        for (const field of fields) {
          if (field.widget === 'ref') attributed[field.name] = 'See server message above.';
        }
      }
      setFieldErrors(attributed);
      setPhase('ready');
    }
  };

  const title = mode === 'new' ? `New ${collection.typeName}` : `Edit ${entityId}`;

  return (
    <div className="detail-view">
      <div className="detail-header">
        <button type="button" className="detail-back" onClick={closeForm}>
          ← {mode === 'edit' && entityId ? entityId : collection.label}
        </button>
        <div className="detail-title-row">
          <span className="form-title">{title}</span>
          <span className="detail-type-chip">{collection.typeName}</span>
        </div>
      </div>

      {phase === 'loading' ? (
        <div className="main-panel" role="status">
          <p className="main-panel-detail">Loading record…</p>
        </div>
      ) : (
        // data-testid attributes are the stable certification contract
        // (datahelix golden-path suite; #15) — keep them.
        <form
          className="entity-form"
          data-testid="entity-form"
          onSubmit={(e) => void submit(e)}
          noValidate
        >
          {serverError && (
            <div className="form-server-error" role="alert">
              <strong>The server rejected the submission.</strong> {serverError}
            </div>
          )}
          {fields.map((field) => (
            <FormFieldRow
              key={field.name}
              field={field}
              value={draft[field.name] ?? ''}
              error={fieldErrors[field.name]}
              source={source}
              onChange={(v) => set(field.name, v)}
            />
          ))}
          <div className="form-actions">
            <button
              type="submit"
              className="form-submit"
              data-testid="form-submit"
              disabled={phase === 'submitting'}
            >
              {phase === 'submitting' ? 'Submitting…' : mode === 'new' ? 'Create' : 'Save changes'}
            </button>
            <button type="button" className="state-button" onClick={closeForm}>
              Cancel
            </button>
            <span className="form-footnote">
              The server validates authoritatively on submit.
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
