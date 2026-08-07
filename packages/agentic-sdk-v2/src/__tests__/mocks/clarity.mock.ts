/**
 * Mock for the @microsoft/clarity SDK
 *
 * Mirrors the default export of `@microsoft/clarity` v1 used by the
 * ClarityTransport for behavioural monitoring integration.
 */

export const Clarity = {
  init: () => {},
  setTag: () => {},
  identify: () => {},
  consent: () => {},
  consentV2: () => {},
  upgrade: () => {},
  event: () => {},
};

export default Clarity;
