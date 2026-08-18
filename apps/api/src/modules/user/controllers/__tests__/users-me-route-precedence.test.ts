/**
 * TASK-760 — the `users/me/**` vs `users/:id/**` collision, pinned.
 *
 * The self plane moved from the singular `user/me/**` into the PLURAL `users`
 * collection, which was already occupied: `UserRolesController` is
 * `@Controller('users')` with the PARAMETER route `@Get(':id/roles')`, and
 * `UserPermissionCheckController` is `@Controller('users/:id/permission-checks')`.
 *
 * Express (and therefore Nest) matches routes in REGISTRATION order and a
 * `:id` parameter happily matches the literal string `me`. So a `users/me/**`
 * route registered AFTER a `users/:id/**` route is dead: the request resolves
 * to the by-id handler with `id === 'me'`, which is not a 404 and not an
 * error — it is a wrong answer, computed against a user whose id is the
 * three-character string "me". That failure mode is silent, which is exactly
 * why it gets its own test instead of being left to import order.
 *
 * These tests drive REAL HTTP through a real Nest app, so they fail if anyone
 * reorders `controllers: [...]` in `rbac.module.ts` or `user.module.ts` — the
 * two arrays that carry the load-bearing ordering comment.
 */
import { Controller, Get, INestApplication, Module, Param, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Stand-ins for the real controllers. The real ones drag in CLS, the policy
 * engine and half the applications package; what is under test here is
 * ROUTING, not their bodies, so the fixtures reproduce the exact paths and
 * nothing else. The paths are asserted against the real controllers'
 * `PATH_METADATA` at the bottom of this file, so a drift in either direction
 * is caught.
 */
@Controller('users/me/permission-checks')
class SelfPermissionChecksFixture {
  @Post()
  self(): { handler: string } {
    return { handler: 'self' };
  }
}

@Controller('users/me/preferences')
class SelfPreferencesFixture {
  @Get()
  self(): { handler: string } {
    return { handler: 'self-preferences' };
  }
}

@Controller('users/:id/permission-checks')
class ByIdPermissionChecksFixture {
  @Post()
  byId(@Param('id') id: string): { handler: string; id: string } {
    return { handler: 'by-id', id };
  }
}

@Controller('users')
class UserRolesFixture {
  @Get(':id/roles')
  roles(@Param('id') id: string): { handler: string; id: string } {
    return { handler: 'roles', id };
  }
}

/** The registration order the real modules use: literals first. */
@Module({
  controllers: [SelfPermissionChecksFixture, SelfPreferencesFixture, ByIdPermissionChecksFixture, UserRolesFixture],
})
class CorrectOrderModule {}

/** The regression: `:id` registered first swallows the literal `me`. */
@Module({
  controllers: [ByIdPermissionChecksFixture, SelfPermissionChecksFixture],
})
class WrongOrderModule {}

async function boot(moduleClass: unknown): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [moduleClass as never] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

describe('TASK-760 — literal `me` beats `:id` under the users collection', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await boot(CorrectOrderModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /users/me/permission-checks reaches the SELF handler, not by-id with id="me"', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/users/me/permission-checks').send({});
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ handler: 'self' });
  });

  it('POST /users/:id/permission-checks still reaches the by-id handler', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/users/1d0b0f1e-0000-4000-8000-000000000001/permission-checks').send({});
    expect(response.body).toEqual({ handler: 'by-id', id: '1d0b0f1e-0000-4000-8000-000000000001' });
  });

  it('GET /users/me/preferences reaches the self handler (a sibling literal, different leaf)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/users/me/preferences');
    expect(response.body).toEqual({ handler: 'self-preferences' });
  });

  it('GET /users/:id/roles is untouched — the roles route has no literal `me` sibling', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/users/u-1/roles');
    expect(response.body).toEqual({ handler: 'roles', id: 'u-1' });
  });

  it('documents the hazard: GET /users/me/roles resolves to id="me" precisely because no literal exists', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/users/me/roles');
    expect(response.body).toEqual({ handler: 'roles', id: 'me' });
  });
});

describe('TASK-760 — the wrong registration order is a real, silent failure', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await boot(WrongOrderModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('with `:id` registered first, POST /users/me/permission-checks is swallowed by id="me"', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/users/me/permission-checks').send({});
    expect(response.body).toEqual({ handler: 'by-id', id: 'me' });
  });
});

describe('TASK-760 — the fixtures above match the real controllers', () => {
  it('the real controller prefixes are the ones this test exercises', async () => {
    const { PATH_METADATA } = await import('@nestjs/common/constants');
    const { PermissionCheckController, UserPermissionCheckController } = await import('../../../rbac/permission-check.controller');
    const { UserPreferencesController } = await import('../user-preferences.controller');
    const { UserRolesController } = await import('../user-roles.controller');

    expect(Reflect.getMetadata(PATH_METADATA, PermissionCheckController)).toBe('users/me/permission-checks');
    expect(Reflect.getMetadata(PATH_METADATA, UserPermissionCheckController)).toBe('users/:id/permission-checks');
    expect(Reflect.getMetadata(PATH_METADATA, UserPreferencesController)).toBe('users/me/preferences');
    expect(Reflect.getMetadata(PATH_METADATA, UserRolesController)).toBe('users');
  });

  it('rbac.module registers the literal controller BEFORE the :id controller', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(join(__dirname, '..', '..', '..', 'rbac', 'rbac.module.ts'), 'utf-8');
    const literalAt = source.indexOf('PermissionCheckController,');
    const byIdAt = source.indexOf('UserPermissionCheckController,');
    expect(literalAt).toBeGreaterThan(-1);
    expect(byIdAt).toBeGreaterThan(-1);
    expect(literalAt).toBeLessThan(byIdAt);
  });

  it('user.module registers every literal `users/me/**` controller BEFORE UserRolesController', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(join(__dirname, '..', '..', 'user.module.ts'), 'utf-8');
    const controllersBlock = source.slice(source.indexOf('controllers: ['));
    const rolesAt = controllersBlock.indexOf('UserRolesController');
    for (const literal of ['UserPreferencesController', 'UserSettingsController', 'UserDepartmentsMeController']) {
      expect(controllersBlock.indexOf(literal)).toBeGreaterThan(-1);
      expect(controllersBlock.indexOf(literal)).toBeLessThan(rolesAt);
    }
  });
});
