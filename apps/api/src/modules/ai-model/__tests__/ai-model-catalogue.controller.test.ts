/**
 * TASK-890 L1 — `GET admin/ai-models/catalogue`.
 *
 * The ONE tenant-reachable route on the model-registry surface. Everything else
 * under `admin/ai-models` is `manage:all`; this is `read:AiModel`, which is the
 * whole point — and the reason the metadata is asserted here rather than
 * trusted: a route that silently inherited the class-level registry gate would
 * 403 every tenant admin, and a route that widened the registry's WRITE gate
 * would be a privilege escalation.
 *
 * Metadata is read with `Reflector.getAllAndOverride` — the same lookup
 * `UnifiedAuthGuard` and the boot audits use (rule 05 §Metadata trap: Nest does
 * not copy class-level decorators onto method refs).
 */
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { API_KEY_FORBIDDEN, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { AiModelCatalogueController } from '../ai-model-catalogue.controller';

const reflector = new Reflector();
const handler = AiModelCatalogueController.prototype.catalogue;

describe('AiModelCatalogueController authorization metadata', () => {
  it('requires read:AiModel — not the registry`s manage:all', () => {
    const meta = reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, AiModelCatalogueController]);
    expect(meta).toEqual([{ action: 'read', subject: 'AiModel' }]);
  });

  it('forbids the API-key credential class', () => {
    expect(reflector.getAllAndOverride(API_KEY_FORBIDDEN, [handler, AiModelCatalogueController])).toBe(true);
  });

  it('declares the ai-model READ service-account scope, paired with its manage twin (decision O-3, OR semantics)', () => {
    const scopes = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [handler, AiModelCatalogueController]);
    expect(scopes).toEqual(['svc:admin:ai-model:read', 'svc:admin:ai-model:manage']);
  });

  it('is mounted at GET admin/ai-models/catalogue — a STATIC path that must register before the `:id` family', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelCatalogueController)).toBe('admin/ai-models');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('catalogue');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });
});

describe('AiModelCatalogueController delegation', () => {
  it('passes the validated query through as the service filter and returns the payload verbatim', async () => {
    const payload = { providers: [], models: [] };
    const getCatalogue = vi.fn().mockResolvedValue(payload);
    const controller = new AiModelCatalogueController({ getCatalogue } as never);

    const result = await controller.catalogue({ taskType: 'TEXT_GENERATION', providerGroup: 'hope', usableOnly: true } as never);

    expect(getCatalogue).toHaveBeenCalledWith({ taskType: 'TEXT_GENERATION', providerGroup: 'hope', usableOnly: true });
    expect(result).toBe(payload);
  });

  it('sends an EMPTY filter when no query is supplied', async () => {
    const getCatalogue = vi.fn().mockResolvedValue({ providers: [], models: [] });
    const controller = new AiModelCatalogueController({ getCatalogue } as never);

    await controller.catalogue({} as never);

    expect(getCatalogue).toHaveBeenCalledWith({});
  });
});
