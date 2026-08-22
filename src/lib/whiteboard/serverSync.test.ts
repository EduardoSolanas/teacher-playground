import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { MESSAGE_SYNC, handleSyncFrame } from './serverSync';
import { encodePresenceMessage } from './presenceMessage';

describe('serverSync', () => {
  describe('handleSyncFrame', () => {
    it('a client sync step 1 against a server doc with content returns a step 2 reply that brings content across', () => {
      // Setup: server doc with content
      const serverDoc = new Y.Doc();
      const serverArray = serverDoc.getArray('test');
      serverArray.push([{ id: '1', title: 'hello' }]);

      // Client creates a state vector (sync step 1)
      const clientDoc = new Y.Doc();
      const clientStateVector = Y.encodeStateVector(clientDoc);

      // Build the client sync step 1 message
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      encoding.writeVarUint(encoder, 0); // sync step 1 = 0
      encoding.writeVarUint8Array(encoder, clientStateVector);
      const clientSyncStep1 = encoding.toUint8Array(encoder);

      // Handle the frame on server
      const replies = handleSyncFrame(serverDoc, clientSyncStep1);

      // We should get replies
      expect(replies.length).toBeGreaterThan(0);

      // Apply the step 2 reply to the client doc using sync protocol
      const step2Reply = replies[0];
      const replyDecoder = decoding.createDecoder(step2Reply);
      const replyMsgType = decoding.readVarUint(replyDecoder);
      expect(replyMsgType).toBe(MESSAGE_SYNC);

      // Apply the sync message to the client doc
      syncProtocol.readSyncMessage(replyDecoder, encoding.createEncoder(), clientDoc, undefined);

      // Client doc should now have the content from server
      const clientArray = clientDoc.getArray('test');
      expect(clientArray.length).toBe(1);
      const item = clientArray.get(0);
      expect(item).toEqual({ id: '1', title: 'hello' });
    });

    it('a sync step 2 / update frame is applied to the server doc', () => {
      const serverDoc = new Y.Doc();
      const clientDoc = new Y.Doc();

      // Client adds content
      const clientArray = clientDoc.getArray('items');
      clientArray.push([{ name: 'item1' }]);

      // Create a sync step 2 frame
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const update = Y.encodeStateAsUpdate(clientDoc);
      syncProtocol.writeUpdate(encoder, update);
      const step2Frame = encoding.toUint8Array(encoder);

      // Handle it on server
      const replies = handleSyncFrame(serverDoc, step2Frame);

      // Server doc should have the content
      const serverArray = serverDoc.getArray('items');
      expect(serverArray.length).toBe(1);
      const item = serverArray.get(0);
      expect(item).toEqual({ name: 'item1' });
    });

    it('a step 1 also yields the server own step 1, so the sender answers with what the server lacks', () => {
      const serverDoc = new Y.Doc();
      serverDoc.getArray('data').push([{ x: 42 }]);

      const clientDoc = new Y.Doc();
      clientDoc.getArray('data').push([{ y: 7 }]);

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, clientDoc);

      const replies = handleSyncFrame(serverDoc, encoding.toUint8Array(encoder));
      expect(replies.length).toBe(2);

      // The second frame is the server's own step 1. Answering it must carry
      // the client's element back, which is how the server learns a board.
      const serverStepOne = replies[1];
      const decoder = decoding.createDecoder(serverStepOne);
      expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
      const answerEncoder = encoding.createEncoder();
      encoding.writeVarUint(answerEncoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, answerEncoder, clientDoc, undefined);

      const answerDecoder = decoding.createDecoder(encoding.toUint8Array(answerEncoder));
      decoding.readVarUint(answerDecoder);
      syncProtocol.readSyncMessage(answerDecoder, encoding.createEncoder(), serverDoc, undefined);
      expect(serverDoc.getArray('data').toArray()).toContainEqual({ y: 7 });
    });

    it('a non-sync frame (awareness type 1) returns []', () => {
      const serverDoc = new Y.Doc();

      // Create an awareness frame (type 1)
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarString(encoder, JSON.stringify({ clientID: 123 }));
      const awarenessFrame = encoding.toUint8Array(encoder);

      const replies = handleSyncFrame(serverDoc, awarenessFrame);

      expect(replies).toEqual([]);
    });

    it('a presence type 100 frame returns []', () => {
      const serverDoc = new Y.Doc();

      // Create a presence message frame
      const presenceFrame = encodePresenceMessage({ peerId: 'test-peer' });

      const replies = handleSyncFrame(serverDoc, presenceFrame);

      expect(replies).toEqual([]);
    });

    it('random/truncated bytes return [] and do not throw', () => {
      const serverDoc = new Y.Doc();

      // Truncated varint
      const truncated1 = new Uint8Array([0xff, 0xff, 0xff]);

      expect(() => {
        const replies = handleSyncFrame(serverDoc, truncated1);
        expect(replies).toEqual([]);
      }).not.toThrow();

      // Random bytes
      const random = new Uint8Array([99, 88, 77, 66]);

      expect(() => {
        const replies = handleSyncFrame(serverDoc, random);
        expect(replies).toEqual([]);
      }).not.toThrow();
    });

    it('applies the update under the origin it was given', () => {
      const serverDoc = new Y.Doc();
      const clientDoc = new Y.Doc();
      clientDoc.getArray('items').push([{ id: 'test' }]);

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(clientDoc));

      const socket = { name: 'the sending socket' };
      const origins: unknown[] = [];
      serverDoc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

      handleSyncFrame(serverDoc, encoding.toUint8Array(encoder), socket);

      expect(origins).toEqual([socket]);
    });

  });
});
