/**
 * TASK-1019 final review C1 — the lifecycle collaborator must be INJECTABLE,
 * not merely constructible.
 *
 * Every other AiModelService unit test builds the service BY POSITION, which
 * proves nothing about Nest DI. At runtime Nest resolves a constructor param
 * from `design:paramtypes` (what `tsc` emits) overridden by any explicit
 * `@Inject(token)`. A param typed `Pick<ModelLifecycleService, 'forRows'>`
 * emits `Object`; with `@Optional()` and no `@Inject`, Nest then silently
 * injects `undefined` and no row ever carries `lifecycle`.
 *
 * This package's vitest runs with `emitDecoratorMetadata: false`, so the test
 * reproduces the PRODUCTION metadata: it transpiles the real source file with
 * the Nest tsconfig's decorator options and defines the `design:paramtypes`
 * `tsc` would emit, then compiles a real Nest testing module.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelRepository,
  CoreDatabaseService,
  ModelTaskType,
  ResourceStatusType,
  SYSTEM_TENANT_ID,
  TenantRepository,
} from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';
import { ModelLifecycleService } from '../lifecycle/model-lifecycle.service';

/** The runtime values a `design:paramtypes` guard can resolve to; anything else (an interface, `Pick`) is `Object`. */
const RUNTIME_CLASSES: Record<string, unknown> = {
  AiModelRepository,
  CoreDatabaseService,
  EventEmitter2,
  ClsService,
  TenantRepository,
  ModelLifecycleService,
};

/** The constructor `design:paramtypes` that `tsc` (emitDecoratorMetadata) emits for AiModelService. */
function productionParamTypes(): unknown[] {
  const source = readFileSync(join(__dirname, '..', 'aiModel.service.ts'), 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2021,
    },
  }).outputText;
  const decorate = out.slice(out.lastIndexOf('exports.AiModelService = AiModelService'));
  const match = /__metadata\("design:paramtypes", \[(.*)\]\)/.exec(decorate);
  if (!match) throw new Error('no design:paramtypes emitted for AiModelService');
  const entries = match[1].split(/,\s*(?=typeof \(|Object\b)/);
  return entries.map((entry) => {
    const guarded = /typeof \(_\w+ = typeof (?:\w+\.)?(\w+) !==/.exec(entry);
    const name = guarded ? guarded[1] : entry.trim().replace(/^\w+\./, '');
    return RUNTIME_CLASSES[name] ?? Object;
  });
}

function row(id: string) {
  return {
    id,
    tenantId: SYSTEM_TENANT_ID,
    name: id,
    slug: id,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    availability: AiModelAvailability.AVAILABLE,
    servedBy: 'nlp',
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: null,
    tags: [],
  };
}

describe('AiModelService — Nest DI wiring of the trailing @Optional collaborators', () => {
  it('resolves ModelLifecycleService through the container and a list read uses it', async () => {
    const paramTypes = productionParamTypes();
    expect(paramTypes).toHaveLength(8);
    Reflect.defineMetadata('design:paramtypes', paramTypes, AiModelService);

    const forRows = vi.fn(async (rows: Array<{ id: string }>) => new Map(rows.map((r) => [r.id, { status: 'SERVING', services: [] }])));
    const tenantRepository = { findById: vi.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiModelService,
        { provide: ModelLifecycleService, useValue: { forRows } },
        {
          provide: AiModelRepository,
          useValue: { findAll: vi.fn().mockResolvedValue([row('a')]), count: vi.fn().mockResolvedValue(1) },
        },
        { provide: 'CORE_DATABASE_SERVICE', useValue: { baseClient: {} } },
        { provide: EventEmitter2, useValue: { emit: vi.fn() } },
        {
          provide: ClsService,
          useValue: { get: vi.fn((key: string) => (key === 'user' ? { id: 'u', roles: ['SUPER_ADMIN'] } : null)), set: vi.fn() },
        },
        { provide: TenantRepository, useValue: tenantRepository },
      ],
    }).compile();

    const svc = moduleRef.get(AiModelService);
    const internals = svc as unknown as { lifecycle?: unknown; tenantRepository?: unknown };
    expect(internals.lifecycle, 'lifecycle collaborator was not injected').toBeDefined();
    expect(internals.tenantRepository, 'tenant repository was not injected').toBe(tenantRepository);

    const page = await svc.list({ page: 1, limit: 10 });
    expect(forRows).toHaveBeenCalledTimes(1);
    expect(page.data[0].lifecycle?.status).toBe('SERVING');
  });
});
