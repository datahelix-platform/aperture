import type { MosaicSource } from '../data/mosaicSource';
import type { CollectionModel } from '../data/schemaModel';

/**
 * The control-plane store (Phase 4; ADR-0017, N5.4): Aperture's OWN state —
 * saved views, workflow drafts, config-as-data — lives in a control-plane
 * document store, DISTINCT from the browsed data plane. The MVP reference
 * impl is LinkML-on-Mosaic: documents are ordinary entities on a (co-located)
 * Mosaic whose schema carries an Aperture document type, reached through the
 * same Layer-D machinery as everything else. When no such type is advertised,
 * persistence degrades honestly to this browser's localStorage — labeled as
 * such, never silently (ADR-0029).
 */
export type DocumentKind = 'savedView' | 'workflowDraft' | 'config';

/**
 * Who may LIST a document. Orthogonal to who may WRITE it — writes are always
 * owner-only regardless of visibility (ADR-0032 ownership amendment).
 */
export type Visibility = 'private' | 'shared';

/**
 * Per-kind ownership policy (ADR-0032 ownership amendment).
 *
 * `config` is deliberately NOT owner-stamped: it is deployment state, not user
 * state, and governing who may edit it is an admin-role question that belongs
 * to Bridge. Stamping it would silently make deployment config editable by
 * exactly one person.
 *
 * `savedView` defaults to `shared` rather than `private` because the deployment
 * stance this serves is "every authenticated user may read all data" — making
 * views private by default would restrict *less* sensitive artifacts than the
 * data they describe.
 */
const OWNED_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>(['savedView', 'workflowDraft']);

const DEFAULT_VISIBILITY: Record<DocumentKind, Visibility> = {
  savedView: 'shared',
  workflowDraft: 'private',
  config: 'shared',
};

export function isOwnedKind(kind: DocumentKind): boolean {
  return OWNED_KINDS.has(kind);
}

export function defaultVisibility(kind: DocumentKind): Visibility {
  return DEFAULT_VISIBILITY[kind];
}

export interface ControlPlaneDocument {
  kind: DocumentKind;
  /** Unique per (owner, kind) — e.g. the view name, the workflow id. */
  name: string;
  /** The versioned payload envelope, JSON-serialized. */
  payload: string;
  /**
   * The owning viewer's identity. `null` = unowned: written before the
   * ownership amendment, or by a deployment with no viewer identity. Unowned
   * documents stay readable and writable by everyone — exactly the behavior
   * before this field existed.
   *
   * Set on create and never updated: a writable owner is a stealable owner.
   */
  owner?: string | null;
  /** Absent reads as the kind's default (see DEFAULT_VISIBILITY). */
  visibility?: Visibility;
}

/**
 * Every payload travels inside a versioned envelope; readers skip documents
 * they can't validate (structural validation + versioning, ADR-0003/0004).
 */
export interface PayloadEnvelope<T> {
  v: number;
  data: T;
}

export function sealPayload<T>(v: number, data: T): string {
  return JSON.stringify({ v, data } satisfies PayloadEnvelope<T>);
}

