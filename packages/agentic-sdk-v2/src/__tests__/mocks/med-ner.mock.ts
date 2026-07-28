/**
 * Mock for @arcaai/med-ner
 */

import { vi } from 'vitest';

const createMockProcessor = () => ({
  init: vi.fn().mockResolvedValue(undefined),
  extract: vi.fn().mockResolvedValue({
    text: 'test text',
    entities: [{ text: 'diabetes', type: 'CONDITION', score: 0.95, start: 0, end: 8 }],
    processingTime: 100,
    timestamp: Date.now(),
  }),
  isInitialized: vi.fn().mockReturnValue(true),
  destroy: vi.fn().mockResolvedValue(undefined),
});

export const createMedNER = vi.fn(createMockProcessor);

// Reset function for tests
export const resetMedNERMock = () => {
  createMedNER.mockImplementation(createMockProcessor);
};

export default { createMedNER, resetMedNERMock };
