import { connectMosaicSource } from '../data/mosaicSource';
import { capableSchema, fakeClient, realIntrospection } from '../data/testing/fixtures';
import {
  NotOwnedError,
  canViewerRead,
  canViewerWrite,
  createMosaicStore,
  createLocalStore,
  defaultVisibility,
  findDocumentCollection,
  isLiveDocument,
  openPayload,
  sealPayload,
  supportsOwnerScoping,
} from './store';

/** An in-memory Hippo document backend behind the fake client. */
function documentBackend() {
  const docs: { id: string; kind: string; name: string; payload: string }[] = [];
  const client = fakeClient(capableSchema({ documents: true }), (query, variables) => {
    if (query.includes('apertureDocuments')) {
      const filter = (variables['filter'] ?? {}) as Record<string, string>;
      const limit = (variables['limit'] as number) ?? 100;
      const offset = (variables['offset'] as number) ?? 0;
      const matching = docs.filter(
        (d) =>
          (filter['kind'] == null || d.kind === filter['kind']) &&
          (filter['name'] == null || d.name === filter['name']),
      );
      return { data: { apertureDocuments: matching.slice(offset, offset + limit) }, error: null };
    }
    if (query.includes('createApertureDocument')) {
      const input = variables['input'] as Record<string, string>;
      const doc = { id: `DOC-${docs.length + 1}`, ...input } as (typeof docs)[number];
      docs.push(doc);
      return { data: { createApertureDocument: doc }, error: null };
    }
    if (query.includes('updateApertureDocument')) {
      const doc = docs.find((d) => d.id === variables['id']);
      if (doc) Object.assign(doc, variables['input']);
      return { data: { updateApertureDocument: doc ?? null }, error: null };
    }
    return { data: { books: [], authors: [] }, error: null };
  });
  return { client, docs };
}

describe('payload envelopes (versioned + validated — ADR-0003/0004)', () => {
  it('seals and opens with version + structural validation', () => {
    const payload = sealPayload(1, { a: 1 });
    const isObj = (d: unknown): d is { a: number } =>
      typeof d === 'object' && d != null && typeof (d as { a?: unknown }).a === 'number';
    expect(openPayload(payload, 1, isObj)).toEqual({ a: 1 });
    expect(openPayload(payload, 2, isObj)).toBeNull(); // version mismatch
    expect(openPayload('{"v":1,"data":{"a":"x"}}', 1, isObj)).toBeNull(); // invalid shape
    expect(openPayload('not-json', 1, isObj)).toBeNull();
  });
});

describe('findDocumentCollection (structural recognition)', () => {
  it('finds the document collection when the schema advertises one', async () => {
    const source = await connectMosaicSource(fakeClient(capableSchema({ documents: true })));
    expect(findDocumentCollection(source)?.id).toBe('apertureDocuments');
  });

  it('is absent otherwise — the store falls back honestly', async () => {
    const source = await connectMosaicSource(fakeClient(capableSchema()));
    expect(findDocumentCollection(source)).toBeUndefined();
  });
});

describe('MosaicControlPlaneStore (LinkML-on-Mosaic reference impl)', () => {
  it('puts (create then update on collision), gets, lists, and retires documents', async () => {
    const { client, docs } = documentBackend();
    const source = await connectMosaicSource(client);
    const store = createMosaicStore(source, findDocumentCollection(source)!);
    expect(store.backend).toBe('mosaic');

    await store.put({ kind: 'savedView', name: 'my view', payload: sealPayload(1, { x: 1 }) });
    expect(docs).toHaveLength(1);

    // Same (kind, name) → update, not a duplicate.
    await store.put({ kind: 'savedView', name: 'my view', payload: sealPayload(1, { x: 2 }) });
    expect(docs).toHaveLength(1);
    expect((await store.get('savedView', 'my view'))?.payload).toBe(sealPayload(1, { x: 2 }));

    await store.put({ kind: 'workflowDraft', name: 'wf', payload: sealPayload(1, {}) });
    expect(await store.list('savedView')).toHaveLength(1);

    // No hard delete (W4.4): remove retires by clearing the payload.
    await store.remove('savedView', 'my view');
    expect(docs).toHaveLength(2); // still there…
    const retired = docs.find((d) => d.kind === 'savedView')!;
    expect(retired.payload).toBe('');
    expect(isLiveDocument(retired)).toBe(false);
  });
});

