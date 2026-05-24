/**
 * @arcaai/stt — React Server Components guard
 *
 * Resolved when a downstream consumer imports `@arcaai/stt` from a React
 * Server Component. The package depends on browser-only APIs (Web Workers,
 * `WebSocket` against the user agent, `AudioContext`, ONNX Runtime Web /
 * Transformers.js) which are unavailable on the server and would
 * otherwise crash with an opaque `ReferenceError`.
 *
 * Use the package from a Client Component (a file with `"use client"`).
 *
 * TASK-300 C-XCUT-2.
 */

throw new Error(
  '@arcaai/stt cannot be imported from a React Server Component. ' +
    'Move usage to a Client Component (add "use client" at the top of the file).',
);

export {};
