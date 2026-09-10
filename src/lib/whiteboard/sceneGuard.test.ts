import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { sanitizeSceneDoc } from './sceneGuard';

function elementMap(element: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(element)) map.set(key, value);
  return map;
}

function sceneDoc(elements: Array<Record<string, unknown>>): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>('elements').push(elements.map(elementMap));
  });
  return doc;
}

function idsIn(doc: Y.Doc): unknown[] {
  return doc.getArray<Y.Map<unknown>>('elements').toArray().map((map) => map.get('id'));
}

describe('sanitizeSceneDoc (SEC-A02)', () => {
  it('removes every embed element type the scene schema refuses, and counts them', () => {
    const doc = sceneDoc([
      { id: 'iframe-1', type: 'iframe' },
      { id: 'iframe-upper', type: 'IFRAME' },
      { id: 'embeddable-1', type: ' embeddable ' },
      { id: 'magicframe-1', type: 'magicframe' },
      { id: 'rect-1', type: 'rectangle' },
    ]);

    const result = sanitizeSceneDoc(doc);

    expect(result).toEqual({
      changed: true,
      removedBlocked: 4,
      removedLinks: 0,
      removedMalformed: 0,
      removedOverflow: 0,
    });
    expect(idsIn(doc)).toEqual(['rect-1']);
  });

  it('keeps an image element, because board files reach peers over the socket', () => {
    const doc = sceneDoc([
      { id: 'photo-1', type: 'image', fileId: 'a'.repeat(32), status: 'saved' },
    ]);

    const result = sanitizeSceneDoc(doc);

    expect(result).toEqual({
      changed: false,
      removedBlocked: 0,
      removedLinks: 0,
      removedMalformed: 0,
      removedOverflow: 0,
    });
    expect(idsIn(doc)).toEqual(['photo-1']);
  });

  it('removes entries that are not element maps, and counts them', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const elements = doc.getArray<unknown>('elements');
      elements.push(['not-a-map']);
      elements.push([42]);
      elements.push([elementMap({ id: 'rect-1', type: 'rectangle' })]);
    });

    const result = sanitizeSceneDoc(doc);

    expect(result).toEqual({
      changed: true,
      removedBlocked: 0,
      removedLinks: 0,
      removedMalformed: 2,
      removedOverflow: 0,
    });
    expect(idsIn(doc)).toEqual(['rect-1']);
  });

  it('removes an element whose link the schema would refuse and keeps allowlisted ones', () => {
    const doc = sceneDoc([
      { id: 'js-link', type: 'rectangle', link: 'javascript:alert(1)' },
      { id: 'data-link', type: 'rectangle', link: 'data:text/html,<script>' },
      { id: 'http-link', type: 'rectangle', link: 'http://example.com' },
      { id: 'scheme-relative', type: 'rectangle', link: '//evil.example/board' },
      { id: 'non-string', type: 'rectangle', link: 7 },
      { id: 'https-link', type: 'rectangle', link: 'https://example.com/doc' },
      { id: 'relative-link', type: 'rectangle', link: '/assets/handout.pdf' },
      { id: 'null-link', type: 'rectangle', link: null },
    ]);

    const result = sanitizeSceneDoc(doc);

    expect(result).toEqual({
      changed: true,
      removedBlocked: 0,
      removedLinks: 5,
      removedMalformed: 0,
      removedOverflow: 0,
    });
    expect(idsIn(doc)).toEqual(['https-link', 'relative-link', 'null-link']);
  });

  it('trims elements beyond maxElements from the end after the per-element sweep', () => {
    const doc = sceneDoc([
      { id: 'blocked-first', type: 'iframe' },
      { id: 'keep-1', type: 'rectangle' },
      { id: 'keep-2', type: 'rectangle' },
      { id: 'overflow-1', type: 'rectangle' },
      { id: 'overflow-2', type: 'rectangle' },
    ]);

    const result = sanitizeSceneDoc(doc, { maxElements: 2 });

    expect(result).toEqual({
      changed: true,
      removedBlocked: 1,
      removedLinks: 0,
      removedMalformed: 0,
      removedOverflow: 2,
    });
    expect(idsIn(doc)).toEqual(['keep-1', 'keep-2']);
  });

  it('reports no change and leaves the document untouched for a clean scene', () => {
    const doc = sceneDoc([
      { id: 'rect-1', type: 'rectangle', link: 'https://example.com/doc' },
      { id: 'freedraw-1', type: 'freedraw' },
    ]);
    const before = Y.encodeStateAsUpdate(doc);

    const result = sanitizeSceneDoc(doc, { maxElements: 10 });

    expect(result).toEqual({
      changed: false,
      removedBlocked: 0,
      removedLinks: 0,
      removedMalformed: 0,
      removedOverflow: 0,
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});
