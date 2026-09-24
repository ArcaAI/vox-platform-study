/**
 * TASK-1004 §4.4/§4.5 — per-agent language capability: the catalog for an agent's ENGINE CHAIN
 * (primary first) with a strong ETag and a short tenant-keyed cache, and the configuration-time
 * WARNINGS for an ASR agent whose PRIMARY engine degrades or cannot serve a mode. Warnings never
 * block and never re-route (OD-6); the agent is resolved exactly as it would be for a session.
 */
import { HttpException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrLanguageCapabilityService } from '../asr-language-capability.service';

const mode = (id: string, levels?: Record<string, string>) => ({
  id,
  label: id,
  kind: id === 'auto' ? 'auto' : id.includes('-') ? 'code_switch' : 'single',
  primaryLanguage: null,
  secondaryLanguage: null,
  supportedEngines: [],
  ...(levels ? { levels, effective: Object.values(levels).find((l) => l !== 'unsupported') ?? 'unsupported' } : {}),
});

const CHAIN_CATALOG = {
  modes: [
    mode('en', { WHISPER_CPP: 'native', SARVAM: 'native' }),
    mode('ml', { WHISPER_CPP: 'native', SARVAM: 'native' }),
    mode('ml-en', { WHISPER_CPP: 'degraded', SARVAM: 'native' }),
    mode('vi', { WHISPER_CPP: 'native', SARVAM: 'unsupported' }),
    mode('vi-en', { WHISPER_CPP: 'degraded', SARVAM: 'unsupported' }),
    mode('auto', { WHISPER_CPP: 'native', SARVAM: 'native' }),
  ],
};
const WIDE_CATALOG = { modes: ['en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto'].map((id) => mode(id)) };

let sessions: { getLanguageModes: ReturnType<typeof vi.fn>; fetchLanguageModes: ReturnType<typeof vi.fn> };
let resolver: { resolveChainFormats: ReturnType<typeof vi.fn> };
const make = () => new AsrLanguageCapabilityService(sessions as never, resolver as never);

beforeEach(() => {
  sessions = { getLanguageModes: vi.fn().mockResolvedValue(WIDE_CATALOG), fetchLanguageModes: vi.fn().mockResolvedValue(CHAIN_CATALOG) };
  resolver = { resolveChainFormats: vi.fn().mockResolvedValue({ agentSlug: 'platform-transcription', formats: ['WHISPER_CPP', 'SARVAM'] }) };
});

describe('catalogFor — per-agent levels, ETag, tenant-keyed cache', () => {
  it('asks STT for the chain’s engines (primary first) and names the agent', async () => {
    const { catalog, etag } = await make().catalogFor('tenant-1', null);
    expect(resolver.resolveChainFormats).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null });
    expect(sessions.fetchLanguageModes).toHaveBeenCalledWith(['WHISPER_CPP', 'SARVAM']);
    expect(catalog).toMatchObject({ agentSlug: 'platform-transcription', engines: ['WHISPER_CPP', 'SARVAM'] });
    expect(catalog.modes.find((m) => m.id === 'ml-en')?.levels).toEqual({ WHISPER_CPP: 'degraded', SARVAM: 'native' });
    expect(etag).toMatch(/^"[0-9a-f]{16,}"$/);
  });

  it('the same representation gives the same ETag; a different one a different ETag', async () => {
    const service = make();
    const a = await service.catalogFor('tenant-1', null);
    const b = await make().catalogFor('tenant-1', null);
    expect(a.etag).toBe(b.etag);
    sessions.fetchLanguageModes.mockResolvedValue({ modes: CHAIN_CATALOG.modes.slice(0, 2) });
    expect((await make().catalogFor('tenant-1', null)).etag).not.toBe(a.etag);
  });

  it('caches per (tenant, agentSlug) — the tenant is part of the key', async () => {
    const service = make();
    await service.catalogFor('tenant-1', 'platform-transcription');
    await service.catalogFor('tenant-1', 'platform-transcription');
    expect(resolver.resolveChainFormats).toHaveBeenCalledTimes(1);
    expect(sessions.fetchLanguageModes).toHaveBeenCalledTimes(1);
    await service.catalogFor('tenant-2', 'platform-transcription');
    expect(resolver.resolveChainFormats).toHaveBeenCalledTimes(2);
    await service.catalogFor('tenant-1', 'other-agent');
    expect(resolver.resolveChainFormats).toHaveBeenCalledTimes(3);
  });

  it('an explicit slug that does not resolve is the resolver’s own refusal (404)', async () => {
    resolver.resolveChainFormats.mockRejectedValue(new NotFoundException('nope'));
    await expect(make().catalogFor('tenant-1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('no slug and no assigned agent → the catalog-wide payload, unchanged', async () => {
    resolver.resolveChainFormats.mockRejectedValue(new HttpException({ code: 'AGENT_NOT_ASSIGNED' }, 404));
    const { catalog } = await make().catalogFor('tenant-1', null);
    expect(catalog).toEqual(WIDE_CATALOG);
    expect(sessions.fetchLanguageModes).not.toHaveBeenCalled();
  });

  it('STT refusing the chain (e.g. an engine it does not know) degrades to the catalog-wide payload', async () => {
    sessions.fetchLanguageModes.mockRejectedValue(new Error('422'));
    const { catalog } = await make().catalogFor('tenant-1', null);
    expect(catalog.modes).toEqual(WIDE_CATALOG.modes);
    expect(catalog).not.toHaveProperty('engines');
  });

  it('an empty answer (STT unreachable) is not cached', async () => {
    sessions.fetchLanguageModes.mockRejectedValue(new Error('down'));
    sessions.getLanguageModes.mockResolvedValue({ modes: [] });
    const service = make();
    await service.catalogFor('tenant-1', null);
    await service.catalogFor('tenant-1', null);
    expect(resolver.resolveChainFormats).toHaveBeenCalledTimes(2);
  });
});

