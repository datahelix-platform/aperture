/**
 * Slot enrichment: the per-field metadata `__schema` does not carry.
 *
 * Verified against a live Mosaic while building this: `__schema` returns a description on
 * each TYPE and `null` on every FIELD, so the prose a curator wrote about a slot is only
 * reachable through `mosaicSchema`. These tests pin the join and, more importantly, pin
 * that an endpoint without `mosaicSchema` is completely unaffected.
 */
import { describe, it, expect } from 'vitest';
import { indexSlotEnrichment } from './introspection';
import type { SlotEnrichmentData } from './introspection';
import { deriveCollections } from './schemaModel';
import { capableSchema } from './testing/fixtures';
import realIntrospection from './testing/realIntrospection.json';
import type { IntrospectionSchema } from './introspection';

const ENRICHMENT: SlotEnrichmentData = {
  mosaicSchema: [
    {
      name: 'Book',
      accessorName: 'books',
      description: 'A published work.',
      fields: [
        {
          name: 'in_print',
          kind: 'scalar',
          range: 'boolean',
          role: 'user',
          required: true,
          multivalued: false,
          identifier: false,
          description: 'Whether the book is currently being printed.',
          targetEntityType: null,
          enumName: null,
          enumValues: [],
        },
      ],
    },
  ],
};

describe('indexSlotEnrichment', () => {
  it('indexes by entity type, then slot name', () => {
    const index = indexSlotEnrichment(ENRICHMENT)!;
    expect(index.get('Book')?.get('in_print')?.range).toBe('boolean');
  });

  it('is undefined when the endpoint advertises nothing', () => {
    expect(indexSlotEnrichment(undefined)).toBeUndefined();
    expect(indexSlotEnrichment(null)).toBeUndefined();
  });
});

describe('deriveCollections with enrichment', () => {
  it('joins a slot onto its column', () => {
    const collections = deriveCollections(capableSchema(), indexSlotEnrichment(ENRICHMENT));
    const book = collections.find((c) => c.typeName === 'Book')!;
    const col = book.detailColumns.find((c) => c.field === 'in_print');
    expect(col?.slot).toBe('in_print');
    expect(col?.description).toMatch(/currently being printed/);
    expect(col?.range).toBe('boolean');
    expect(col?.required).toBe(true);
  });

  it('joins across the camelCase/snake_case boundary', () => {
    // The case that matters against a real endpoint: `ColumnModel.field` is the GraphQL
    // field (`isAvailable`), mosaicSchema speaks LinkML (`is_available`). Joining on field
    // name alone would silently miss every compound name — verified live, where every
    // Donor field arrives camelCased and every slot snake_cased.
    const enriched = indexSlotEnrichment({
      mosaicSchema: [
        {
          name: 'Book',
          accessorName: 'books',
          description: null,
          fields: [
            {
              name: 'is_available',
              kind: 'scalar',
              range: 'boolean',
              role: 'system',
              required: true,
              multivalued: false,
              identifier: false,
              description: 'Whether this record is current.',
              targetEntityType: null,
              enumName: null,
              enumValues: [],
            },
          ],
        },
      ],
    });
    const collections = deriveCollections(capableSchema({ bookLifecycle: true }), enriched);
    const book = collections.find((c) => c.typeName === 'Book')!;
    const col = book.detailColumns.find((c) => c.field === 'isAvailable');
    expect(col?.slot).toBe('is_available');
    expect(col?.description).toMatch(/record is current/);
  });

  it('leaves every column untouched when there is no enrichment', () => {
    // The whole point of ADR-0029 degradation: an endpoint without mosaicSchema must take
    // the same code path it always did.
    const plain = deriveCollections(capableSchema());
    const book = plain.find((c) => c.typeName === 'Book')!;
    expect(book.detailColumns.every((c) => c.description === undefined)).toBe(true);
    expect(book.detailColumns.every((c) => c.slot === undefined)).toBe(true);
  });

  it('leaves a column alone when the enrichment has no matching slot', () => {
    const collections = deriveCollections(capableSchema(), indexSlotEnrichment(ENRICHMENT));
    const book = collections.find((c) => c.typeName === 'Book')!;
    const untouched = book.detailColumns.find((c) => c.field === 'title');
    expect(untouched).toBeDefined();
    expect(untouched?.description).toBeUndefined();
  });

  it('carries the entity description without any enrichment query', () => {
    // This one __schema DOES return; derivation simply discarded it until now. Proved
    // against the captured real endpoint, whose types carry substantive descriptions —
    // the synthetic fixture has none.
    const collections = deriveCollections(realIntrospection as unknown as IntrospectionSchema);
    const described = collections.filter((c) => c.description);
    expect(described.length).toBeGreaterThan(0);
    expect(described[0]!.description).toBeTruthy();
  });
});
