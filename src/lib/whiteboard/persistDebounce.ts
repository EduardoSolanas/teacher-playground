export function roomSceneSaveDebounceMs(): number {
  return process.env.NEXT_PUBLIC_E2E === '1' ? 250 : 3000;
}