describe('warningsForAgent — configuration-time, never blocking', () => {
  it('whisper.cpp primary: one warning per catalog mode it degrades or cannot serve (auto excluded)', async () => {
    const warnings = await make().warningsForAgent('tenant-1', 'platform-transcription');
    expect(warnings.map((w) => [w.mode, w.level])).toEqual([
      ['ml-en', 'degraded'],
      ['vi-en', 'degraded'],
    ]);
    expect(warnings[0]).toMatchObject({ code: 'LANGUAGE_MODE_DEGRADED', engine: 'WHISPER_CPP', agentSlug: 'platform-transcription' });
    expect(warnings[0]!.message).toContain('ml-en');
  });

  it('judges the PRIMARY only — a native fallback does not hide a degraded primary', async () => {
    resolver.resolveChainFormats.mockResolvedValue({ agentSlug: 'sarvam-agent', formats: ['SARVAM', 'WHISPER_CPP'] });
    const warnings = await make().warningsForAgent('tenant-1', 'sarvam-agent');
    expect(warnings.map((w) => [w.mode, w.code])).toEqual([
      ['vi', 'LANGUAGE_MODE_UNSUPPORTED'],
      ['vi-en', 'LANGUAGE_MODE_UNSUPPORTED'],
    ]);
  });

  it('never throws: a resolver or STT failure yields no warnings', async () => {
    resolver.resolveChainFormats.mockRejectedValue(new Error('boom'));
    await expect(make().warningsForAgent('tenant-1', 'x')).resolves.toEqual([]);
  });
});

describe('warningsForWorkflow — the ASR agent(s) a workflow names', () => {
  const compiled = (slugs: string[]) => ({
    stages: [{ nodes: slugs.map((slug, i) => ({ nodeId: `n${i}`, type: 'core.agent', config: { agentRef: { slug } } })) }],
  });

  it('warns for the SPEECH_TO_TEXT agent a node names; other agents (not ASR) yield nothing', async () => {
    resolver.resolveChainFormats.mockImplementation(async ({ agentSlug }: { agentSlug: string }) => {
      if (agentSlug === 'soap-writer') throw new HttpException('not a SPEECH_TO_TEXT agent', 400);
      return { agentSlug, formats: ['WHISPER_CPP'] };
    });
    const warnings = await make().warningsForWorkflow('tenant-1', compiled(['soap-writer', 'platform-transcription', 'platform-transcription']));
    expect(new Set(warnings.map((w) => w.agentSlug))).toEqual(new Set(['platform-transcription']));
    expect(warnings.map((w) => w.mode)).toEqual(['ml-en', 'vi-en']);
  });

  it('a graph that names no agent yields nothing', async () => {
    expect(await make().warningsForWorkflow('tenant-1', { stages: [] })).toEqual([]);
    expect(await make().warningsForWorkflow('tenant-1', null)).toEqual([]);
  });
});
