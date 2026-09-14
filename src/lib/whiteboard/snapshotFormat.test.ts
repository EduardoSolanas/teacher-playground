import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import {
  SNAPSHOT_STORED_FORMAT,
  SnapshotDecodeError,
  SnapshotFormatUnknownError,
  applyStoredSnapshot,
  snapshotFormatKey,
} from './snapshotFormat';

function boardWithOneElement(): Y.Doc {
  const doc = new Y.Doc();
  const map = new Y.Map<unknown>();
  map.set('id', 'e1');
  doc.getArray<Y.Map<unknown>>('elements').push([map]);
  return doc;
}

describe('snapshotFormatKey', () => {
  it('names the per-room format key', () => {
    expect(snapshotFormatKey('room-a')).toBe('ydoc-format:room-a');
  });

  it('is distinct per room', () => {
    expect(snapshotFormatKey('room-a')).not.toBe(snapshotFormatKey('room-b'));
  });
});

describe('SNAPSHOT_STORED_FORMAT', () => {
  it('is 2: this build writes only V2', () => {
    expect(SNAPSHOT_STORED_FORMAT).toBe(2);
  });
});

describe('applyStoredSnapshot', () => {
  it('applies V1 bytes to the target document when the format is undefined (legacy)', () => {
    const source = boardWithOneElement();
    const bytes = Y.encodeStateAsUpdate(source);

    const target = new Y.Doc();
    applyStoredSnapshot(target, bytes, undefined);

    expect(target.getArray('elements').length).toBe(1);
  });

  it('applies V1 bytes to the target document when the format is 1', () => {
    const source = boardWithOneElement();
    const bytes = Y.encodeStateAsUpdate(source);

    const target = new Y.Doc();
    applyStoredSnapshot(target, bytes, 1);

    expect(target.getArray('elements').length).toBe(1);
  });

  it('applies V2 bytes to the target document when the format is 2', () => {
    const source = boardWithOneElement();
    const bytes = Y.encodeStateAsUpdateV2(source);

    const target = new Y.Doc();
    applyStoredSnapshot(target, bytes, 2);

    expect(target.getArray('elements').length).toBe(1);
  });

  it('throws SnapshotFormatUnknownError naming the format for a value this build does not know', () => {
    const source = boardWithOneElement();
    const bytes = Y.encodeStateAsUpdate(source);

    const target = new Y.Doc();
    expect(() => applyStoredSnapshot(target, bytes, 3)).toThrow(SnapshotFormatUnknownError);
    try {
      applyStoredSnapshot(target, bytes, 3);
      expect.unreachable('expected applyStoredSnapshot to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotFormatUnknownError);
      expect((error as Error).name).toBe('SnapshotFormatUnknownError');
      expect((error as Error).message).toBe('Unknown snapshot format: 3');
      expect((error as SnapshotFormatUnknownError).format).toBe(3);
    }
  });

  it('throws SnapshotDecodeError with a stable message and cause when V1 bytes fail to decode', () => {
    const target = new Y.Doc();
    const garbage = new Uint8Array([255, 255, 255, 255, 255]);
    try {
      applyStoredSnapshot(target, garbage, 1);
      expect.unreachable('expected applyStoredSnapshot to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotDecodeError);
      expect((error as Error).name).toBe('SnapshotDecodeError');
      expect((error as Error).message).toBe('Failed to decode stored snapshot bytes');
      expect((error as Error).cause).toBeDefined();
    }
  });

  it('throws SnapshotDecodeError when V2 bytes fail to decode', () => {
    const target = new Y.Doc();
    const garbage = new Uint8Array([255, 255, 255, 255, 255]);
    expect(() => applyStoredSnapshot(target, garbage, 2)).toThrow(SnapshotDecodeError);
  });

  it('throws SnapshotDecodeError when V1 bytes are fed as V2 (cross-format corruption)', () => {
    const source = boardWithOneElement();
    const bytes = Y.encodeStateAsUpdate(source);
    const target = new Y.Doc();
    expect(() => applyStoredSnapshot(target, bytes, 2)).toThrow(SnapshotDecodeError);
  });
});
