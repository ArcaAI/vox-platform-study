/**
 * Minimal conditional class joiner. The app deliberately avoids importing
 * `@arcaai/ui`'s internal `cn` (its `./*` export resolves `.tsx` only, and
 * the app never composes conflicting Tailwind utilities that would need
 * tailwind-merge).
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
