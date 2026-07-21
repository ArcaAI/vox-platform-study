/**
 * @arcaai/vad — React Server Components guard
 *
 * Resolved when a downstream consumer imports `@arcaai/vad` from a React
 * Server Component. The package depends on browser-only APIs
 * (`AudioContext`, `AudioWorkletNode`, `MediaStreamTrack`,
 * `SharedArrayBuffer`, ONNX Runtime Web) which are unavailable on the
 * server and would otherwise crash with an opaque `ReferenceError`.
 *
 * Use the package from a Client Component (a file with `"use client"`).
 */

throw new Error(
  '@arcaai/vad cannot be imported from a React Server Component. ' + 'Move usage to a Client Component (add "use client" at the top of the file).',
);

export {};
