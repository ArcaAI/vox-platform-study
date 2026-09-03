/**
 * the platform-wide API-key surface invariant.
 *
 * `UnifiedAuthGuard` now DENIES an API-key caller on any route that declares no
 * `@RequiredScopes(...)`. This audit is the static half of that rule: at boot,
 * every route that an API key could reach must EXPLICITLY declare what an API
 * key may do there (`@RequiredScopes`) or explicitly refuse them
 * (`@ForbidApiKey`). A route that declares neither is not "safe by default" —
 * it is undeclared, and the boot fails so the omission is fixed at authoring
 * time rather than discovered as a 403 in production.
 *
 * This deliberately supersedes the hand-listed coverage of
 * `SDK_DAY1_SCOPED_ROUTES` / `ADMIN_SCOPED_CONTROLLERS` in reach: those two
 * audits pin that a SPECIFIC named surface keeps a SPECIFIC gate (a
 * regression guard against a value drifting), while this one pins that NO
 * route anywhere is left undeclared (a coverage guard). Both are wanted; only
 * this one scales to routes nobody remembered to add to a list.
 */
import { describe, it, expect } from 'vitest';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { Authorize, ForbidApiKey, Public, RequiredScopes, UnifiedAuthGuard } from '@arcaai/applications';

import { auditEveryApiKeyReachableRouteDeclaresScopes } from '../api-key-surface-audit';
import { TranscriptionJobController } from '../../modules/streaming/transcription-job.controller';
import { SpeechProxyController } from '../../modules/speech/speech-proxy.controller';
import { SttCompatController } from '../../modules/stt-compat/stt-compat.controller';
import { MyTenantController } from '../../modules/tenant/my-tenant.controller';
import { AuthController } from '../../modules/auth/auth.controller';

async function buildAppFromControllers(controllers: Array<new (...args: unknown[]) => unknown>) {
  @Module({ controllers })
  class _SyntheticModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [_SyntheticModule] })
    .overrideGuard(UnifiedAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return moduleRef as unknown as Parameters<typeof auditEveryApiKeyReachableRouteDeclaresScopes>[0];
}

/** Same shortcut the sibling audit tests use: real metadata, no DI graph. */
function buildFakeAppFromRealControllers(
  controllers: Array<new (...args: never[]) => unknown>,
): Parameters<typeof auditEveryApiKeyReachableRouteDeclaresScopes>[0] {
  const wrappers = controllers.map((ControllerClass) => ({
    metatype: ControllerClass,
    instance: Object.create(ControllerClass.prototype) as Record<string, unknown>,
  }));
  const modulesContainer = new Map([['synthetic', { controllers: new Map(wrappers.map((w, i) => [i, w])) }]]);
  const reflector = new Reflector();

  return {
    get: (token: unknown) => {
      if (token === ModulesContainer) return modulesContainer;
      if (token === Reflector) return reflector;
      throw new Error(`unexpected token: ${String(token)}`);
    },
  } as unknown as Parameters<typeof auditEveryApiKeyReachableRouteDeclaresScopes>[0];
}

describe('boot-time API-key surface audit ', () => {
  /**
   * The three surfaces the gateway conformance review named as reachable with
   * NO authorization check — `transcription-job`, `stt-compat`,
   * `speech-proxy`), plus one of each closure mechanism. Uses the REAL
   * production classes: a synthetic controller can only prove the audit's
   * logic, this proves the tree actually satisfies it.
 */
  it('passes against the real controllers this ticket closed', () => {
    const app = buildFakeAppFromRealControllers([
      TranscriptionJobController,
      SttCompatController,
      SpeechProxyController,
      MyTenantController,
      AuthController,
    ]);

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(app)).not.toThrow();
  });

  it('passes a route that declares a scope', async () => {
    @Controller('things')
    class Scoped {
      @Get()
      @Authorize(['read', 'Tenant'])
      @RequiredScopes('admin:tenant:read')
      list() {}
    }

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([Scoped]))).not.toThrow();
  });

  it('passes a route that explicitly refuses API keys', async () => {
    @Controller('things')
    class Forbidden {
      @Post()
      @Authorize(['manage', 'all'])
      @ForbidApiKey()
      impersonate() {}
    }

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([Forbidden]))).not.toThrow();
  });

  it('passes a @Public() route — auth never runs, so there is nothing to declare', async () => {
    @Controller('things')
    class PublicOnly {
      @Get()
      @Public()
      health() {}
    }

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([PublicOnly]))).not.toThrow();
  });

  it('accepts a CLASS-level declaration for every method in the class', async () => {
    @Controller('things')
    @RequiredScopes('admin:tenant:write')
    class ClassScoped {
      @Get()
      a() {}
      @Post()
      b() {}
    }

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([ClassScoped]))).not.toThrow();
  });

  it('FAILS a non-public route that declares neither scopes nor @ForbidApiKey', async () => {
    @Controller('things')
    class Undeclared {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([Undeclared]))).toThrow(
      /Undeclared\.list[\s\S]*@RequiredScopes[\s\S]*@ForbidApiKey/,
    );
  });

  it('FAILS an undeclared route even when it carries a bare @Authorize() (auth-only is not a declaration)', async () => {
    @Controller('things')
    class BareAuth {
      @Get()
      @Authorize()
      list() {}
    }

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([BareAuth]))).toThrow(/BareAuth\.list/);
  });

  it('treats an EMPTY @RequiredScopes() as undeclared (it can never be satisfied)', async () => {
    @Controller('things')
    class EmptyScopes {
      @Get()
      @RequiredScopes()
      list() {}
    }

    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([EmptyScopes]))).toThrow(/EmptyScopes\.list/);
  });

  it('lists every offender in one error rather than failing on the first', async () => {
    @Controller('a')
    class OffenderA {
      @Get()
      one() {}
    }
    @Controller('b')
    class OffenderB {
      @Get()
      two() {}
    }

    let message = '';
    try {
      auditEveryApiKeyReachableRouteDeclaresScopes(buildFakeAppFromRealControllers([OffenderA, OffenderB]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/OffenderA\.one/);
    expect(message).toMatch(/OffenderB\.two/);
    expect(message).toMatch(/2 route\(s\)/);
  });

  it('works through a real compiled Nest module too (not just the fake container)', async () => {
    @Controller('real')
    class RealUndeclared {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    const app = await buildAppFromControllers([RealUndeclared]);
    expect(() => auditEveryApiKeyReachableRouteDeclaresScopes(app)).toThrow(/RealUndeclared\.list/);
  });
});
