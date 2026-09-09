/**
 * Ambient declarations for stylesheet side-effect imports.
 *
 * TypeScript 6 added TS2882: `import './foo.css'` now requires a module declaration,
 * where TS 5 accepted a side-effect import of an untyped path silently. Seven imports
 * in this package are affected (maplibre-gl, @xyflow/react, the two editor themes, the
 * image gallery, the canvas tokens, and the Playwright CT entry).
 *
 * Every consumer of `@arcaai/ui` bundles its own CSS pipeline — Next.js and Vite each
 * ship these declarations (`next-env.d.ts`, `vite/client`), which is why only this
 * package needs its own. The bundlers, not TypeScript, give these imports meaning; the
 * declarations exist so the compiler stops short of them.
 */

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.scss' {
  const content: string;
  export default content;
}
