/**
 * TASK-758 — policy A1 as a boot-time contract.
 *
 * A1: a non-`admin` (business) route carries the auth model **JWT + API key**,
 * so an integrator holding a scoped tenant key can drive the platform's
 * business capabilities without a human session. The counterpart A2
 * (`admin/*` ⇒ JWT only) is TASK-757's and is deliberately NOT checked here.
 *
 * The interesting half is the exception. Applying A1 blanket would open a
 * clinician's voice biometrics and personal writing model to a long-lived
 * static credential, so A1 ships as default-convert with a NARROW, NAMED
 * exemption list. This spec pins that list and pins that it is POLICED: a
 * business-plane controller may keep `@ForbidApiKey()` only by being named in
 * `BUSINESS_PLANE_KEY_FORBIDDEN` (or, temporarily, in the TASK-759 deferral
 * set) — otherwise the boot fails, exactly as an undeclared route does under
 * TASK-742's `auditEveryApiKeyReachableRouteDeclaresScopes`.
 *
 * Same shape as `RESERVED_INTERNAL_SCOPE_CONTROLLERS`
 * (`api-key-scope-audit.ts`): an exemption that must justify itself in code,
 * not a hole.
 */
import { describe, it, expect } from 'vitest';
import { Controller, Get, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { API_KEY_REQUIRED_SCOPES, Authorize, ForbidApiKey, Public, REQUIRED_PERMISSIONS_KEY, RequiredScopes } from '@arcaai/applications';

import {
  auditBusinessPlaneApiKeyExemptions,
  BUSINESS_PLANE_KEY_FORBIDDEN,
  BUSINESS_PLANE_KEY_FORBIDDEN_DEFERRED,
} from '../business-plane-apikey-exemptions-audit';

import { AuthController } from '../../modules/auth/auth.controller';
import { VoiceProfileController } from '../../modules/voice-profile/voice-profile.controller';
import { DnaWritingStyleController } from '../../modules/dna-writing-style/dna-writing-style.controller';
import { MyTenantController } from '../../modules/tenant/my-tenant.controller';
import { MyBillingController } from '../../modules/billing/my-billing.controller';
import { MyUsageController } from '../../modules/admin-usage/my-usage.controller';
import { MyEntitlementsController } from '../../modules/entitlements/my-entitlements.controller';
import { ChangelogController } from '../../modules/changelog/changelog.controller';
import { AiInferenceController } from '../../modules/ai-inference/ai-inference.controller';
import { PromptTemplateController } from '../../modules/prompt-management/prompt-template.controller';
import { AudioPipelinePublicController } from '../../modules/pipeline/audio-pipeline-public.controller';
import { PermissionCheckController } from '../../modules/rbac/permission-check.controller';
import { UserSettingsController } from '../../modules/user/controllers/user-settings.controller';
import { UserDepartmentsMeController } from '../../modules/user/controllers/user-departments-me.controller';
import { UserRolesController } from '../../modules/user/controllers/user-roles.controller';
import { MyTenantContextSchemaController } from '../../modules/consultation-context-schema/consultation-context-schema.controller';
import { ConsentGrantController } from '../../modules/consent/consent.controller';
import { AdminImpersonationController } from '../../modules/auth/admin-impersonation.controller';

/** Same shortcut the sibling audit tests use: real metadata, no DI graph. */
function buildFakeAppFromRealControllers(
  controllers: Array<new (...args: never[]) => unknown>,
): Parameters<typeof auditBusinessPlaneApiKeyExemptions>[0] {
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
  } as unknown as Parameters<typeof auditBusinessPlaneApiKeyExemptions>[0];
}

