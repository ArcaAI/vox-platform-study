import { describe, it, expect } from 'vitest';

describe('App Sidebar Navigation Structure', () => {
  const PLAYGROUND_ROUTES = [
    '/playground/overview',
    '/consultation',
    '/audio/live-transcription',
    '/audio/job-transcription',
    '/dna-writing-style',
    '/summarization/pre-summary',
    '/summarization/summary',
  ];

  const REMOVED_ROUTES = ['/summarization/overview', '/summarization/live-demo', '/summarization/history'];

  describe('Playground section', () => {
    it('should include Pre-Summary in Playground items', () => {
      expect(PLAYGROUND_ROUTES).toContain('/summarization/pre-summary');
    });

    it('should include Summary in Playground items', () => {
      expect(PLAYGROUND_ROUTES).toContain('/summarization/summary');
    });

    it('should not have a separate Summarization section', () => {
      const summarizationOnlyRoutes = PLAYGROUND_ROUTES.filter((r) => r.startsWith('/summarization/') && !REMOVED_ROUTES.includes(r));
      expect(summarizationOnlyRoutes.length).toBe(2);
      expect(summarizationOnlyRoutes).toEqual(['/summarization/pre-summary', '/summarization/summary']);
    });
  });

  describe('Removed pages', () => {
    it('should not include Overview in any nav section', () => {
      expect(PLAYGROUND_ROUTES).not.toContain('/summarization/overview');
    });

    it('should not include Live Demo in any nav section', () => {
      expect(PLAYGROUND_ROUTES).not.toContain('/summarization/live-demo');
    });

    it('should not include History in any nav section', () => {
      expect(PLAYGROUND_ROUTES).not.toContain('/summarization/history');
    });
  });

  describe('Playground item order', () => {
    it('should order items: Overview, Consultation, Audio (Live + Job), DNA, Pre-Summary, Summary', () => {
      expect(PLAYGROUND_ROUTES).toEqual([
        '/playground/overview',
        '/consultation',
        '/audio/live-transcription',
        '/audio/job-transcription',
        '/dna-writing-style',
        '/summarization/pre-summary',
        '/summarization/summary',
      ]);
    });
  });
});
