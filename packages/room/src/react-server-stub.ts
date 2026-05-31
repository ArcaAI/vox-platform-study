/**
 * @arcaai/room — React Server Components guard
 *
 * Resolved when a downstream consumer imports `@arcaai/room` from a React
 * Server Component. The package depends on the Web Audio API
 * (`AudioContext`, `MediaStream`, `AudioWorkletNode`, `navigator.mediaDevices`)
 * which is unavailable on the server and would otherwise crash with an
 * opaque `ReferenceError: AudioContext is not defined` at runtime.
 *
 * Use the package from a Client Component (a file with `"use client"`).
 *
 * TASK-300 C-XCUT-2.
 */

throw new Error(
  '@arcaai/room cannot be imported from a React Server Component. ' + 'Move usage to a Client Component (add "use client" at the top of the file).',
);

export {};