/**
 * The same backend against the live Hippo shapes (#15): an
 * `{ items total }` page envelope and the generic `[{field, value}]` filter
 * list instead of a per-type filter input.
 */
function envelopeDocumentBackend() {
  const docs: { id: string; kind: string; name: string; payload: string }[] = [];
  const client = fakeClient(realIntrospection, (query, variables) => {
    if (query.includes('apertureDocuments')) {
      const filters = (variables['filters'] ?? []) as { field: string; value: string }[];
      const limit = (variables['limit'] as number) ?? 50;
      const offset = (variables['offset'] as number) ?? 0;
      const matching = docs.filter((d) =>
        filters.every((f) => d[f.field as 'kind' | 'name'] === f.value),
      );
      return {
        data: {
          apertureDocuments: {
            items: matching.slice(offset, offset + limit),
            total: matching.length,
          },
        },
        error: null,
      };
    }
    if (query.includes('createApertureDocument')) {
      const input = variables['input'] as Record<string, string>;
      const doc = { id: `DOC-${docs.length + 1}`, ...input } as (typeof docs)[number];
      docs.push(doc);
      return { data: { createApertureDocument: doc }, error: null };
    }
    if (query.includes('updateApertureDocument')) {
      const doc = docs.find((d) => d.id === variables['id']);
      if (doc) Object.assign(doc, variables['input']);
      return { data: { updateApertureDocument: doc ?? null }, error: null };
    }
    return { data: {}, error: null };
  });
  return { client, docs };
}

describe('MosaicControlPlaneStore (live Hippo shapes — #15)', () => {
  it('recognizes the envelope-derived document collection structurally', async () => {
    const source = await connectMosaicSource(fakeClient(realIntrospection));
    const collection = findDocumentCollection(source);
    expect(collection?.id).toBe('apertureDocuments');
    expect(collection?.pageShape).toBe('envelope');
  });

  it('round-trips documents through envelope pages and the filter list', async () => {
    const { client, docs } = envelopeDocumentBackend();
    const source = await connectMosaicSource(client);
    const store = createMosaicStore(source, findDocumentCollection(source)!);

    await store.put({ kind: 'savedView', name: 'my view', payload: sealPayload(1, { x: 1 }) });
    await store.put({ kind: 'savedView', name: 'my view', payload: sealPayload(1, { x: 2 }) });
    expect(docs).toHaveLength(1); // same (kind, name) → update, not a duplicate
    expect((await store.get('savedView', 'my view'))?.payload).toBe(sealPayload(1, { x: 2 }));
    expect(await store.list('savedView')).toHaveLength(1);

    await store.remove('savedView', 'my view');
    expect(docs[0].payload).toBe('');
    expect(await store.get('savedView', 'my view')).toBeNull();

    // The (kind, name) lookup travels as the generic AND-combined filter list.
    const lookup = client.recorded.find((r) =>
      Array.isArray(r.variables['filters']) && (r.variables['filters'] as unknown[]).length === 2,
    );
    expect(lookup?.variables['filters']).toEqual([
      { field: 'kind', value: 'savedView' },
      { field: 'name', value: 'my view' },
    ]);
    expect(lookup?.variables['filterMode']).toBe('AND');
  });
});

describe('LocalControlPlaneStore (fallback)', () => {
  it('round-trips documents in localStorage', async () => {
    window.localStorage.clear();
    const store = createLocalStore();
    expect(store.backend).toBe('local');
    await store.put({ kind: 'savedView', name: 'v1', payload: sealPayload(1, { q: 'x' }) });
    await store.put({ kind: 'config', name: 'workflows', payload: sealPayload(1, []) });
    expect(await store.list('savedView')).toHaveLength(1);
    expect((await store.get('savedView', 'v1'))?.payload).toBe(sealPayload(1, { q: 'x' }));
    await store.remove('savedView', 'v1');
    expect(await store.get('savedView', 'v1')).toBeNull();
  });
});