describe('business-plane API-key exemption audit (TASK-758, policy A1)', () => {
  it('names exactly the three reasoned exemptions', () => {
    expect(BUSINESS_PLANE_KEY_FORBIDDEN).toEqual(new Set(['AuthController', 'VoiceProfileController', 'DnaWritingStyleController']));
  });

  /**
   * `MonitoringController` and `ApiHealthController` are administrative
   * capabilities sitting on business prefixes (`/monitoring`, `/health`) —
   * they are not business routes at all, and TASK-759 moves them. Tracked in
   * their OWN set so "deferred to another ticket" is never mistaken for "we
   * reasoned about this and chose to exempt it".
   */
  it('tracks the TASK-759 deferrals separately from the reasoned exemptions', () => {
    expect(BUSINESS_PLANE_KEY_FORBIDDEN_DEFERRED).toEqual(new Set(['MonitoringController', 'ApiHealthController']));
    for (const name of BUSINESS_PLANE_KEY_FORBIDDEN_DEFERRED) {
      expect(BUSINESS_PLANE_KEY_FORBIDDEN.has(name), `${name} is a deferral, not a reasoned exemption`).toBe(false);
    }
  });

  it('passes against the three real exempt controllers', () => {
    expect(() =>
      auditBusinessPlaneApiKeyExemptions(buildFakeAppFromRealControllers([AuthController, VoiceProfileController, DnaWritingStyleController])),
    ).not.toThrow();
  });

  /**
   * The whole CONVERT set, as production classes. A synthetic controller can
   * only prove the audit's logic; this proves the tree actually satisfies A1.
   */
  it('passes against all 13 converted business controllers', () => {
    expect(() =>
      auditBusinessPlaneApiKeyExemptions(
        buildFakeAppFromRealControllers([
          AiInferenceController,
          PromptTemplateController,
          AudioPipelinePublicController,
          ChangelogController,
          MyBillingController,
          MyTenantController,
          PermissionCheckController,
          MyUsageController,
          UserSettingsController,
          MyEntitlementsController,
          MyTenantContextSchemaController,
          UserDepartmentsMeController,
          UserRolesController,
        ]),
      ),
    ).not.toThrow();
  });

  it('ignores the admin plane — A2 (TASK-757) owns @ForbidApiKey() under admin/', () => {
    expect(() =>
      auditBusinessPlaneApiKeyExemptions(buildFakeAppFromRealControllers([ConsentGrantController, AdminImpersonationController])),
    ).not.toThrow();
  });

  it('FAILS an unlisted business-plane controller that keeps @ForbidApiKey()', () => {
    @Controller('widgets')
    @ForbidApiKey()
    class UnlistedBusinessController {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    expect(() => auditBusinessPlaneApiKeyExemptions(buildFakeAppFromRealControllers([UnlistedBusinessController]))).toThrow(
      /business-plane[\s\S]*@ForbidApiKey/,
    );
  });

  it('FAILS a method-level @ForbidApiKey() on an otherwise-scoped business controller', () => {
    @Controller('widgets')
    @RequiredScopes('tenant:profile:read')
    class PartiallyForbidden {
      @Get()
      list() {}

      @Post()
      @ForbidApiKey()
      create() {}
    }

    expect(() => auditBusinessPlaneApiKeyExemptions(buildFakeAppFromRealControllers([PartiallyForbidden]))).toThrow(/PartiallyForbidden\.create/);
  });

  it('passes a scoped business controller (the A1 shape)', () => {
    @Controller('widgets')
    @RequiredScopes('tenant:profile:read')
    class Scoped {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    expect(() => auditBusinessPlaneApiKeyExemptions(buildFakeAppFromRealControllers([Scoped]))).not.toThrow();
  });

  it('ignores @Public() routes — authentication never runs, so A1 has nothing to say', () => {
    @Controller('widgets')
    class PublicProbe {
      @Get()
      @Public()
      @ForbidApiKey()
      probe() {}
    }

    expect(() => auditBusinessPlaneApiKeyExemptions(buildFakeAppFromRealControllers([PublicProbe]))).not.toThrow();
  });

  it('lists every offender in one error rather than failing on the first', () => {
    @Controller('a')
    @ForbidApiKey()
    class OffenderA {
      @Get()
      one() {}
    }
    @Controller('b')
    @ForbidApiKey()
    class OffenderB {
      @Get()
      two() {}
    }

    let message = '';
    try {
      auditBusinessPlaneApiKeyExemptions(buildFakeAppFromRealControllers([OffenderA, OffenderB]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/OffenderA\.one/);
    expect(message).toMatch(/OffenderB\.two/);
    expect(message).toMatch(/2 route\(s\)/);
  });
});

/**
 * The VALUE half. The audit above only proves a business controller stopped
 * forbidding keys; this pins WHICH scope each one now declares, so a later
 * "just widen it a bit" edit shows up as a failing test naming the controller.
 *
 * Same posture as `ADMIN_SCOPED_CONTROLLERS` (`admin-scope-audit.ts`) for the
 * admin plane, and read the same way: CLASS-level metadata, because A1 follows
 * TASK-708 Task 4's coarse-grained "one scope per controller" convention. The
 * two exceptions are the mutating handlers, which narrow to a `:write` scope
 * at the METHOD level — `getAllAndOverride([handler, class])` means the method
 * declaration wins, so a read-only key cannot reach them.
 */
describe('the converted business controllers declare the scope A1 assigned them', () => {
  const reflector = new Reflector();
  const classScope = (ControllerClass: new (...args: never[]) => unknown) =>
    reflector.get<string[]>(API_KEY_REQUIRED_SCOPES, ControllerClass as never);

  const expected: Array<[string, new (...args: never[]) => unknown, string]> = [
    ['AiInferenceController', AiInferenceController, 'ai:inference:write'],
    ['PromptTemplateController', PromptTemplateController, 'prompt:template:read'],
    ['AudioPipelinePublicController', AudioPipelinePublicController, 'stt:model:read'],
    ['ChangelogController', ChangelogController, 'platform:changelog:read'],
    ['MyBillingController', MyBillingController, 'tenant:account:read'],
    ['MyUsageController', MyUsageController, 'tenant:account:read'],
    ['MyEntitlementsController', MyEntitlementsController, 'tenant:account:read'],
    ['MyTenantController', MyTenantController, 'tenant:profile:read'],
    ['MyTenantContextSchemaController', MyTenantContextSchemaController, 'tenant:context-schema:read'],
    ['PermissionCheckController', PermissionCheckController, 'user:profile:read'],
    ['UserDepartmentsMeController', UserDepartmentsMeController, 'user:profile:read'],
    ['UserRolesController', UserRolesController, 'user:profile:read'],
    ['UserSettingsController', UserSettingsController, 'user:settings:read'],
  ];

  it.each(expected)('%s is gated by %s', (_name, ControllerClass, scope) => {
    expect(classScope(ControllerClass)).toEqual([scope]);
  });

  it('narrows the two mutating handlers to a :write scope at the method level', () => {
    const methodScope = (ControllerClass: { prototype: Record<string, unknown> }, method: string) =>
      reflector.get<string[]>(API_KEY_REQUIRED_SCOPES, ControllerClass.prototype[method] as never);

    // PATCH /tenant/me/config — the one `update:Tenant` route on an otherwise
    // read-only self-service controller.
    expect(methodScope(MyTenantController as never, 'updateMyConfig')).toEqual(['tenant:profile:write']);
    // PATCH /user/me/settings/:namespace/:key
    expect(methodScope(UserSettingsController as never, 'updateSetting')).toEqual(['user:settings:write']);
  });

  it('leaves the CASL declarations untouched — scope and ability are a conjunction, never a substitution', () => {
    const permissions = (ControllerClass: { prototype: Record<string, unknown> }, method: string) =>
      reflector.get(REQUIRED_PERMISSIONS_KEY, ControllerClass.prototype[method] as never);

    expect(permissions(MyTenantController as never, 'updateMyConfig')).toEqual([{ action: 'update', subject: 'Tenant' }]);
    expect(permissions(MyBillingController as never, 'listMine')).toEqual([{ action: 'read', subject: 'Tenant' }]);
    expect(permissions(PromptTemplateController as never, 'available')).toEqual([{ action: 'read', subject: 'PromptTemplate' }]);
  });
});

/**
 * Step 6 of the plan: the exemptions keep their gate, and each states a
 * DECISION rather than TASK-742's deferral boilerplate.
 *
 * Marker convention (owner decision, 2026-08-18): `API-KEY-NOTE` and
 * `AUTH-NOTE` stay DISTINCT and nothing migrates between them.
 * `API-KEY-NOTE` = the API-key classification; `AUTH-NOTE` = rule 05's
 * "the decorator understates the real gate" case. So the assertion below is
 * that the boilerplate is GONE and a real `API-KEY-NOTE` reason is present —
 * not that the marker changed.
 */
describe('the three exemptions carry a decision, not the TASK-742 deferral', () => {
  const files: Array<[string, string]> = [
    ['AuthController', 'src/modules/auth/auth.controller.ts'],
    ['VoiceProfileController', 'src/modules/voice-profile/voice-profile.controller.ts'],
    ['DnaWritingStyleController', 'src/modules/dna-writing-style/dna-writing-style.controller.ts'],
  ];

  it.each(files)('%s carries an API-KEY-NOTE stating the decision', async (_name, relative) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), relative), 'utf8');

    expect(source).toContain('// API-KEY-NOTE');
    expect(source).not.toContain('AWAITING OWNER CLASSIFICATION');
    expect(source).toContain('@ForbidApiKey()');
  });
});
