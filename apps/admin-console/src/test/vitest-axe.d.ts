/**
 * Type augmentation for the `vitest-axe` matchers.
 *
 * WHY THIS FILE EXISTS: `vitest-axe@0.1.0` ships its augmentation against the
 * LEGACY global `Vi` namespace:
 *
 *     declare global { namespace Vi { interface Assertion<T> extends AxeMatchers {} } }
 *
 * Vitest 4 no longer reads that namespace — it composes assertions from the
 * `Matchers<T>` interface exported by `@vitest/expect` (re-exported from
 * `vitest`), which `Assertion<T>` extends. So the library's own types are
 * silently inert here and every `expect(await axe(el)).toHaveNoViolations()`
 * failed `tsc --noEmit` with TS2339, across ~14 test files, while passing at
 * runtime (the matcher IS registered by `expect.extend`).
 *
 * This re-declares the same matchers against the interface Vitest 4 actually
 * consumes. Delete it if vitest-axe ships Vitest-4-compatible types.
 *
 * The matching runtime registration lives in `src/test/setup.ts` — types and
 * `expect.extend` must stay together or this augmentation would promise a
 * matcher that does not exist.
 */

import type { AxeMatchers } from 'vitest-axe/matchers';

declare module 'vitest' {
    /*
     * The `<T = any>` parameter is load-bearing, not sloppiness: TypeScript
     * refuses to merge declarations whose type parameters differ ("All
     * declarations of 'Matchers' must have identical type parameters"), and
     * Vitest declares `interface Matchers<T = any>`. So `T` must keep that exact
     * name and default even though this body does not reference it — renaming it
     * `_T` or dropping `any` silently breaks the merge and the matcher types
     * disappear again.
     */
    /* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type -- module augmentation: the parameter name, the `any` default and the empty extends-only bodies must mirror vitest's own `Matchers` declaration exactly, or the interfaces stop merging and the axe matcher types vanish (see the note above) */
    interface Matchers<T = any> extends AxeMatchers {}
    interface AsymmetricMatchersContaining extends AxeMatchers {}
    /* eslint-enable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type -- end of the vitest module-augmentation block */
}
