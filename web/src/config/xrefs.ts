import { runtimeEnv } from './runtime';

/**
 * External cross-reference templates (R3.8, ADR-0015 cross-link half): field
 * name → URL template with a `{value}` placeholder, e.g.
 * `{"accession": "https://registry.example.org/{value}"}`. Level-1 binding
 * config — data, not code (ADR-0003/0004). The generic default is none.
 *
 * Source of config, resolved the same way as `nav` and `workflows`: a
 * control-plane `config/xrefs` document (versioned envelope) wins over the
 * `VITE_XREFS` env var (JSON). An invalid config is surfaced, never swallowed
 * (ADR-0029). See `XrefsContext.tsx` for the document half.
 */
export type XrefTemplates = Record<string, string>;

export const DEFAULT_XREF_TEMPLATES: XrefTemplates = {};

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Structural validator. Each template must be an absolute http(s) URL that
 * carries the `{value}` placeholder — a config typo should be reported, not
 * render a link that ignores the value or points at a `javascript:` URL.
 */
export function parseXrefConfig(raw: unknown): XrefTemplates {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    fail('xref config must be a JSON object of field → URL template');
  }
  const templates: XrefTemplates = {};
  for (const [field, template] of Object.entries(raw as Record<string, unknown>)) {
    if (field === '') fail('xref config has an empty field name');
    if (typeof template !== 'string' || template === '') {
      fail(`xref config ${field} must be a URL template`);
    }
    if (!/^https?:\/\//i.test(template)) {
      fail(`xref config ${field} must be an http(s) URL template`);
    }
    if (!template.includes('{value}')) {
      fail(`xref config ${field} must contain the {value} placeholder`);
    }
    templates[field] = template;
  }
  return templates;
}

export interface ResolvedXrefs {
  templates: XrefTemplates;
  /** A config parse problem — surfaced, never swallowed (ADR-0029). */
  error?: string;
}

export function resolveXrefConfig(env: Record<string, unknown> = runtimeEnv()): ResolvedXrefs {
  const raw = env['VITE_XREFS'];
  if (typeof raw !== 'string' || raw.trim() === '') return { templates: DEFAULT_XREF_TEMPLATES };
  try {
    return { templates: parseXrefConfig(JSON.parse(raw)) };
  } catch (error) {
    return {
      templates: DEFAULT_XREF_TEMPLATES,
      error: `VITE_XREFS is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function xrefUrl(
  field: string,
  value: unknown,
  templates: XrefTemplates = DEFAULT_XREF_TEMPLATES,
): string | undefined {
  if (!Object.hasOwn(templates, field)) return undefined;
  const template = templates[field];
  if (!template || value == null || value === '') return undefined;
  return template.replaceAll('{value}', encodeURIComponent(String(value)));
}
