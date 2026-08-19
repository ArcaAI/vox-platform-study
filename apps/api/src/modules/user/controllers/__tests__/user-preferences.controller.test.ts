/**
 * UserPreferencesController unit tests.
 *
 * `@Authorize()` + `@RequiredScopes('user:preferences:write')` are exercised
 * by the guard pipeline (+ e2e; the API-key `me` semantics are separately
 * pinned by `me-semantics-openapi.test.ts`). These specs cover the
 * controller's own logic — plain delegation to `IUserPreferencesService` with
 * no argument transformation — plus the decorator-drift check: this route
 * writes account-scoped state under a scope that is deliberately narrower
 * than a generic `user:profile:write`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';

import { UserPreferencesController } from '../user-preferences.controller';

function makeController() {
  const service = {
    getPreferences: vi.fn().mockResolvedValue({ locale: 'en' }),
    updatePreferences: vi.fn().mockResolvedValue({ locale: 'fr' }),
  };
  const controller = new UserPreferencesController(service as never);
  return { controller, service };
}

describe('UserPreferencesController — delegation', () => {
  let controller: UserPreferencesController;
  let service: ReturnType<typeof makeController>['service'];

  beforeEach(() => {
    ({ controller, service } = makeController());
  });

  it('gets preferences for the current (CLS-resolved) user with no arguments', async () => {
    const result = await controller.getPreferences();
    expect(service.getPreferences).toHaveBeenCalledWith();
    expect(result).toEqual({ locale: 'en' });
  });

  it('updates preferences with the request body', async () => {
    const request = { locale: 'fr' };
    const result = await controller.updatePreferences(request as never);
    expect(service.updatePreferences).toHaveBeenCalledWith(request);
    expect(result).toEqual({ locale: 'fr' });
  });
});

describe('UserPreferencesController — authorization metadata', () => {
  const reflector = new Reflector();

  it('requires an authenticated caller at the class level (@Authorize())', () => {
    expect(reflector.get(REQUIRED_PERMISSIONS_KEY, UserPreferencesController)).toEqual([]);
  });

  it('carries the user:preferences:write API-key scope at the class level', () => {
    expect(reflector.get(API_KEY_REQUIRED_SCOPES, UserPreferencesController)).toEqual(['user:preferences:write']);
  });
});
