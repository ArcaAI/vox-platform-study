/**
 * MCP token resolution — frozen design.
 *
 * `_resolve_mcp_token` in the harness was a hardcoded `return None`, and the
 * harness has NO Vault client (hvac appears only in comments) — so an MCP server
 * requiring auth could never be called, and any server that WAS reachable got an
 * unauthenticated request.
 *
 * The design deliberately does NOT give the harness a Vault client. The gateway
 * resolves the token instead, over the existing X-Service-Token internal route, so
 * secret material stays on the side of the boundary that already holds it.
 *
 * The security properties under test here are the load-bearing ones:
 *   - `authRef` is an ALLOWLIST lookup against registered, ENABLED `McpServer`
 *     rows — never an arbitrary secret-path read. An unknown ref returns null.
 *   - the resolved secret is never logged, and never echoed alongside its path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessInternalService } from '../harness-internal.service';

const AUTH_REF = 'secret/data/mcp/terminology';
const TOKEN = 'super-secret-mcp-token';

const mcpServerRepository = { findAll: vi.fn() };
const secretsService = { getSecret: vi.fn(), getSecretOptional: vi.fn() };

const enabledServer = (authRef: string | null = AUTH_REF, enabled = true) => ({
  id: 'mcp-1',
  name: 'terminology',
  authRef,
  enabled,
});

function buildService(opts: { withSecrets?: boolean; withRegistry?: boolean } = {}) {
  const { withSecrets = true, withRegistry = true } = opts;
  return new HarnessInternalService(
    {} as never, // contextItemRepository
    {} as never, // consultationRepository
    {} as never, // namedEntityRepository
    {} as never, // summaryMetaRepository
    {} as never, // promptAssemblyService
    {} as never, // promptTemplateRepository
    {} as never, // harnessAuditService
    { run: vi.fn(async (cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never, // cls
    {} as never, // jobService
    undefined as never, // highlightRepository
    undefined as never, // assuranceService
    undefined as never, // configResolver
    undefined as never, // contextItemVersionRepository
    withSecrets ? (secretsService as never) : undefined,
    undefined as never, // redisCache
    undefined as never, // transcriptSegmentRepository
    undefined as never, // harnessPolicyService
    withRegistry ? (mcpServerRepository as never) : undefined,
  );
}

describe('HarnessInternalService.resolveMcpToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpServerRepository.findAll.mockResolvedValue([enabledServer()]);
    secretsService.getSecret.mockResolvedValue(TOKEN);
  });

  it('returns the gateway-resolved secret for a REGISTERED authRef', async () => {
    const token = await buildService().resolveMcpToken(AUTH_REF);

    expect(token).toBe(TOKEN);
    expect(secretsService.getSecret).toHaveBeenCalledWith(AUTH_REF);
  });

  it('refuses an UNREGISTERED authRef without touching the secrets backend', async () => {
    // The whole point of the allowlist: this route must never become an
    // arbitrary secret-path read for anything holding the service token.
    const token = await buildService().resolveMcpToken('secret/data/prod/database-password');

    expect(token).toBeNull();
    expect(secretsService.getSecret).not.toHaveBeenCalled();
  });

  it('refuses an authRef belonging to a DISABLED server', async () => {
    mcpServerRepository.findAll.mockResolvedValue([enabledServer(AUTH_REF, false)]);

    expect(await buildService().resolveMcpToken(AUTH_REF)).toBeNull();
    expect(secretsService.getSecret).not.toHaveBeenCalled();
  });

  it('returns null for an empty authRef (a public / in-boundary server needs no token)', async () => {
    expect(await buildService().resolveMcpToken('')).toBeNull();
    expect(secretsService.getSecret).not.toHaveBeenCalled();
  });

  it('returns null when the secrets backend is unwired rather than throwing', async () => {
    expect(await buildService({ withSecrets: false }).resolveMcpToken(AUTH_REF)).toBeNull();
  });

  it('returns null when the registry is unwired (fail-closed, nothing callable)', async () => {
    expect(await buildService({ withRegistry: false }).resolveMcpToken(AUTH_REF)).toBeNull();
  });

  it('degrades to null when the secrets backend throws — never leaks the error body', async () => {
    secretsService.getSecret.mockRejectedValue(new Error(`vault denied for ${AUTH_REF}`));

    expect(await buildService().resolveMcpToken(AUTH_REF)).toBeNull();
  });

  it('never writes the secret value to the log', async () => {
    const service = buildService();
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn((service as unknown as { logger: Record<string, unknown> }).logger, level as never).mockImplementation(((payload: unknown) => {
        logged.push(typeof payload === 'string' ? payload : JSON.stringify(payload));
      }) as never);
    }

    await service.resolveMcpToken(AUTH_REF);
    await service.resolveMcpToken('secret/data/prod/database-password');
    secretsService.getSecret.mockRejectedValue(new Error('vault denied'));
    await service.resolveMcpToken(AUTH_REF);

    expect(logged.join('\n')).not.toContain(TOKEN);
  });
});
