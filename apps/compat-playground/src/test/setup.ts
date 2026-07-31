import '@testing-library/jest-dom/vitest';

// happy-dom has no layout engine, so some Radix primitives that call
// scrollIntoView / ResizeObserver during render would throw. Stub the ones the
// shadcn Select touches so component mounts stay clean.
if (typeof Element !== 'undefined') {
  const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
  if (typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = () => {};
  }
}
const globalRef = globalThis as { ResizeObserver?: unknown };
if (!globalRef.ResizeObserver) {
  globalRef.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
