export type LibraryLoadState = 'pending' | 'loaded' | 'failed';

export function canSaveLibrary(loadState: LibraryLoadState): boolean {
  return loadState === 'loaded';
}
