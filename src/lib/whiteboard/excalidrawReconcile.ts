import { reconcileElements as upstreamReconcileElements } from '@teacher-playground/excalidraw';
import { selectElementsForRemoteReconciliation, uniqueElementsById } from './excalidrawSyncCore';
import type { RemoteReconciliationOptions } from './excalidrawSyncCore';

type ExcalidrawReconcileElements = (
  localElements: readonly Record<string, unknown>[],
  remoteElements: readonly Record<string, unknown>[],
  appState: Record<string, unknown>,
) => readonly Record<string, unknown>[];

/**
 * Applies the public Excalidraw multiplayer reconciliation algorithm after
 * selecting the local elements that are safe to retain during a remote push.
 */
export function reconcileRemoteElements(
  localElements: readonly unknown[],
  remoteElements: readonly unknown[],
  appState: Record<string, unknown>,
  options: RemoteReconciliationOptions,
) {
  const inputs = selectElementsForRemoteReconciliation(localElements, remoteElements, options);
  return uniqueElementsById((upstreamReconcileElements as unknown as ExcalidrawReconcileElements)(
    inputs.localElements,
    inputs.remoteElements,
    appState,
  ));
}
