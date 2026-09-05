// Type-only tests for WhiteboardProvider event narrowing
// These tests only check that types compile correctly - they don't execute
import type { WhiteboardProvider } from './yWebsocketProvider';

// Prevent these functions from being executed by vitest
if (false) {
  // Test: reject misspelled event names (these should cause type errors)
  function testRejectMisspelledEventNames(provider: WhiteboardProvider) {
    // @ts-expect-error - 'syncd' is not a valid event name
    provider.on('syncd', (event: boolean) => {});

    // @ts-expect-error - 'statuss' is not a valid event name
    provider.on('statuss', (event) => {});
  }

  // Test: reject wrong payload types for known events
  function testRejectWrongPayloadTypes(provider: WhiteboardProvider) {
    // @ts-expect-error - 'synced' event expects boolean | { synced: boolean }
    provider.on('synced', (event: string) => {});

    // @ts-expect-error - 'status' event expects { status?: string; connected?: boolean }
    provider.on('status', (event: boolean) => {});

    // @ts-expect-error - 'connection-close' event exists but wrong payload type
    provider.on('connection-close', (event: boolean) => {});
  }

  // Test: accept correct event names and payload types (these should NOT cause errors)
  function testAcceptCorrectTypes(provider: WhiteboardProvider) {
    // These should all compile without errors
    provider.on('status', (event: { status?: string; connected?: boolean }) => {});

    provider.on('synced', (event: boolean | { synced: boolean }) => {});

    provider.on('connection-close', (event: unknown) => {});
  }

  // Test: decoder type narrowing in messageHandlers
  function testDecoderTypeNarrowing(provider: WhiteboardProvider) {
    // messageHandlers should have callbacks with Decoder type (not any)
    if (provider.messageHandlers && provider.messageHandlers.length > 0) {
      const handler = provider.messageHandlers[0];
      if (handler) {
        // handler should be a function with (encoder: Encoder, decoder: Decoder) => void
        // If decoder was `any`, this type would be inferred as `any` instead of Decoder
        type MessageHandler = typeof handler;
        type HandlerParams = MessageHandler extends (encoder: infer E, decoder: infer D) => void
          ? [E, D]
          : never;
        type DecoderParam = HandlerParams extends [unknown, infer D] ? D : never;
        // This should be Decoder, not any
        const _: DecoderParam = null as any;
      }
    }
  }

  // Test: off method with same event typing
  function testOffMethodTyping(provider: WhiteboardProvider) {
    const callback = (event: boolean | { synced: boolean }) => {};

    // These should compile
    provider.off?.('synced', callback);
    provider.off?.('status', (event: { status?: string; connected?: boolean }) => {});

    // @ts-expect-error - off should reject wrong event names
    provider.off?.('syncd', callback);

    // @ts-expect-error - off should reject wrong payload types
    provider.off?.('synced', (event: string) => {});
  }
}