/* ------------------------------------------------------------------ */
/* Ownership (ADR-0032 ownership amendment)                            */
/* ------------------------------------------------------------------ */

interface OwnedRow {
  id: string;
  kind: string;
  name: string;
  payload: string;
  owner?: string;
  visibility?: string;
}

/** The 1.1.0 document backend: filters on owner/visibility as well. */
function ownedBackend() {
  const docs: OwnedRow[] = [];
  const client = fakeClient(
    capableSchema({ documents: true, documentOwnership: true }),
    (query, variables) => {
      if (query.includes('apertureDocuments')) {
        const filter = (variables['filter'] ?? {}) as Record<string, string>;
        const limit = (variables['limit'] as number) ?? 100;
        const offset = (variables['offset'] as number) ?? 0;
        const matching = docs.filter((d) =>
          (['kind', 'name', 'owner', 'visibility'] as const).every(
            (f) => filter[f] == null || String(d[f] ?? '') === filter[f],
          ),
        );
        return { data: { apertureDocuments: matching.slice(offset, offset + limit) }, error: null };
      }
      if (query.includes('createApertureDocument')) {
        const input = variables['input'] as Record<string, string>;
        const doc = { id: `DOC-${docs.length + 1}`, ...input } as OwnedRow;
        docs.push(doc);
        return { data: { createApertureDocument: doc }, error: null };
      }
      if (query.includes('updateApertureDocument')) {
        const doc = docs.find((d) => d.id === variables['id']);
        if (doc) Object.assign(doc, variables['input']);
        return { data: { updateApertureDocument: doc ?? null }, error: null };
      }
      return { data: { books: [], authors: [] }, error: null };
    },
  );
  return { client, docs };
}

const ownedStore = async (viewer: string | null) => {
  const { client, docs } = ownedBackend();
  const source = await connectMosaicSource(client);
  const collection = findDocumentCollection(source)!;
  return { store: createMosaicStore(source, collection, viewer), docs, source, collection };
};

describe('the write rule (canViewerWrite / canViewerRead)', () => {
  it('unowned documents stay writable by everyone — pre-amendment behavior', () => {
    expect(canViewerWrite('alice', { kind: 'savedView', owner: null })).toBe(true);
    expect(canViewerWrite(null, { kind: 'savedView', owner: null })).toBe(true);
  });

  it('owned documents are writable only by their owner', () => {
    expect(canViewerWrite('alice', { kind: 'savedView', owner: 'alice' })).toBe(true);
    expect(canViewerWrite('bob', { kind: 'savedView', owner: 'alice' })).toBe(false);
    expect(canViewerWrite(null, { kind: 'savedView', owner: 'alice' })).toBe(false);
  });

  it('config is never owner-stamped — deployment state, not user state', () => {
    expect(canViewerWrite('bob', { kind: 'config', owner: 'alice' })).toBe(true);
    expect(defaultVisibility('config')).toBe('shared');
  });

  it('shared documents are readable by all; private ones only by their owner', () => {
    const other = { kind: 'savedView' as const, owner: 'alice' };
    expect(canViewerRead('bob', { ...other, visibility: 'shared' })).toBe(true);
    expect(canViewerRead('bob', { ...other, visibility: 'private' })).toBe(false);
    expect(canViewerRead('alice', { ...other, visibility: 'private' })).toBe(true);
    // Saved views default to shared; drafts default to private.
    expect(canViewerRead('bob', { kind: 'savedView', owner: 'alice' })).toBe(true);
    expect(canViewerRead('bob', { kind: 'workflowDraft', owner: 'alice' })).toBe(false);
  });
});

describe('supportsOwnerScoping (structural, optional — ADR-0029)', () => {
  it('is true only when the endpoint carries filterable owner + visibility', async () => {
    const scoped = await connectMosaicSource(
      fakeClient(capableSchema({ documents: true, documentOwnership: true })),
    );
    expect(supportsOwnerScoping(findDocumentCollection(scoped)!)).toBe(true);

    const legacy = await connectMosaicSource(fakeClient(capableSchema({ documents: true })));
    // The 1.0.0 recipe shape is still recognized as a document store …
    expect(findDocumentCollection(legacy)).toBeDefined();
    // … it just does not support per-user scoping.
    expect(supportsOwnerScoping(findDocumentCollection(legacy)!)).toBe(false);
  });
});

