import type { MosaicSource, WriteValues } from '../../data/mosaicSource';
import type { FormFieldModel } from '../../data/schemaModel';
import { RefPicker } from './RefPicker';

/**
 * The shared Tier-0 form machinery (W4.1): draft shape, prefill, write-value
 * conversion, client pre-validation, and the widget renderer — used by the
 * single-entity EntityForm and by workflow step forms (W4.6).
 */
export type FormDraft = Record<string, string | boolean>;

export function initialDraft(fields: FormFieldModel[], entity?: Record<string, unknown>): FormDraft {
  const draft: FormDraft = {};
  for (const field of fields) {
    if (field.widget === 'checkbox') {
      draft[field.name] = entity ? Boolean(entity[field.name]) : false;
    } else if (entity && entity[field.name] != null) {
      const raw = entity[field.name];
      // Prefill refs from the resolved relationship's id.
      draft[field.name] =
        typeof raw === 'object'
          ? String((raw as Record<string, unknown>)['id'] ?? Object.values(raw as object)[0] ?? '')
          : String(raw);
    } else {
      draft[field.name] = '';
    }
  }
  return draft;
}

export function toWriteValues(
  fields: FormFieldModel[],
  draft: FormDraft,
  touched?: Set<string>,
): WriteValues {
  const values: WriteValues = {};
  for (const field of fields) {
    if (touched && !touched.has(field.name)) continue;
    const raw = draft[field.name];
    if (field.widget === 'checkbox') {
      values[field.name] = Boolean(raw);
    } else {
      const text = String(raw ?? '').trim();
      if (text === '') continue; // optional + empty → omit (partial-merge)
      values[field.name] = field.widget === 'number' ? Number(text) : text;
    }
  }
  return values;
}

export function clientValidate(fields: FormFieldModel[], draft: FormDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.widget === 'checkbox') continue;
    const text = String(draft[field.name] ?? '').trim();
    if (field.required && text === '') errors[field.name] = 'Required.';
    else if (field.widget === 'number' && text !== '' && Number.isNaN(Number(text))) {
      errors[field.name] = 'Must be a number.';
    }
  }
  return errors;
}

export function FieldWidget({
  field,
  value,
  source,
  onChange,
}: {
  field: FormFieldModel;
  value: string | boolean;
  source: MosaicSource;
  onChange: (value: string | boolean) => void;
}) {
  // `id` doubles as the stable certification testid (field-<input name>,
  // datahelix golden-path suite; #15) — keep the data-testid attributes.
  const id = `field-${field.name}`;
  switch (field.widget) {
    case 'checkbox':
      return (
        <input
          id={id}
          data-testid={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'select':
      return (
        <select
          id={id}
          data-testid={id}
          className="form-input"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{field.required ? 'Select…' : '(none)'}</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'ref':
      return (
        <RefPicker
          inputId={id}
          source={source}
          targetType={field.targetType}
          value={String(value)}
          onChange={onChange}
        />
      );
    case 'number':
    case 'date':
    case 'text':
      return (
        <input
          id={id}
          data-testid={id}
          type={field.widget === 'number' ? 'number' : field.widget === 'date' ? 'date' : 'text'}
          className="form-input"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Label + widget + error row, shared by entity and workflow-step forms. */
export function FormFieldRow({
  field,
  value,
  error,
  source,
  onChange,
}: {
  field: FormFieldModel;
  value: string | boolean;
  error?: string;
  source: MosaicSource;
  onChange: (value: string | boolean) => void;
}) {
  return (
    <div className="form-row">
      <label className="form-label" htmlFor={`field-${field.name}`}>
        {field.label}
        {field.required && (
          <span className="form-required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <div className="form-control">
        <FieldWidget field={field} value={value} source={source} onChange={onChange} />
        {error && <div className="form-field-error">{error}</div>}
      </div>
    </div>
  );
}
