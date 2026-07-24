/**
 * AiServiceAdminController unit tests.
 *
 * Read-only status/config plane over the Guardrail + NLP Python services via
 * the gateway proxy. Platform-infra tier: class-level `manage:all` (matches
 * the queue/platform-metrics posture — these documents expose engine/model
 * internals, not tenant data). No mutation routes exist by design: neither
 * Python service exposes config writes internally.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AiServiceAdminController } from '../ai-service-admin.controller';

function makeController() {
  const client = {
    guardrailStatus: vi.fn().mockResolvedValue({ status: 'healthy', service: 'guardrail' }),
    guardrailConfig: vi.fn().mockResolvedValue({ medicalValidation: {}, analysisTypes: {} }),
    nlpStatus: vi.fn().mockResolvedValue({ status: 'healthy', service: 'nlp' }),
  };
  const controller = new AiServiceAdminController(client as never);
  return { controller, client };
}

describe('AiServiceAdminController — authorization metadata', () => {
  it('mounts at admin/ai-services behind class-level manage:all (platform tier)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiServiceAdminController)).toBe('admin/ai-services');
    expect(Reflect.getMetadata('required_permissions', AiServiceAdminController)).toEqual([{ action: 'manage', subject: 'all' }]);
  });

  it('exposes only the three read routes (no config mutation exists upstream)', () => {
    const proto = AiServiceAdminController.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.guardrailStatus).toBe('function');
    expect(typeof proto.guardrailConfig).toBe('function');
    expect(typeof proto.nlpStatus).toBe('function');
    expect(proto.updateGuardrailConfig).toBeUndefined();
    expect(proto.updateNlpConfig).toBeUndefined();
  });
});

describe('AiServiceAdminController — delegation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('guardrailStatus proxies the guardrail health document', async () => {
    const { controller, client } = makeController();
    await expect(controller.guardrailStatus()).resolves.toEqual({ status: 'healthy', service: 'guardrail' });
    expect(client.guardrailStatus).toHaveBeenCalledTimes(1);
  });

  it('guardrailConfig proxies the merged config read', async () => {
    const { controller, client } = makeController();
    await expect(controller.guardrailConfig()).resolves.toEqual({ medicalValidation: {}, analysisTypes: {} });
    expect(client.guardrailConfig).toHaveBeenCalledTimes(1);
  });

  it('nlpStatus proxies the NLP health document', async () => {
    const { controller, client } = makeController();
    await expect(controller.nlpStatus()).resolves.toEqual({ status: 'healthy', service: 'nlp' });
    expect(client.nlpStatus).toHaveBeenCalledTimes(1);
  });
});
