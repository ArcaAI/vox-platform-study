/**
 * Type-side registration for the `vitest-axe` matchers.
 *
 * The test files already register them at runtime with
 * `expect.extend(axeMatchers)`, but `vitest-axe@0.1.0` only ships an
 * augmentation of the legacy global `Vi` namespace (via
 * `vitest-axe/extend-expect`), which Vitest 4 no longer consults — so
 * `expect(...).toHaveNoViolations()` type-errored in 16 test files despite
 * passing at runtime.
 *
 * `Matchers` on the `vitest` module is Vitest 4's supported extension point;
 * both `Assertion<T>` and `ExpectStatic` inherit from it. Augmenting
 * `@vitest/expect`'s `Assertion` directly does not work here — it is exported
 * through an `export type { ... }` list, so a `declare module` augmentation
 * creates a fresh interface instead of merging with the declaration that
 * `Assertion` actually references.
 *
 * The signature is written out rather than imported from `vitest-axe/matchers`:
 * that subpath's types are re-exported through a chain that does not resolve
 * under `nodenext`, so `import type { AxeMatchers }` yields nothing and an
 * `extends AxeMatchers` clause silently contributes no members.
 */
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any -- `T` is unused here but must be declared to mirror the upstream `Matchers<T>` signature, otherwise the augmentation does not merge.
  interface Matchers<T = any> {
    /** Asserts that an axe-core result set contains no accessibility violations. */
    toHaveNoViolations(): void;
  }
}

export {};
