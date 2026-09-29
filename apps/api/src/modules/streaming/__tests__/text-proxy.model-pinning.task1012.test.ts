/**
 * TASK-1012 L-3 / D-1 — on the BUSINESS plane a text model is selected only through an Agent.
 *
 * `POST text-generations/generate[/assembled]` used to accept a caller `provider` + `model` and
 * forward them verbatim — the agent cascade ran only when `model` was absent. That is a caller
 * picking an engine, which the agent/workflow architecture removed everywhere else. Now:
 *
 *   - business plane: `provider` / `model` → 400 `MODEL_PINNING_NOT_ALLOWED`; selection is an
 *     explicit `agentSlug` or the TEXT_GENERATION assignment cascade;
 *   - admin plane (`admin/text-generations/*`, the platform LLM playground): raw pinning survives
 *     for a SUPER ADMIN only, through the SAME proxy code path.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { API_KEY_FORBIDDEN, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_FORBIDDEN } from '@arcaai/applications';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextGenerationAdminController } from '../text-generation-admin.controller';
import { MODEL_PINNING_NOT_ALLOWED, TextProxyController } from '../text-proxy.controller';

const SELECTED = { provider: 'vllm', model: 'medgemma-27b' };

function build(roles: string[] = []) {
  const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { content: 'ok' } }), get: vi.fn() } };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant-abc';
      if (key === 'user') return { id: 'user-1', roles };
      return undefined;
    }),
    getId: vi.fn(() => 'req-1'),
  };
  const selection = { resolveTextSelection: vi.fn().mockResolvedValue(SELECTED) };
  const proxy = new TextProxyController(
    http as any,
    { fetchByCodeName: vi.fn() } as any,
    cls as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { getObject: vi.fn() } as any,
    { getConfigValue: vi.fn(() => 'http://localhost:8862') } as any,
    undefined, // secretsService
    selection as any, // HarnessPolicyService
  );
  const admin = new TextGenerationAdminController({ get: vi.fn(() => proxy) } as any, cls as any);
  return { proxy, admin, http, selection };
}

const forwarded = (http: ReturnType<typeof build>['http']) => http.axiosRef.post.mock.calls[0][1];

async function refusal(promise: Promise<unknown>): Promise<BadRequestException> {
  const thrown = await promise.catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(BadRequestException);
  return thrown as BadRequestException;
}

beforeEach(() => vi.clearAllMocks());

describe('business plane — text-generations/generate[/assembled] refuses caller model pinning', () => {
  it.each([
    ['provider', { provider: 'azure-openai' }],
    ['model', { model: 'gpt-4o' }],
    ['provider + model', { provider: 'azure-openai', model: 'gpt-4o' }],
  ])('generate: %s → 400 MODEL_PINNING_NOT_ALLOWED, nothing resolved or forwarded', async (_label, pin) => {
    const { proxy, http, selection } = build();

    const err = await refusal(proxy.generate({ prompt: 'p', stream: false, ...pin } as any));

    expect((err.getResponse() as { code?: string }).code).toBe(MODEL_PINNING_NOT_ALLOWED);
    expect(selection.resolveTextSelection).not.toHaveBeenCalled();
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('generate/assembled: provider/model → 400 MODEL_PINNING_NOT_ALLOWED', async () => {
    const { proxy, http } = build();

    const err = await refusal(proxy.generateAssembled({ type: 'summary', message: 'hello', provider: 'lm-studio', model: 'qwen3.5-4b' } as any));

    expect((err.getResponse() as { code?: string }).code).toBe(MODEL_PINNING_NOT_ALLOWED);
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('an explicit agentSlug selects the agent, and is not forwarded to TEXT', async () => {
    const { proxy, http, selection } = build();

    await proxy.generate({ prompt: 'p', stream: false, agentSlug: 'clinic-summarizer' } as any);

    expect(selection.resolveTextSelection).toHaveBeenCalledWith('tenant-abc', 'finalize', null, 'clinic-summarizer');
    const body = forwarded(http);
    expect(body).toMatchObject(SELECTED);
    expect('agentSlug' in body).toBe(false);
  });

  it('generate/assembled honours an explicit agentSlug too', async () => {
    const { proxy, http, selection } = build();
    http.axiosRef.post.mockResolvedValue({ data: { task_id: 't', status: 'completed', content: 'ok' } });

    await proxy.generateAssembled({ type: 'summary', message: 'hello', agentSlug: 'clinic-summarizer' } as any);

    expect(selection.resolveTextSelection).toHaveBeenCalledWith('tenant-abc', 'finalize', null, 'clinic-summarizer');
    expect(forwarded(http)).toMatchObject(SELECTED);
  });

  it('no selector at all → the TEXT_GENERATION assignment cascade', async () => {
    const { proxy, http, selection } = build();

    await proxy.generate({ prompt: 'p', stream: false } as any);

    expect(selection.resolveTextSelection).toHaveBeenCalledWith('tenant-abc', 'finalize', null, undefined);
    expect(forwarded(http)).toMatchObject(SELECTED);
  });
});

describe('admin plane — admin/text-generations/* keeps raw pinning for the platform LLM playground', () => {
  it('is an admin controller closed to API keys and service accounts, pinned to manage:all', () => {
    const reflector = new Reflector();
    expect(Reflect.getMetadata(PATH_METADATA, TextGenerationAdminController)).toBe('admin/text-generations');
    expect(reflector.get(API_KEY_FORBIDDEN, TextGenerationAdminController)).toBe(true);
    expect(reflector.get(SERVICE_ACCOUNT_FORBIDDEN, TextGenerationAdminController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, TextGenerationAdminController)).toEqual([{ action: 'manage', subject: 'all' }]);
  });

  it('a SUPER ADMIN pins provider + model and they reach TEXT untouched', async () => {
    const { admin, http, selection } = build(['SUPER_ADMIN']);

    await admin.generate({ prompt: 'p', stream: false, provider: 'azure-openai', model: 'gpt-4o' } as any);

    expect(selection.resolveTextSelection).not.toHaveBeenCalled();
    expect(forwarded(http)).toMatchObject({ provider: 'azure-openai', model: 'gpt-4o' });
  });

  it('a SUPER ADMIN pins provider + model on the assembled route too', async () => {
    const { admin, http } = build(['SUPER_ADMIN']);
    http.axiosRef.post.mockResolvedValue({ data: { task_id: 't', status: 'completed', content: 'ok' } });

    await admin.generateAssembled({ type: 'summary', message: 'hello', provider: 'lm-studio', model: 'qwen3.5-4b' } as any);

    expect(forwarded(http)).toMatchObject({ provider: 'lm-studio', model: 'qwen3.5-4b' });
  });

  it.each([['generate'], ['generateAssembled']] as const)('%s: a TENANT ADMIN is refused with 403 and nothing is forwarded', async (method) => {
    const { admin, http } = build(['TENANT_ADMIN']);
    const body = method === 'generate' ? { prompt: 'p', provider: 'ollama', model: 'm' } : { type: 'summary', message: 'x', provider: 'ollama', model: 'm' };

    await expect((admin as any)[method](body)).rejects.toBeInstanceOf(ForbiddenException);
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
});
