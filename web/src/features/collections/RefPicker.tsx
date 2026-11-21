import { useEffect, useRef, useState } from 'react';
import type { MosaicSource } from '../../data/mosaicSource';

/**
 * Relationship ref-picker (W4.5): resolves a ref slot by searching the target
 * type's collection — the read loop reused as a picker. Falls back to a plain
 * id input when the target has no browsable collection (honest — ADR-0029).
 */
interface Suggestion {
  id: string;
  hint: string;
}

export function RefPicker({
  source,
  targetType,
  value,
  onChange,
  inputId,
}: {
  source: MosaicSource;
  targetType: string | undefined;
  value: string;
  onChange: (id: string) => void;
  inputId: string;
}) {
  const target = source.collections.find((c) => c.typeName === targetType);
  const [draft, setDraft] = useState(value);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const queryToken = useRef(0);

  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (!target || !open) return;
    const token = ++queryToken.current;
    const searchable = Boolean(target.args.search);
    source
      .listEntities(target.id, {
        page: 1,
        pageSize: 25,
        // Reuse read-loop FTS when the endpoint advertises it; otherwise take
        // the first page and prefix-filter client-side below.
        search: searchable && draft ? draft : undefined,
      })
      .then((result) => {
        if (queryToken.current !== token) return;
        const idField = target.idColumn ?? target.columns[0].field;
        const hintField = target.columns.find((c) => c.field !== idField && c.kind === 'text');
        let items = result.rows.map((row) => ({
          id: String(row[idField] ?? ''),
          hint: hintField ? String(row[hintField.field] ?? '') : '',
        }));
        if (!searchable && draft) {
          const needle = draft.toLowerCase();
          items = items.filter(
            (s) => s.id.toLowerCase().includes(needle) || s.hint.toLowerCase().includes(needle),
          );
        }
        setSuggestions(items.slice(0, 10));
      })
      .catch(() => setSuggestions([]));
  }, [source, target, draft, open]);

  if (!target) {
    // No browsable collection for the target type — plain id entry.
    return (
      <input
        id={inputId}
        data-testid={inputId}
        type="text"
        className="form-input"
        placeholder={`${targetType ?? 'entity'} id`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value.trim());
        }}
      />
    );
  }

  return (
    <div className="ref-picker">
      <input
        id={inputId}
        data-testid={inputId}
        type="text"
        className="form-input"
        placeholder={`Search ${target.label.toLowerCase()}…`}
        value={draft}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Let a click on a suggestion land before closing.
          window.setTimeout(() => setOpen(false), 150);
          onChange(draft.trim());
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul className="ref-picker-list" role="listbox">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={s.id === value}
                className="ref-picker-option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(s.id);
                  setDraft(s.id);
                  setOpen(false);
                }}
              >
                <span className="ref-picker-id">{s.id}</span>
                {s.hint && <span className="ref-picker-hint">{s.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