describe('MosaicControlPlaneStore — per-user scoping', () => {
  it('reports shared scoping without a viewer, per-user with one', async () => {
    expect((await ownedStore(null)).store.scoping).toBe('shared');
    const alice = await ownedStore('alice');
    expect(alice.store.scoping).toBe('per-user');
    expect(alice.store.viewer).toBe('alice');
  });

  it('stays shared on a 1.0.0 endpoint even with a viewer — degrades honestly', async () => {
    const source = await connectMosaicSource(fakeClient(capableSchema({ documents: true })));
    const store = createMosaicStore(source, findDocumentCollection(source)!, 'alice');
    expect(store.scoping).toBe('shared');
    expect(store.viewer).toBeNull();
  });

  it('stamps the owner on create and never on update', async () => {
    const { store, docs } = await ownedStore('alice');
    await store.put({ kind: 'savedView', name: 'cohort', payload: sealPayload(1, { x: 1 }) });
    expect(docs[0].owner).toBe('alice');
    expect(docs[0].visibility).toBe('shared'); // savedView default

    await store.put({ kind: 'savedView', name: 'cohort', payload: sealPayload(1, { x: 2 }) });
    expect(docs).toHaveLength(1); // update, not a duplicate
    expect(docs[0].owner).toBe('alice'); // immutable
  });

  it('drafts default to private', async () => {
    const { store, docs } = await ownedStore('alice');
    await store.put({ kind: 'workflowDraft', name: 'wf', payload: sealPayload(1, {}) });
    expect(docs[0].visibility).toBe('private');
  });

  it('does NOT stamp config — it is deployment state', async () => {
    const { store, docs } = await ownedStore('alice');
    await store.put({ kind: 'config', name: 'workflows', payload: sealPayload(1, {}) });
    expect(docs[0].owner).toBeUndefined();
  });

  it('two viewers hold same-named views without collision (the core bug)', async () => {
    const { client, docs } = ownedBackend();
    const source = await connectMosaicSource(client);
    const collection = findDocumentCollection(source)!;
    const alice = createMosaicStore(source, collection, 'alice');
    const bob = createMosaicStore(source, collection, 'bob');

    await alice.put({ kind: 'savedView', name: 'PTSD cohort v2', payload: sealPayload(1, { a: 1 }) });
    await bob.put({ kind: 'savedView', name: 'PTSD cohort v2', payload: sealPayload(1, { b: 1 }) });

    // Two distinct documents — before the amendment the second overwrote the first.
    expect(docs).toHaveLength(2);
    expect((await alice.get('savedView', 'PTSD cohort v2'))?.payload).toBe(sealPayload(1, { a: 1 }));
    expect((await bob.get('savedView', 'PTSD cohort v2'))?.payload).toBe(sealPayload(1, { b: 1 }));
  });

  it('refuses to write or retire a view owned by someone else', async () => {
    const { client, docs } = ownedBackend();
    const source = await connectMosaicSource(client);
    const collection = findDocumentCollection(source)!;
    const alice = createMosaicStore(source, collection, 'alice');
    await alice.put({ kind: 'savedView', name: 'shared one', payload: sealPayload(1, { a: 1 }) });

    // Bob sees it (shared) but cannot write it.
    const bob = createMosaicStore(source, collection, 'bob');
    const seen = await bob.list('savedView');
    expect(seen.map((d) => d.name)).toEqual(['shared one']);
    expect(bob.canWrite(seen[0])).toBe(false);
    expect(alice.canWrite(seen[0])).toBe(true);

    // Bob writing the same name forks rather than overwrites …
    await bob.put({ kind: 'savedView', name: 'shared one', payload: sealPayload(1, { b: 1 }) });
    expect(docs).toHaveLength(2);
    expect(docs[0].payload).toBe(sealPayload(1, { a: 1 })); // Alice's is untouched

    // … and retiring Alice's document directly is refused. Retirement is an
    // update, so the owner-only rule covers deletion for free.
    const alicesDoc = docs[0];
    await expect(
      createMosaicStore(source, collection, 'carol').remove('savedView', 'shared one'),
    ).resolves.toBeUndefined(); // carol owns nothing by that name — a no-op, not a throw
    expect(alicesDoc.payload).toBe(sealPayload(1, { a: 1 }));
  });

  it('guards against an endpoint that advertises the owner filter but ignores it', async () => {
    // Defense in depth, and the only path that reaches NotOwnedError: when the
    // owner-scoped lookup works, a cross-owner write forks instead of
    // colliding, so the guard never fires. It exists for the endpoint that
    // mis-implements the filter — without it, that endpoint silently
    // overwrites another user's document.
    const docs: OwnedRow[] = [
      { id: 'DOC-1', kind: 'savedView', name: 'v', payload: sealPayload(1, { a: 1 }), owner: 'alice', visibility: 'shared' },
    ];
    const client = fakeClient(
      capableSchema({ documents: true, documentOwnership: true }),
      (query, variables) => {
        if (query.includes('apertureDocuments')) return { data: { apertureDocuments: docs }, error: null };
        if (query.includes('updateApertureDocument')) {
          const doc = docs.find((d) => d.id === variables['id']);
          if (doc) Object.assign(doc, variables['input']);
          return { data: { updateApertureDocument: doc ?? null }, error: null };
        }
        return { data: { books: [], authors: [] }, error: null };
      },
    );
    const source = await connectMosaicSource(client);
    const bob = createMosaicStore(source, findDocumentCollection(source)!, 'bob');

    await expect(
      bob.put({ kind: 'savedView', name: 'v', payload: sealPayload(1, { b: 1 }) }),
    ).rejects.toBeInstanceOf(NotOwnedError);
    await expect(bob.remove('savedView', 'v')).rejects.toThrow(/editable only by their owner/);
    expect(docs[0].payload).toBe(sealPayload(1, { a: 1 })); // untouched
  });

  it('lists the viewer own private drafts and no one else\'s', async () => {
    const { client } = ownedBackend();
    const source = await connectMosaicSource(client);
    const collection = findDocumentCollection(source)!;
    const alice = createMosaicStore(source, collection, 'alice');
    const bob = createMosaicStore(source, collection, 'bob');

    await alice.put({ kind: 'workflowDraft', name: 'ingest', payload: sealPayload(1, { a: 1 }) });
    expect((await alice.list('workflowDraft')).map((d) => d.name)).toEqual(['ingest']);
    // Bob's resume list stays clean — the data-integrity half of the amendment.
    expect(await bob.list('workflowDraft')).toEqual([]);
  });
});

describe('LocalControlPlaneStore — per-viewer namespacing', () => {
  it('separates viewers on a shared workstation', async () => {
    window.localStorage.clear();
    const alice = createLocalStore(window.localStorage, 'alice');
    const bob = createLocalStore(window.localStorage, 'bob');
    expect(alice.scoping).toBe('per-user');

    await alice.put({ kind: 'savedView', name: 'v', payload: sealPayload(1, { a: 1 }) });
    await bob.put({ kind: 'savedView', name: 'v', payload: sealPayload(1, { b: 1 }) });

    expect((await alice.get('savedView', 'v'))?.payload).toBe(sealPayload(1, { a: 1 }));
    expect((await bob.get('savedView', 'v'))?.payload).toBe(sealPayload(1, { b: 1 }));
    expect(await alice.list('savedView')).toHaveLength(1);
  });

  it('keeps the pre-amendment key shape when there is no viewer', async () => {
    window.localStorage.clear();
    const store = createLocalStore(window.localStorage, null);
    expect(store.scoping).toBe('shared');
    await store.put({ kind: 'savedView', name: 'v', payload: sealPayload(1, {}) });
    expect(window.localStorage.getItem('aperture:cp:savedView:v')).toBe(sealPayload(1, {}));
  });
});
