/**
 * TASK-1004 §4.3 — the consultation's declared spoken-language mode rides out of the ONE
 * consultation read the ASR resolution already makes, so a live session inherits it with no extra
 * round trip. Language is an OUTPUT of this read only: it never selects or changes the agent.
 *
 *  - tier 2/3 (no `agentSlug`, a `consultationId`): the consultation is read anyway → its mode is
 *    surfaced, one read, no flag needed;
 *  - an explicit `agentSlug` with `inheritConsultationLanguage` (the request declared no mode):
 *    exactly one read, 404 on a foreign id, and the agent is still the named one;
 *  - an explicit `agentSlug` without it: the consultation is not read at all (TASK-1002, unchanged).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import type { ResolvedAgent } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrAgentResolverService } from '../asr-agent-resolver.service';
import { GoverningWorkflowAsrReader } from '../governing-workflow-asr';

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, { input: { agent: ResolvedAgent } }>;
const asrAgent = fixture.platformDefault.input.agent;

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'consultation-1';

const agents = { resolve: vi.fn() };
const credentials = { resolve: vi.fn() };
const consultations = { findById: vi.fn() };
const runs = { findById: vi.fn(), findByRunKey: vi.fn() };
const definitions = { findById: vi.fn(), findPublishedBySlug: vi.fn() };
const agentRows = { findPublishedActiveBySlug: vi.fn(), findPublishedVisibleBySlugVersion: vi.fn(), findAllVersionsBySlug: vi.fn() };

const make = () =>
  new AsrAgentResolverService(
    agents as never,
    credentials as never,
    undefined,
    new GoverningWorkflowAsrReader(consultations as never, runs as never, definitions as never, agentRows as never),
  );

const row = (overrides: Record<string, unknown> = {}) => ({
  id: CONSULTATION,
  tenantId: TENANT,
  departmentId: 'dept-1',
  metadata: {},
  spokenLanguageMode: 'ml-en',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolve.mockResolvedValue(null);
  agents.resolve.mockResolvedValue({ ...asrAgent, source: 'tenant' });
});

describe('TASK-1004 — the consultation’s mode rides out of the existing read', () => {
  it('tier 3 (no agentSlug): one consultation read, its mode surfaced, the agent from the cascade', async () => {
    consultations.findById.mockResolvedValue(row());
    const session = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });
    expect(consultations.findById).toHaveBeenCalledTimes(1);
    expect(session.consultationLanguageMode).toBe('ml-en');
    expect(session.spec.agent.slug).toBe(asrAgent.slug);
  });

  it('a row that only carries the legacy marker is read through it', async () => {
    consultations.findById.mockResolvedValue(row({ spokenLanguageMode: null, metadata: { summaryLanguage: 'en-IN' } }));
    const session = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });
    expect(session.consultationLanguageMode).toBe('en');
  });

  it('explicit agentSlug + inheritConsultationLanguage: exactly one read, the NAMED agent still serves', async () => {
    consultations.findById.mockResolvedValue(row());
    agents.resolve.mockResolvedValue({ ...asrAgent, source: 'explicit' });
    const session = await make().resolve({
      tenantId: TENANT,
      agentSlug: 'platform-transcription',
      consultationId: CONSULTATION,
      inheritConsultationLanguage: true,
    });
    expect(consultations.findById).toHaveBeenCalledTimes(1);
    expect(agents.resolve).toHaveBeenCalledTimes(1);
    expect(agents.resolve).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'platform-transcription', task: AgentTask.SPEECH_TO_TEXT }));
    expect(session.spec.agent.source).toBe('explicit');
    expect(session.consultationLanguageMode).toBe('ml-en');
  });

  it('explicit agentSlug + inheritConsultationLanguage on a FOREIGN consultation is one 404', async () => {
    consultations.findById.mockResolvedValue(row({ tenantId: 'other-tenant' }));
    await expect(
      make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription', consultationId: CONSULTATION, inheritConsultationLanguage: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('explicit agentSlug without the flag: the consultation is not read (TASK-1002 unchanged)', async () => {
    const session = await make().resolve({ tenantId: TENANT, agentSlug: 'platform-transcription', consultationId: CONSULTATION });
    expect(consultations.findById).not.toHaveBeenCalled();
    expect(session).not.toHaveProperty('consultationLanguageMode');
  });

  it('the mode never changes WHICH agent resolves: ml-en and en consultations get the same agent', async () => {
    consultations.findById.mockResolvedValueOnce(row({ spokenLanguageMode: 'ml-en' })).mockResolvedValueOnce(row({ spokenLanguageMode: 'en' }));
    const first = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });
    const second = await make().resolve({ tenantId: TENANT, consultationId: CONSULTATION });
    expect(first.spec.agent.slug).toBe(second.spec.agent.slug);
    expect(agents.resolve.mock.calls[0]).toEqual(agents.resolve.mock.calls[1]);
  });
});

describe('TASK-1004 — resolveChainFormats: the engine chain the catalog judges, without credentials', () => {
  it('primary first, then the model fallback chain; no credential or consultation read', async () => {
    const formats = await make().resolveChainFormats({ tenantId: TENANT, agentSlug: 'platform-transcription' });
    expect(formats).toEqual({ agentSlug: asrAgent.slug, formats: ['WHISPER_CPP', 'FASTER_WHISPER'] });
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(consultations.findById).not.toHaveBeenCalled();
    expect(agents.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ agentSlug: 'platform-transcription', task: AgentTask.SPEECH_TO_TEXT, departmentId: null }),
    );
  });

  it('no slug → the tenant assignment cascade names the agent', async () => {
    await make().resolveChainFormats({ tenantId: TENANT, agentSlug: null });
    expect(agents.resolve).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: null, departmentId: null }));
  });
});
