/**
 * DepartmentAgent capability-binding write path (/ DR-9).
 *
 * The tenant opt-in surface for the whole live-agent design is the EXISTING
 * DepartmentAgent REST API — there is no new UI in this ticket — so these
 * validations are the only thing standing between a typo in the admin console
 * and a silently mis-resolved clinical prompt.
 *
 * Covers: bindings accepted and persisted on create/update/clone, per-binding
 * bindability (tenant-visible + department-compatible), toolConfig / llmOverrides
 * structural validation, the model-catalogue check, and the fact that a LOCKED
 * template copy rejects binding edits with no new code (they ride `update()`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { DepartmentAgentService } from '../departmentAgent.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockAgentRepository = {
  findById: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
  isSlugUnique: vi.fn(),
};
const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), create: vi.fn() };
const mockAiModelRepository = { findBySlug: vi.fn() };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DepartmentAgentFactory: {
      CreateDepartmentAgent: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-agent-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      })),
    },
  };
});

const mockAgent = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  tenantId: 'tenant-1',
  departmentId: 'dept-1',
  name: 'Surgery',
  slug: 'surg-default',
  description: null,
  promptTemplateId: 'tpl-base',
  pinnedVersionNumber: null,
  dnaStylePolicy: 'INHERIT',
  harnessOverrides: null,
  goldenSetId: null,
  newPatientTemplateId: null,
  revisitTemplateId: null,
  preSummaryTemplateId: null,
  livePromptTemplateId: null,
  toolConfig: null,
  llmOverrides: null,
  isDefault: false,
  templateLocked: false,
  tags: [],
  resourceStatus: 'ENABLED',
  version: 1,
  hasChanges: true,
  changes: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  toObject: () => ({}),
  enable: vi.fn(),
  disable: vi.fn(),
  ...overrides,
});

const baseCreate = {
  departmentId: 'dept-1',
  name: 'Surgery Default Agent',
  slug: 'surg-default',
  promptTemplateId: 'tpl-base',
};

describe('DepartmentAgentService — capability bindings', () => {
  let service: DepartmentAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-1' } : key === 'tenantId' ? 'tenant-1' : null));
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', tenantId: 'tenant-1' });
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
      id,
      tenantId: 'tenant-1',
      status: 'APPROVED',
      departmentId: null,
    }));
    mockAgentRepository.isSlugUnique.mockResolvedValue(true);
    mockAgentRepository.create.mockImplementation(async (e: unknown) => e);
    mockAgentRepository.updateWithVersion.mockImplementation(async (_id: string, e: Record<string, unknown>) => e);
    mockAiModelRepository.findBySlug.mockResolvedValue({
      slug: 'lms-gemma',
      taskType: 'TEXT_GENERATION',
      resourceStatus: 'ENABLED',
    });

    service = new DepartmentAgentService(
      mockAgentRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
      undefined,
      mockAiModelRepository as never,
    );
  });

  describe('create', () => {
    it('persists all six capability fields and surfaces them on the response', async () => {
      const res = await service.create({
        ...baseCreate,
        newPatientTemplateId: 'tpl-new',
        revisitTemplateId: 'tpl-revisit',
        preSummaryTemplateId: 'tpl-presum',
        livePromptTemplateId: 'tpl-live',
        toolConfig: { version: 1, tools: { ner: { enabled: true }, groundedness: { enabled: null } } },
        llmOverrides: { live: { aiModelSlug: 'lms-gemma' } },
      });

      expect(res.newPatientTemplateId).toBe('tpl-new');
      expect(res.revisitTemplateId).toBe('tpl-revisit');
      expect(res.preSummaryTemplateId).toBe('tpl-presum');
      expect(res.livePromptTemplateId).toBe('tpl-live');
      expect(res.toolConfig).toEqual({ version: 1, tools: { ner: { enabled: true }, groundedness: { enabled: null } } });
      expect(res.llmOverrides).toEqual({ live: { aiModelSlug: 'lms-gemma' } });
    });

    it('defaults every capability field to null when omitted (the seeded-catalogue shape)', async () => {
      const res = await service.create(baseCreate);
      expect(res.newPatientTemplateId).toBeNull();
      expect(res.revisitTemplateId).toBeNull();
      expect(res.preSummaryTemplateId).toBeNull();
      expect(res.livePromptTemplateId).toBeNull();
      expect(res.toolConfig).toBeNull();
      expect(res.llmOverrides).toBeNull();
    });

    it('rejects a binding that belongs to another tenant, naming the FIELD but not confirming existence', async () => {
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
        id,
        tenantId: id === 'foreign-tpl' ? 'tenant-2' : 'tenant-1',
        status: 'APPROVED',
        departmentId: null,
      }));

      await expect(service.create({ ...baseCreate, revisitTemplateId: 'foreign-tpl' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...baseCreate, revisitTemplateId: 'foreign-tpl' })).rejects.toThrow(/revisitTemplateId/);
    });

    it('rejects a binding bound to a DIFFERENT department', async () => {
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
        id,
        tenantId: 'tenant-1',
        status: 'APPROVED',
        departmentId: id === 'other-dept-tpl' ? 'dept-2' : null,
      }));

      await expect(service.create({ ...baseCreate, livePromptTemplateId: 'other-dept-tpl' })).rejects.toThrow(/livePromptTemplateId/);
    });

    it('ACCEPTS a not-yet-approved binding — approval is a RESOLUTION gate, not a wiring gate', async () => {
      // Rejecting a DRAFT template here would make it impossible to wire an
      // agent to a template that is still moving through the approval gate. The
      // resolver simply falls through such a binding.
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
        id,
        tenantId: 'tenant-1',
        status: id === 'draft-tpl' ? 'DRAFT' : 'APPROVED',
        departmentId: null,
      }));

      const res = await service.create({ ...baseCreate, newPatientTemplateId: 'draft-tpl' });
      expect(res.newPatientTemplateId).toBe('draft-tpl');
    });
  });

  describe('toolConfig validation', () => {
    it.each([
      [{ version: 2, tools: {} }, /version must be 1/],
      [{ tools: { telepathy: { enabled: true } } }, /unknown tool 'telepathy'/],
      [{ tools: { ner: { enabled: 'yes' } } }, /enabled must be a boolean or null/],
      [{ tools: [] }, /must be an object keyed by tool name/],
      [{ version: 1, mode: 'model-initiated' }, /unknown key\(s\): mode/],
    ])('rejects %j', async (toolConfig, message) => {
      await expect(service.create({ ...baseCreate, toolConfig: toolConfig as Record<string, unknown> })).rejects.toThrow(message);
    });

    it('accepts the canonical shape, including enabled:null ("follow the env default")', async () => {
      const toolConfig = { version: 1, tools: { ner: { enabled: true }, vitals: { enabled: false }, groundedness: { enabled: null } } };
      await expect(service.create({ ...baseCreate, toolConfig })).resolves.toBeDefined();
    });
  });

  describe('llmOverrides validation', () => {
    it('rejects a task key outside { live, finalize } — one global model field is forbidden by', async () => {
      await expect(service.create({ ...baseCreate, llmOverrides: { aiModelSlug: 'lms-gemma' } })).rejects.toThrow(/unknown task/);
      await expect(service.create({ ...baseCreate, llmOverrides: { test: { aiModelSlug: 'x' } } })).rejects.toThrow(/unknown task 'test'/);
    });

    it('requires a non-empty aiModelSlug per task', async () => {
      await expect(service.create({ ...baseCreate, llmOverrides: { live: {} } })).rejects.toThrow(/aiModelSlug is required/);
    });

    it('rejects a slug that is not an ENABLED text-generation model', async () => {
      mockAiModelRepository.findBySlug.mockResolvedValue({ slug: 'whisper', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', resourceStatus: 'ENABLED' });
      await expect(service.create({ ...baseCreate, llmOverrides: { finalize: { aiModelSlug: 'whisper' } } })).rejects.toThrow(
        /not an enabled text-generation model/,
      );

      mockAiModelRepository.findBySlug.mockResolvedValue(null);
      await expect(service.create({ ...baseCreate, llmOverrides: { live: { aiModelSlug: 'ghost' } } })).rejects.toThrow(/'ghost'/);
    });

    it('keeps live and finalize INDEPENDENT (a low-latency live model must not drive finalize)', async () => {
      const res = await service.create({
        ...baseCreate,
        llmOverrides: { live: { aiModelSlug: 'lms-gemma' }, finalize: { aiModelSlug: 'lms-gemma' } },
      });
      expect(res.llmOverrides).toEqual({ live: { aiModelSlug: 'lms-gemma' }, finalize: { aiModelSlug: 'lms-gemma' } });
      expect(mockAiModelRepository.findBySlug).toHaveBeenCalledTimes(2);
    });

    it('still validates STRUCTURE when the model catalogue is not wired (optional dependency absent)', async () => {
      const noCatalogue = new DepartmentAgentService(
        mockAgentRepository as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDepartmentRepository as never,
        mockPromptTemplateRepository as never,
        mockPromptVersionRepository as never,
      );
      await expect(noCatalogue.create({ ...baseCreate, llmOverrides: { live: {} } })).rejects.toThrow(/aiModelSlug is required/);
      await expect(noCatalogue.create({ ...baseCreate, llmOverrides: { live: { aiModelSlug: 'anything' } } })).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    it('applies binding edits', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent());

      const updated = await service.update('agent-1', {
        revisitTemplateId: 'tpl-revisit',
        toolConfig: { version: 1, tools: { ner: { enabled: false } } },
        expectedVersion: 1,
      });

      expect(updated.revisitTemplateId).toBe('tpl-revisit');
      expect(updated.toolConfig).toEqual({ version: 1, tools: { ner: { enabled: false } } });
    });

    it('CLEARS a binding when explicitly set to null', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent({ revisitTemplateId: 'tpl-revisit' }));
      const updated = await service.update('agent-1', { revisitTemplateId: null, expectedVersion: 1 });
      expect(updated.revisitTemplateId).toBeNull();
    });

    it('a LOCKED template copy rejects binding edits with 403 — no new code needed (they ride update())', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent({ templateLocked: true }));
      await expect(service.update('agent-1', { livePromptTemplateId: 'tpl-live', expectedVersion: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('clone', () => {
    it('carries the capability bindings by reference while deep-copying only the BASE template', async () => {
      mockAgentRepository.findById.mockResolvedValue(
        mockAgent({
          newPatientTemplateId: 'tpl-new',
          revisitTemplateId: 'tpl-revisit',
          livePromptTemplateId: 'tpl-live',
          toolConfig: { version: 1, tools: { ner: { enabled: false } } },
        }),
      );
      mockPromptTemplateRepository.create.mockImplementation(async (t: Record<string, unknown>) => ({ ...t, id: 'cloned-tpl' }));
      mockPromptVersionRepository.create.mockImplementation(async (v: unknown) => v);

      const clone = await service.clone('agent-1', { name: 'Surgery (custom)', slug: 'surg-custom' });

      // The base binding points at the NEW editable DRAFT copy…
      expect(clone.promptTemplateId).toBe('cloned-tpl');
      // …while the capability bindings still name the source templates, so the
      // clone resolves identically until the tenant re-points them.
      expect(clone.newPatientTemplateId).toBe('tpl-new');
      expect(clone.revisitTemplateId).toBe('tpl-revisit');
      expect(clone.livePromptTemplateId).toBe('tpl-live');
      expect(clone.toolConfig).toEqual({ version: 1, tools: { ner: { enabled: false } } });
      expect(clone.templateLocked).toBe(false);
    });
  });
});