export function openPayload<T>(
  payload: string,
  v: number,
  validate: (data: unknown) => data is T,
): T | null {
  try {
    const parsed = JSON.parse(payload) as PayloadEnvelope<unknown>;
    if (typeof parsed !== 'object' || parsed == null || parsed.v !== v) return null;
    return validate(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ControlPlaneStore {
  /** Where documents live — surfaced in the UI so persistence scope is legible. */
  backend: 'mosaic' | 'local';
  /**
   * Whether documents are partitioned per viewer. 'shared' = one namespace for
   * everyone (no viewer identity, or an endpoint without the ownership fields);
   * 'per-user' = upsert keyed by (owner, kind, name) with owner-only writes.
   * Surfaced in the UI beside `backend` — the partition is never silent
   * (ADR-0029).
   */
  scoping: 'shared' | 'per-user';
  /** The viewer documents are owned by, or null when there is no identity. */
  viewer: string | null;
  list(kind: DocumentKind): Promise<ControlPlaneDocument[]>;
  get(kind: DocumentKind, name: string): Promise<ControlPlaneDocument | null>;
  /**
   * Upsert by (owner, kind, name). Rejects a write to a document owned by
   * someone else — see `canWrite`. This is honest UI behavior, NOT enforcement:
   * a client can still reach the endpoint directly. Enforcement belongs to the
   * store's server side (ADR-0008/0016).
   */
  put(document: ControlPlaneDocument): Promise<void>;
  remove(kind: DocumentKind, name: string): Promise<void>;
  /** False for a document owned by another viewer. Drives affordance gating. */
  canWrite(document: Pick<ControlPlaneDocument, 'kind' | 'owner'>): boolean;
}

/**
 * The write rule, in one place: a document is writable when it is unowned, when
 * its kind is not owner-stamped, or when the viewer owns it.
 */
export function canViewerWrite(
  viewer: string | null,
  document: Pick<ControlPlaneDocument, 'kind' | 'owner'>,
): boolean {
  if (!isOwnedKind(document.kind)) return true;
  const owner = document.owner ?? null;
  if (owner === null) return true; // unowned — pre-amendment document
  return viewer !== null && owner === viewer;
}

/** A document is listable when the viewer owns it or it is shared. */
export function canViewerRead(
  viewer: string | null,
  document: Pick<ControlPlaneDocument, 'kind' | 'owner' | 'visibility'>,
): boolean {
  const owner = document.owner ?? null;
  if (owner === null) return true;
  if (viewer !== null && owner === viewer) return true;
  return (document.visibility ?? defaultVisibility(document.kind)) === 'shared';
}

/** Thrown when a write is declined because the viewer does not own the target. */
export class NotOwnedError extends Error {
  constructor(kind: DocumentKind, name: string, owner: string | null) {
    super(
      `"${name}" belongs to ${owner ?? 'another user'} — ${kind} documents are editable only by their owner. Save it under a new name to make your own copy.`,
    );
    this.name = 'NotOwnedError';
  }
}

/* ------------------------------------------------------------------ */
/* LinkML-on-Mosaic store                                               */
/* ------------------------------------------------------------------ */

/**
 * The document collection is recognized structurally, like every other
 * capability: an entity type with text-ish `kind`, `name`, and `payload`
 * fields, an equality filter over `kind` and `name`, and create + update
 * mutations. Anything less → no Mosaic control plane (fallback applies).
 */
export function findDocumentCollection(source: MosaicSource): CollectionModel | undefined {
  return source.collections.find((c) => {
    const fields = new Map(c.detailColumns.map((col) => [col.field, col.kind]));
    const textish = (f: string) =>
      fields.get(f) === 'text' || fields.get(f) === 'id' || fields.get(f) === 'enum';
    if (!textish('kind') || !textish('name') || !textish('payload')) return false;
    if (!c.filterFields.includes('kind') || !c.filterFields.includes('name')) return false;
    if (!c.write.create || !c.write.update) return false;
    return true;
  });
}

/**
 * Ownership is recognized the same way everything else is — structurally and
 * OPTIONALLY (ADR-0029 applied to the store itself). A collection supports
 * per-user scoping when it carries text-ish `owner` and `visibility` fields
 * and can equality-filter both. A deployment on recipe 1.0.0 simply doesn't,
 * and keeps the single-namespace behavior with the UI saying so.
 */
export function supportsOwnerScoping(collection: CollectionModel): boolean {
  const fields = new Map(collection.detailColumns.map((col) => [col.field, col.kind]));
  const textish = (f: string) =>
    fields.get(f) === 'text' || fields.get(f) === 'id' || fields.get(f) === 'enum';
  return (
    textish('owner') &&
    textish('visibility') &&
    collection.filterFields.includes('owner') &&
    collection.filterFields.includes('visibility')
  );
}

export function createMosaicStore(
  source: MosaicSource,
  collection: CollectionModel,
  viewer: string | null = null,
): ControlPlaneStore {
  const idField = collection.idColumn ?? collection.columns[0].field;
  // Per-user scoping needs BOTH an identity and an endpoint that carries the
  // fields. Either one missing → today's shared namespace, labeled honestly.
  const scoped = viewer !== null && supportsOwnerScoping(collection);

  const toDocument = (row: Record<string, unknown>): ControlPlaneDocument => {
    const rawOwner = row['owner'];
    const rawVisibility = row['visibility'];
    const kind = String(row['kind']) as DocumentKind;
    return {
      kind,
      name: String(row['name']),
      payload: String(row['payload'] ?? ''),
      owner: typeof rawOwner === 'string' && rawOwner !== '' ? rawOwner : null,
      visibility: rawVisibility === 'private' || rawVisibility === 'shared'
        ? rawVisibility
        : defaultVisibility(kind),
    };
  };

  /**
   * The document for (kind, name) in the viewer's namespace. When scoped, the
   * owner is part of the server-side filter — without it, user B saving a view
   * named the same as user A's would find A's row and try to update it.
   */
  const fetchByName = async (kind: DocumentKind, name: string) => {
    const filters: Record<string, string> =
      scoped && isOwnedKind(kind)
        ? { kind, name, owner: viewer as string }
        : { kind, name };
    const page = await source.listEntities(collection.id, {
      page: 1,
      pageSize: 1,
      filters,
      fresh: true, // read-after-write correctness over the document cache
    });
    return page.rows[0] ?? null;
  };

  /** Every live document of `kind` the viewer may list, deduped by row id. */
  const listRows = async (filters: Record<string, string>) => {
    const rows: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const result = await source.listEntities(collection.id, {
        page,
        pageSize: 100,
        filters,
        fresh: true, // read-after-write correctness over the document cache
      });
      rows.push(...result.rows);
      if (!result.mayHaveMore || page >= 10) break; // 1k docs is plenty for MVP
      page += 1;
    }
    return rows;
  };

  return {
    backend: 'mosaic',
    scoping: scoped ? 'per-user' : 'shared',
    viewer: scoped ? viewer : null,

    async list(kind) {
      if (!scoped || !isOwnedKind(kind)) {
        const rows = await listRows({ kind });
        return rows.map(toDocument).filter(isLiveDocument);
      }
      // Two filtered reads rather than one unfiltered one: the viewer's own
      // documents plus the shared ones. Equality filters are all Mosaic
      // advertises (ADR-0029), so an OR is not available — the union is
      // assembled here and deduped by row id.
      const [own, shared] = await Promise.all([
        listRows({ kind, owner: viewer as string }),
        listRows({ kind, visibility: 'shared' }),
      ]);
      const byId = new Map<string, Record<string, unknown>>();
      for (const row of [...own, ...shared]) byId.set(String(row[idField]), row);
      return [...byId.values()].map(toDocument).filter(isLiveDocument);
    },

    async get(kind, name) {
      const row = await fetchByName(kind, name);
      if (row == null) return null;
      const document = toDocument(row);
      if (!isLiveDocument(document)) return null;
      return canViewerRead(scoped ? viewer : null, document) ? document : null;
    },

    async put(document) {
      const existing = await fetchByName(document.kind, document.name);
      if (existing) {
        const current = toDocument(existing);
        if (scoped && !canViewerWrite(viewer, current)) {
          throw new NotOwnedError(current.kind, current.name, current.owner ?? null);
        }
        // `owner` is never in the update payload — immutable after create.
        await source.updateEntity(collection.id, String(existing[idField]), {
          payload: document.payload,
          ...(scoped && document.visibility ? { visibility: document.visibility } : {}),
        });
        return;
      }
      await source.createEntity(collection.id, {
        kind: document.kind,
        name: document.name,
        payload: document.payload,
        ...(scoped && isOwnedKind(document.kind)
          ? {
              owner: viewer as string,
              visibility: document.visibility ?? defaultVisibility(document.kind),
            }
          : {}),
      });
    },

    async remove(kind, name) {
      // No hard delete on Mosaic (W4.4) — clearing the payload retires the
      // document; readers treat an empty payload as absent. Retirement is an
      // UPDATE, so the owner-only rule above covers deletion for free.
      const existing = await fetchByName(kind, name);
      if (!existing) return;
      const current = toDocument(existing);
      if (scoped && !canViewerWrite(viewer, current)) {
        throw new NotOwnedError(current.kind, current.name, current.owner ?? null);
      }
      await source.updateEntity(collection.id, String(existing[idField]), { payload: '' });
    },

    canWrite(document) {
      return scoped ? canViewerWrite(viewer, document) : true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Local fallback                                                      */
/* ------------------------------------------------------------------ */

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/**
 * Local keys are namespaced per viewer when there is one. A shared clinical
 * workstation is a real deployment shape, and without this the "fallback"
 * would leak one user's views to the next person at the same browser — the
 * exact integrity problem the ownership amendment exists to close. With no
 * viewer the key shape is unchanged, so existing local documents survive.
 *
 * `config` is deployment-scoped and stays un-namespaced (see OWNED_KINDS).
 */
function localPrefix(viewer: string | null, kind: DocumentKind): string {
  return viewer !== null && isOwnedKind(kind)
    ? `aperture:cp:u:${encodeURIComponent(viewer)}:${kind}:`
    : `aperture:cp:${kind}:`;
}

const localKey = (viewer: string | null, kind: DocumentKind, name: string) =>
  `${localPrefix(viewer, kind)}${name}`;

export function createLocalStore(
  storage: StorageLike = window.localStorage,
  viewer: string | null = null,
): ControlPlaneStore {
  return {
    backend: 'local',
    scoping: viewer !== null ? 'per-user' : 'shared',
    viewer,

    async list(kind) {
      const prefix = localPrefix(viewer, kind);
      const documents: ControlPlaneDocument[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key == null || !key.startsWith(prefix)) continue;
        const payload = storage.getItem(key);
        if (payload == null || payload === '') continue;
        documents.push({
          kind,
          name: key.slice(prefix.length),
          payload,
          owner: isOwnedKind(kind) ? viewer : null,
          visibility: defaultVisibility(kind),
        });
      }
      return documents;
    },

    async get(kind, name) {
      const payload = storage.getItem(localKey(viewer, kind, name));
      if (payload == null || payload === '') return null;
      return {
        kind,
        name,
        payload,
        owner: isOwnedKind(kind) ? viewer : null,
        visibility: defaultVisibility(kind),
      };
    },

    async put(document) {
      storage.setItem(localKey(viewer, document.kind, document.name), document.payload);
    },

    async remove(kind, name) {
      storage.removeItem(localKey(viewer, kind, name));
    },

    // Everything this store returns is in the viewer's own namespace.
    canWrite() {
      return true;
    },
  };
}

/** Documents with retired/empty payloads read as absent everywhere. */
export function isLiveDocument(document: { payload: string }): boolean {
  return document.payload !== '';
}
