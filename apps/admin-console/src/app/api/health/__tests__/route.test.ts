import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/build-info', () => ({ getBuildVersion: () => '2.4.0' }));

const GOOD_SECRET = 'vitest-admin-session-secret-0123456789abcdef';
const ORIGINAL_SECRET = process.env.ADMIN_SESSION_SECRET;

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_SESSION_SECRET = GOOD_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = ORIGINAL_SECRET;
  });

  it('reports healthy with service/version/uptime/timestamp when config is valid', async () => {
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'healthy',
      service: 'admin-console',
      version: '2.4.0',
      checks: { config: { status: 'healthy' } },
    });
    expect(typeof body.uptime_seconds).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });

  it('never exposes gitBranch/gitCommitSha/ciPipeline detail — version only', async () => {
    const { GET } = await import('../route');
    const response = await GET();
    const body = await response.json();
    expect(body).not.toHaveProperty('gitBranch');
    expect(body).not.toHaveProperty('gitCommitSha');
    expect(body).not.toHaveProperty('ciPipelineId');
    expect(body).not.toHaveProperty('ciPipelineUrl');
  });

  it('reports unhealthy — still HTTP 200, informational only — when config is invalid, without leaking why', async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('unhealthy');
    expect(body.checks.config.status).toBe('unhealthy');
    expect(JSON.stringify(body)).not.toMatch(/ADMIN_SESSION_SECRET/);
  });
});
