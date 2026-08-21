import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { diffScene, elementsToPublish } from './scenePublish';
import { createWhiteboardDoc, replaceSharedElements, getElementsFromArray } from './yjsDoc';

/**
 * What one board costs the other end of the connection.
 *
 * These drive two real documents and carry real update payloads between them,
 * so what is measured is what the socket would actually send. Nothing here
 * asserts a duration: a millisecond threshold measures whichever machine is
 * running it, gets widened the first time CI is busy, and then guards nothing.
 * Bytes and message counts are properties of the code.
 */

type Wire = {
  /** Update payloads the host emitted, in order. */
  messages: Uint8Array[];
  bytes: () => number;
};

/** Connect two docs the way the relay does: every local update is forwarded. */
function connect(host: Y.Doc, peer: Y.Doc): Wire {
  const messages: Uint8Array[] = [];
  host.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return;
    messages.push(update);
    Y.applyUpdate(peer, update, 'remote');
  });
  return { messages, bytes: () => messages.reduce((total, m) => total + m.byteLength, 0) };
}

const stroke = (id: string, version: number, points: number) => ({
  id,
  version,
  type: 'freedraw',
  points: Array.from({ length: points }, (_, i) => [i, i * 2]),
});

function seedBoard(size: number) {
  const host = createWhiteboardDoc('perf-host');
  const peer = createWhiteboardDoc('perf-peer');
  const elements = Array.from({ length: size }, (_, i) => stroke(`el-${i}`, 1, 20));
  replaceSharedElements(host.doc, host.elementsArray, elements as any, 'seed');
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(host.doc), 'remote');
  const baseline = new Map(elements.map((e) => [e.id, e.version]));
  return { host, peer, elements, baseline };
}

/** Publish one scene change exactly as ExcalidrawWrapper does. */
function publish(host: ReturnType<typeof createWhiteboardDoc>, baseline: Map<string, number>, scene: any[]) {
  const diff = diffScene(baseline, scene);
  const { elements: payload, wholeScene } = elementsToPublish(scene, diff);
  replaceSharedElements(
    host.doc,
    host.elementsArray,
    payload as any,
    'local',
    wholeScene ? {} : { deleteMissing: false },
  );
  return diff.nextVersions;
}

describe('drawing cost over the connection', () => {
  /*
   * Neither bytes nor change events discriminate here, and it took two failed
   * mutation runs to establish that. Yjs diffs at the CRDT level and
   * replaceSharedElements skips a write whose value is unchanged, so
   * re-publishing the whole scene emits no extra updates and no extra events.
   *
   * The cost it does carry is local: every element gets walked and every key
   * compared before that conclusion is reached, once per pointer sample. So the
   * guard belongs on what is handed to the shared document, which is the
   * decision this module makes.
   */
  it('hands one element to the document per stroke, whatever the board holds', () => {
    const handed = (size: number) => {
      const { elements, baseline } = seedBoard(size);
      const scene = [...elements, stroke('new', 1, 200)];
      const diff = diffScene(baseline, scene);
      return elementsToPublish(scene, diff).elements.length;
    };

    expect(handed(10)).toBe(1);
    expect(handed(400)).toBe(1);
  });

  it('carries the stroke to the peer intact', () => {
    const { host, peer, elements, baseline } = seedBoard(50);
    connect(host.doc, peer.doc);

    publish(host, baseline, [...elements, stroke('new', 1, 300)]);

    const arrived = getElementsFromArray(peer.elementsArray)
      .find((element: any) => element.id === 'new') as any;
    expect(arrived).toBeTruthy();
    expect(arrived.points).toHaveLength(300);
    host.doc.destroy();
    peer.doc.destroy();
  });

  it('sends one message per stroke sample, not one per element on the board', () => {
    const { host, peer, elements, baseline } = seedBoard(300);
    const wire = connect(host.doc, peer.doc);

    let versions = baseline;
    for (let sample = 1; sample <= 5; sample++) {
      versions = publish(host, versions as Map<string, number>, [
        ...elements,
        stroke('new', sample, sample * 40),
      ]);
    }

    expect(wire.messages).toHaveLength(5);
    host.doc.destroy();
    peer.doc.destroy();
  });

  it('grows the payload with the stroke, not with the board', () => {
    const { host, peer, elements, baseline } = seedBoard(200);
    const wire = connect(host.doc, peer.doc);

    publish(host, baseline, [...elements, stroke('short', 1, 10)]);
    const afterShort = wire.bytes();
    publish(host, new Map([...baseline, ['short', 1]]), [
      ...elements,
      stroke('short', 1, 10),
      stroke('long', 1, 400),
    ]);
    const longOnly = wire.bytes() - afterShort;

    expect(longOnly).toBeGreaterThan(afterShort);
    host.doc.destroy();
    peer.doc.destroy();
  });
});

describe('a peer joining an existing board', () => {
  it('catches up in a single state exchange, not one message per element', () => {
    const { host } = seedBoard(400);
    const joiner = createWhiteboardDoc('perf-joiner');

    const state = Y.encodeStateAsUpdate(host.doc);
    Y.applyUpdate(joiner.doc, state, 'remote');

    expect(getElementsFromArray(joiner.elementsArray)).toHaveLength(400);
    host.doc.destroy();
    joiner.doc.destroy();
  });

  it('converges both documents on the same scene', () => {
    const { host, peer, elements, baseline } = seedBoard(30);
    connect(host.doc, peer.doc);

    publish(host, baseline, [...elements, stroke('new', 1, 120)]);

    const hostIds = getElementsFromArray(host.elementsArray).map((e: any) => e.id);
    const peerIds = getElementsFromArray(peer.elementsArray).map((e: any) => e.id);
    expect(peerIds).toEqual(hostIds);
    host.doc.destroy();
    peer.doc.destroy();
  });

  it('sends nothing at all when the scene has not moved', () => {
    const { host, peer, elements, baseline } = seedBoard(100);
    const wire = connect(host.doc, peer.doc);

    const diff = diffScene(baseline, elements);
    if (diff.changedIds.size > 0 || diff.removed) publish(host, baseline, elements);

    expect(wire.messages).toHaveLength(0);
    expect(wire.bytes()).toBe(0);
    host.doc.destroy();
    peer.doc.destroy();
  });
});
