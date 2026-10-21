import { useSyncExternalStore } from "react";

// Signing in is how a request to delete the account is taken back (#60). The server says so in the sign-in answer, and the person
// has to be told: they may have forgotten they asked, and it is the one place the account's fate changes behind a plain sign-in. A
// store of its own, outside React and outside the auth API's return values, so the sign-in code stays what it was.

let cancelled = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The sign-in just cancelled a request to delete the account. */
export function announceDeletionCancelled(): void {
  cancelled = true;
  emit();
}

export function dismissDeletionCancelled(): void {
  cancelled = false;
  emit();
}

/** True from the sign-in that cancelled a deletion until the person has seen the notice. */
export function useDeletionCancelled(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => cancelled,
    () => false
  );
}
