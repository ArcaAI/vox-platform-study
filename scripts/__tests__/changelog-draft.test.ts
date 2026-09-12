/**
 * TASK-953 — argument and credential handling for `scripts/changelog-draft.ts`.
 *
 * The git/HTTP halves are covered by `changelog-from-commits.test.ts` and by
 * the gateway's own e2e suite respectively. What is pinned here is the part
 * that decides whether the job does anything at all: a missing credential must
 * FAIL BY NAME, never skip quietly. Quietly skipping is precisely how the
 * documented "CI creates a DRAFT ChangelogEntry" step went a year unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { parseDraftArgs, readGatewayConfig } from '../changelog-draft';

describe('parseDraftArgs', () => {
  it('defaults the tag to $CI_COMMIT_TAG so the job needs no argument in a tag pipeline', () => {
    expect(parseDraftArgs([], { CI_COMMIT_TAG: 'ALL-2.2.0' }).tag).toBe('ALL-2.2.0');
  });

  it('lets an explicit argument override $CI_COMMIT_TAG', () => {
    expect(parseDraftArgs(['ALL-3.0.0'], { CI_COMMIT_TAG: 'ALL-2.2.0' }).tag).toBe('ALL-3.0.0');
  });

  it('defaults to render-only — posting is never implicit', () => {
    expect(parseDraftArgs([], {}).post).toBe(false);
    expect(parseDraftArgs(['--post'], {}).post).toBe(true);
  });

  it('reads --since and --out', () => {
    const args = parseDraftArgs(['--since', 'ALL-2.1.0', '--out', 'draft.json'], {});
    expect(args.since).toBe('ALL-2.1.0');
    expect(args.out).toBe('draft.json');
  });
});

describe('readGatewayConfig', () => {
  const COMPLETE = { HOPE_GATEWAY_URL: 'https://api.example.test', HOPE_SVC_CLIENT_ID: 'hope_svc_x', HOPE_SVC_CLIENT_SECRET: 's3cret' };

  it('names every missing variable rather than failing vaguely', () => {
    expect(() => readGatewayConfig({})).toThrow(/HOPE_GATEWAY_URL, HOPE_SVC_CLIENT_ID, HOPE_SVC_CLIENT_SECRET/);
  });

  it('fails when only the secret is missing — a partial credential is not a usable one', () => {
    const { HOPE_SVC_CLIENT_SECRET: _omitted, ...partial } = COMPLETE;
    expect(() => readGatewayConfig(partial)).toThrow(/HOPE_SVC_CLIENT_SECRET/);
  });

  it('strips a trailing slash so the URL join cannot produce `//api/v1`', () => {
    expect(readGatewayConfig({ ...COMPLETE, HOPE_GATEWAY_URL: 'https://api.example.test///' }).baseUrl).toBe('https://api.example.test');
  });

  it('does not put the secret in the error message', () => {
    const { HOPE_GATEWAY_URL: _omitted, ...noUrl } = COMPLETE;
    expect(() => readGatewayConfig(noUrl)).toThrow(expect.not.stringContaining('s3cret'));
  });
});
