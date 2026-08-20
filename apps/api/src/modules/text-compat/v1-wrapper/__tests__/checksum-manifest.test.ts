import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { V1_PRIOR_MEDICAL_CONTEXT_PREFIX } from '../v1-prior-medical-context';
import { V1_JSON_RESPONSE_SPEC_FALLBACK_JSON, V1_DEPT_VISIT_SCHEMAS } from '../v1-department-schemas';
import {
  V1_JSON_RULES_WITH_SCHEMA_TEMPLATE,
  V1_JSON_RULES_WITHOUT_SCHEMA_TEMPLATE,
} from '../v1-strict-json-response-format';
import { V1_SUMMARY_SYSTEM_PROMPT } from '../v1-summary-system-prompt';
import { V1_SUMMARY_USER_PROMPT_TEMPLATE } from '../v1-summary-user-prompt-template';

// `apps/api`'s tsconfig does not enable `resolveJsonModule` (only the Next.js
// and Vite ts-config presets do) -- read + JSON.parse the fixture like
// `summary-prompt.builder.test.ts` reads its fixtures, rather than a static
// `.json` import.
interface ChecksumEntry {
  sha256: string;
  bytes: number;
}
const checksumManifest: Record<string, ChecksumEntry> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'checksum-manifest.json'), 'utf8'),
) as Record<string, ChecksumEntry>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

/**
 * Regression gate (mirrors the department-template sha256
 * fixture pattern already used for `../dept-templates.ts`): every constant in
 * this directory must keep hashing to the value recorded when it was
 * extracted byte-exact from the running v1 pod
 * (`apps-text-84c9774997-zhp2l`, cluster `c-9lwv8`, namespace `apps`,
 * 2026-08-07). A red test here means either the constant was hand-edited
 * (forbidden — these are GENERATED) or the fixture drifted; investigate,
 * don't just update the fixture.
 */
describe('v1-wrapper checksum manifest (regression gate)', () => {
  it('V1_SUMMARY_SYSTEM_PROMPT matches its recorded fingerprint', () => {
    const expected = checksumManifest.system_prompt_base;
    expect(sha256(V1_SUMMARY_SYSTEM_PROMPT)).toBe(expected.sha256);
    expect(byteLength(V1_SUMMARY_SYSTEM_PROMPT)).toBe(expected.bytes);
  });

  it('V1_SUMMARY_USER_PROMPT_TEMPLATE matches its recorded fingerprint', () => {
    const expected = checksumManifest.user_prompt_template;
    expect(sha256(V1_SUMMARY_USER_PROMPT_TEMPLATE)).toBe(expected.sha256);
    expect(byteLength(V1_SUMMARY_USER_PROMPT_TEMPLATE)).toBe(expected.bytes);
  });

  it('V1_PRIOR_MEDICAL_CONTEXT_PREFIX matches its recorded fingerprint', () => {
    const expected = checksumManifest.prior_context_prefix;
    expect(sha256(V1_PRIOR_MEDICAL_CONTEXT_PREFIX)).toBe(expected.sha256);
    expect(byteLength(V1_PRIOR_MEDICAL_CONTEXT_PREFIX)).toBe(expected.bytes);
  });

  it('V1_JSON_RULES_WITH_SCHEMA_TEMPLATE matches its recorded fingerprint', () => {
    const expected = checksumManifest.json_rules_with_schema_template;
    expect(sha256(V1_JSON_RULES_WITH_SCHEMA_TEMPLATE)).toBe(expected.sha256);
    expect(byteLength(V1_JSON_RULES_WITH_SCHEMA_TEMPLATE)).toBe(expected.bytes);
  });

  it('V1_JSON_RULES_WITHOUT_SCHEMA_TEMPLATE matches its recorded fingerprint', () => {
    const expected = checksumManifest.json_rules_without_schema_template;
    expect(sha256(V1_JSON_RULES_WITHOUT_SCHEMA_TEMPLATE)).toBe(expected.sha256);
    expect(byteLength(V1_JSON_RULES_WITHOUT_SCHEMA_TEMPLATE)).toBe(expected.bytes);
  });

  it('V1_JSON_RESPONSE_SPEC_FALLBACK_JSON matches its recorded fingerprint', () => {
    const expected = checksumManifest.json_response_spec_fallback;
    expect(sha256(V1_JSON_RESPONSE_SPEC_FALLBACK_JSON)).toBe(expected.sha256);
    expect(byteLength(V1_JSON_RESPONSE_SPEC_FALLBACK_JSON)).toBe(expected.bytes);
  });

  it('V1_DEPT_VISIT_SCHEMAS (all 22 pairs, canonical JSON) matches its recorded fingerprint', () => {
    const expected = checksumManifest.dept_visit_schemas_all_22;
    const pairs: Array<[string, unknown]> = [];
    for (const dept of Object.keys(V1_DEPT_VISIT_SCHEMAS).sort()) {
      const visits = V1_DEPT_VISIT_SCHEMAS[dept];
      for (const visit of Object.keys(visits).sort()) {
        pairs.push([`${dept}::${visit}`, visits[visit]]);
      }
    }
    pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonical = JSON.stringify(Object.fromEntries(pairs), null, 2);
    expect(sha256(canonical)).toBe(expected.sha256);
    expect(byteLength(canonical)).toBe(expected.bytes);
  });

  it('carries exactly 22 (department, visit_type) pairs — 11 departments x 2 visit types', () => {
    const deptKeys = Object.keys(V1_DEPT_VISIT_SCHEMAS);
    expect(deptKeys).toHaveLength(11);
    const total = deptKeys.reduce((sum, dept) => sum + Object.keys(V1_DEPT_VISIT_SCHEMAS[dept]).length, 0);
    expect(total).toBe(22);
  });
});
