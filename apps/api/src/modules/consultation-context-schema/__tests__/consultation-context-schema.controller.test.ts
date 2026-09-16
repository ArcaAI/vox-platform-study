/**
 * `GET admin/consultation-context-schemas/:id/usages` — the "what does this change break"
 * read.
 *
 * The controller holds no logic: what is pinned here is that it forwards the id and the OPTIONAL
 * `againstVersion` as a NUMBER, and that it does not invent a default of its own. The service
 * owns that default (the schema's own pin) and a controller-side fallback would be a second,
 * divergent answer to the same question.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationContextSchemaAdminController } from '../consultation-context-schema.controller';

const usagesResponse = {
  schemaId: 'schema-1',
  againstVersion: 2,
  workflows: [],
  agents: [],
};

describe('ConsultationContextSchemaAdminController — usages', () => {
  let controller: ConsultationContextSchemaAdminController;
  let service: { usages: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    service = { usages: vi.fn().mockResolvedValue(usagesResponse) };
    controller = new ConsultationContextSchemaAdminController(service as never);
  });

  it('forwards the id with no version when the query is absent', async () => {
    await expect(controller.usages('schema-1', undefined)).resolves.toBe(usagesResponse);
    expect(service.usages).toHaveBeenCalledWith('schema-1', undefined);
  });

  it('forwards `againstVersion` as a number, not the raw query string', async () => {
    await controller.usages('schema-1', 3);
    expect(service.usages).toHaveBeenCalledWith('schema-1', 3);
  });

  it('propagates the service refusal rather than translating it', async () => {
    const boom = new Error('Context schema schema-1 not found');
    service.usages.mockRejectedValue(boom);
    await expect(controller.usages('schema-1', undefined)).rejects.toBe(boom);
  });
});
