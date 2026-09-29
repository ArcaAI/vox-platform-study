import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { WorkflowDefinitionService } from '../workflow-definition.service';

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const build = (deps: Record<string, unknown>) => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = Object.create(WorkflowDefinitionService.prototype) as Record<string, unknown>;
  Object.assign(service, deps, { logger });
  return { service: service as unknown as Internals, logger };
};

describe('WorkflowDefinitionService.resolveContextSchemaVersionId (a lookup must not fail a publish)', () => {
  it('a tenant that pinned no schema resolves to null without a log line', async () => {
    const { service, logger } = build({ contextSchemaService: { getEffectiveBundle: vi.fn().mockRejectedValue(new NotFoundException('none')) } });

    await expect(service.resolveContextSchemaVersionId()).resolves.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an outage still resolves to null (publish must go on) but is logged with the Error object', async () => {
    const outage = new Error('ECONNRESET');
    const { service, logger } = build({ contextSchemaService: { getEffectiveBundle: vi.fn().mockRejectedValue(outage) } });

    await expect(service.resolveContextSchemaVersionId()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: outage }));
  });
});

describe('WorkflowDefinitionService.resolveImportReference (unresolvable is the honest answer)', () => {
  const reference = { kind: 'promptTemplate', key: 'soap' };

  it('a missing row is unresolved, silently', async () => {
    const { service, logger } = build({
      promptTemplateRepository: { findByName: vi.fn().mockRejectedValue(new DataNotFoundException('PromptTemplate', 'soap')) },
    });

    await expect(service.resolveImportReference(reference, 'tenant-1')).resolves.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an outage is still unresolved for the caller but leaves a warn naming the kind and tenant', async () => {
    const outage = new Error('ECONNRESET');
    const { service, logger } = build({ promptTemplateRepository: { findByName: vi.fn().mockRejectedValue(outage) } });

    await expect(service.resolveImportReference(reference, 'tenant-1')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: outage, kind: 'promptTemplate', tenantId: 'tenant-1' }));
  });
});
