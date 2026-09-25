import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';

/**
 * TASK-1006 (owner OD-2) — the pre-agent ASR stack is REMOVED, not deprecated: the
 * `AsrPipeline` catalogue (`admin/audio/pipelines/**`, `audio/pipelines/**`), the SYSTEM-template
 * resync (`POST admin/tenants/:id/pipelines/resync` + its cron), and the tenant-wide
 * `TenantSttConfig` surface (`admin/stt-config/**`). Selection is `agentSlug` →
 * `AsrAgentResolverService` → `ResolvedAsrSpec` only, so every one of those routes answers 404.
 *
 * Two independent checks, so a re-add cannot slip past either: a SOURCE scan over every
 * controller file (catches a new controller in any module), and REFLECTION over the controllers
 * the modules that used to host this stack actually register (catches a route mounted under a
 * path built at runtime).
 */

const SRC = join(__dirname, '..');
const MODULES_DIR = join(SRC, 'modules');

/** Paths no controller may serve any more. */
const RETIRED_PATH = /(^|\/)(admin\/audio\/pipelines|audio\/pipelines|admin\/stt-config)(\/|$)|pipelines\/resync/;

function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...listControllerFiles(full));
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `(controller path, handler path)` a Nest controller class mounts. */
function mountedPaths(controller: new (...args: never[]) => unknown): string[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const proto = controller.prototype as Record<string, unknown>;
  const paths = [base];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name];
    if (typeof handler !== 'function') continue;
    const sub = Reflect.getMetadata(PATH_METADATA, handler);
    if (sub === undefined) continue;
    for (const segment of Array.isArray(sub) ? sub : [sub]) {
      paths.push(`${base}/${String(segment)}`.replace(/\/+/g, '/'));
    }
  }
  return paths;
}

describe('TASK-1006 — the pre-agent ASR stack is gone from the gateway', () => {
  it('the pipeline and tenant-stt-config modules, the resync controller and the pipelineId deprecation helper no longer exist', () => {
    const retired = [
      join(MODULES_DIR, 'pipeline'),
      join(MODULES_DIR, 'tenant-stt-config'),
      join(MODULES_DIR, 'tenant', 'tenant-pipeline-resync.controller.ts'),
      join(SRC, 'common', 'pipeline-id-deprecation.ts'),
    ];
    expect(retired.filter((path) => existsSync(path))).toEqual([]);
  });

  it('no controller source anywhere in apps/api declares a pipeline, stt-config or resync route', () => {
    const offenders: string[] = [];
    for (const file of listControllerFiles(MODULES_DIR)) {
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(/@(?:Controller|Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]+)['"]/g)) {
        if (RETIRED_PATH.test(match[1])) offenders.push(`${file}: '${match[1]}'`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no gateway source still marks or reads a pipelineId deprecation', () => {
    const offenders = listControllerFiles(MODULES_DIR).filter((file) =>
      /markPipelineIdDeprecated|pipeline-id-deprecation/.test(readFileSync(file, 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the modules that hosted the stack register no controller mounting a retired path (reflection)', async () => {
    const [{ TenantModule }, { StreamingModule }, { UserModule }, { InternalModule }] = await Promise.all([
      import('../modules/tenant/tenant.module'),
      import('../modules/streaming/streaming.module'),
      import('../modules/user/user.module'),
      import('../modules/internal/internal.module'),
    ]);
    const offenders: string[] = [];
    for (const module of [TenantModule, StreamingModule, UserModule, InternalModule]) {
      const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ?? []) as Array<new (...args: never[]) => unknown>;
      expect(controllers.length, `${module.name} registers controllers`).toBeGreaterThan(0);
      for (const controller of controllers) {
        for (const path of mountedPaths(controller)) {
          if (RETIRED_PATH.test(path)) offenders.push(`${module.name} → ${controller.name}: ${path}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no module imports the retired application modules', async () => {
    const [{ TenantModule }, { StreamingModule }, { UserModule }] = await Promise.all([
      import('../modules/tenant/tenant.module'),
      import('../modules/streaming/streaming.module'),
      import('../modules/user/user.module'),
    ]);
    const names = [TenantModule, StreamingModule, UserModule].flatMap((module) =>
      ((Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? []) as Array<{ name?: string }>).map(
        (imported) => `${module.name} → ${imported?.name}`,
      ),
    );
    expect(names.filter((name) => /PipelineServiceModule|TenantSttConfigServiceModule/.test(name))).toEqual([]);
  });
});
