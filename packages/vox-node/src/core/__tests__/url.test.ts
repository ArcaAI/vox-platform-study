import { describe, expect, it } from 'vitest';

import { buildUrl, encodePathSegment } from '../url';

describe('buildUrl', () => {
  describe('non-exempt (v2 native) paths — get the api/v1 prefix', () => {
    it('prefixes a bare baseUrl', () => {
      expect(buildUrl('http://localhost:8868', 'consultations/abc/summary')).toBe(
        'http://localhost:8868/api/v1/consultations/abc/summary',
      );
    });

    it('prefixes when the path has a leading slash', () => {
      expect(buildUrl('http://localhost:8868', '/consultations/abc/summary')).toBe(
        'http://localhost:8868/api/v1/consultations/abc/summary',
      );
    });

    it('treats a trailing slash on baseUrl the same as no trailing slash', () => {
      expect(buildUrl('http://localhost:8868/', 'consultations/abc/summary')).toBe(
        'http://localhost:8868/api/v1/consultations/abc/summary',
      );
    });

    it('normalizes a baseUrl that already includes /api/v1 (documented behavior: stripped then re-added)', () => {
      expect(buildUrl('http://localhost:8868/api/v1', 'consultations/abc/summary')).toBe(
        'http://localhost:8868/api/v1/consultations/abc/summary',
      );
    });

    it('normalizes a baseUrl that already includes /api/v1/ (trailing slash)', () => {
      expect(buildUrl('http://localhost:8868/api/v1/', 'consultations/abc/summary')).toBe(
        'http://localhost:8868/api/v1/consultations/abc/summary',
      );
    });

    it('does not treat /api/v1 as exempt merely for being a substring of the path', () => {
      // consultations/jobs/:jobId is a real v2 route and MUST still be prefixed
      expect(buildUrl('http://localhost:8868', 'consultations/jobs/job-123')).toBe(
        'http://localhost:8868/api/v1/consultations/jobs/job-123',
      );
    });
  });

  describe('prefix-exempt v1-compat paths — main.ts excludes these from api/v1', () => {
    it('does not prefix POST /api/smr/api/v1/presummary', () => {
      expect(buildUrl('http://localhost:8868', 'api/smr/api/v1/presummary')).toBe(
        'http://localhost:8868/api/smr/api/v1/presummary',
      );
    });

    it('does not prefix POST /api/smr/api/v1/summary/sync', () => {
      expect(buildUrl('http://localhost:8868', 'api/smr/api/v1/summary/sync')).toBe(
        'http://localhost:8868/api/smr/api/v1/summary/sync',
      );
    });

    it('does not prefix when the exempt path has a leading slash', () => {
      expect(buildUrl('http://localhost:8868', '/api/smr/api/v1/presummary')).toBe(
        'http://localhost:8868/api/smr/api/v1/presummary',
      );
    });

    it('stays exempt even when baseUrl already includes /api/v1', () => {
      expect(buildUrl('http://localhost:8868/api/v1', 'api/smr/api/v1/presummary')).toBe(
        'http://localhost:8868/api/smr/api/v1/presummary',
      );
    });

    it('stays exempt with a trailing-slash baseUrl', () => {
      expect(buildUrl('http://localhost:8868/', 'api/smr/api/v1/summary/sync')).toBe(
        'http://localhost:8868/api/smr/api/v1/summary/sync',
      );
    });
  });

  describe('query params', () => {
    it('appends a query string, encoding special characters', () => {
      const url = buildUrl('http://localhost:8868', 'consultations', {
        query: { status: 'RUNNING', label: 'a b&c=d' },
      });
      expect(url).toBe(
        'http://localhost:8868/api/v1/consultations?status=RUNNING&label=a+b%26c%3Dd',
      );
    });

    it('coerces number and boolean values to strings', () => {
      const url = buildUrl('http://localhost:8868', 'consultations', {
        query: { limit: 10, includeNER: true },
      });
      expect(url).toBe('http://localhost:8868/api/v1/consultations?limit=10&includeNER=true');
    });

    it('omits undefined and null query values entirely', () => {
      const url = buildUrl('http://localhost:8868', 'consultations', {
        query: { status: 'RUNNING', cursor: undefined, tag: null },
      });
      expect(url).toBe('http://localhost:8868/api/v1/consultations?status=RUNNING');
    });

    it('adds no "?" when query is present but empty', () => {
      const url = buildUrl('http://localhost:8868', 'consultations', { query: {} });
      expect(url).toBe('http://localhost:8868/api/v1/consultations');
    });

    it('adds no "?" when query is omitted', () => {
      const url = buildUrl('http://localhost:8868', 'consultations');
      expect(url).toBe('http://localhost:8868/api/v1/consultations');
    });
  });
});

describe('encodePathSegment', () => {
  it('percent-encodes a plain uuid unchanged (no-op for safe characters)', () => {
    expect(encodePathSegment('0198f2b1-1234-7abc-9def-000000000001')).toBe(
      '0198f2b1-1234-7abc-9def-000000000001',
    );
  });

  it('encodes a slash so a malicious id cannot inject an extra path segment', () => {
    expect(encodePathSegment('abc/def')).toBe('abc%2Fdef');
  });

  it('encodes spaces and other reserved characters', () => {
    expect(encodePathSegment('a b?c&d')).toBe('a%20b%3Fc%26d');
  });

  it('round-trips through buildUrl for a consultation id with reserved characters', () => {
    const id = 'weird id/with slash';
    const url = buildUrl('http://localhost:8868', `consultations/${encodePathSegment(id)}/summary`);
    expect(url).toBe('http://localhost:8868/api/v1/consultations/weird%20id%2Fwith%20slash/summary');
  });
});
