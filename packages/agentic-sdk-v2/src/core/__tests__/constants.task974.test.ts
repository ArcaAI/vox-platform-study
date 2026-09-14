/**
 * @arcaai/vox - DNA_WRITING_STYLE_ENDPOINTS Tests (TASK-974, lane L3)
 *
 * The business-plane ingest surface for the DNA writing-style analyst agent.
 * A NEW constant name — `DNA_STYLE_ENDPOINTS` stays absent per the TASK-890
 * gate tests (`business-plane-only.task890.test.ts`,
 * `exports.task032.test.ts`) and this group must never resurrect it. Both
 * paths are business-plane (`/dna-writing-styles/ingest*`, no `/admin/`
 * prefix), so `isAdminPlanePath` must classify them as `false`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { DNA_WRITING_STYLE_ENDPOINTS, isAdminPlanePath } from '../constants';

describe('DNA_WRITING_STYLE_ENDPOINTS (TASK-974)', () => {
  it('should expose the ingest path', () => {
    expect(DNA_WRITING_STYLE_ENDPOINTS.INGEST).toBe('/dna-writing-styles/ingest');
  });

  it('should generate the ingest job status path, URL-encoding the jobId', () => {
    expect(DNA_WRITING_STYLE_ENDPOINTS.INGEST_JOB('job-1')).toBe('/dna-writing-styles/ingest/jobs/job-1');
    expect(DNA_WRITING_STYLE_ENDPOINTS.INGEST_JOB('job/with slash')).toBe('/dna-writing-styles/ingest/jobs/job%2Fwith%20slash');
  });

  it('should never be classified as an admin-plane path', () => {
    expect(isAdminPlanePath(DNA_WRITING_STYLE_ENDPOINTS.INGEST)).toBe(false);
    expect(isAdminPlanePath(DNA_WRITING_STYLE_ENDPOINTS.INGEST_JOB('job-1'))).toBe(false);
  });
});
