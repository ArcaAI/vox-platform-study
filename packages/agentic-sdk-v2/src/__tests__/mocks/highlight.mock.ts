/**
 * Mock for highlight.run SDK
 *
 * This mock provides the H object that matches the Highlight.io SDK interface
 * used in the HighlightTransport for observability integration.
 */

export const H = {
  init: () => {},
  identify: () => {},
  track: () => {},
  consume: () => {},
  consumeError: () => {},
  log: () => {},
  start: () => {},
  stop: () => {},
  getSessionURL: () => 'https://highlight.io/session',
  getSessionId: () => 'mock-session-id',
  isRunningOnHighlight: () => false,
  error: () => {},
};

export default { H };
