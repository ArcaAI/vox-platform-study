/**
 * MyTenantController.updateMyConfig — BUG-005 Issue 2 defense-in-depth.
 *
 * PATCH /tenant/me/config was previously bare `@Authorize()` (auth-only) —
 * any authenticated tenant member, including a real end-user or an
 * impersonated one, could write tenant config. The UI now hides the edit
 * affordance for non-elevated callers, but that is a UI-layer gate only;
 * this locks the write down server-side too. GET routes stay self-service
 * (unchanged) — mirrors DEF-C3's `department-prompt-config.controller.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { MyTenantController } from '../my-tenant.controller';

describe('MyTenantController.updateMyConfig — BUG-005 authorization metadata', () => {
    const getMethodMetadata = (method: string) =>
        Reflect.getMetadata(
            REQUIRED_PERMISSIONS_KEY,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (MyTenantController.prototype as any)[method],
        );

    it('updateMyConfig should require ["update","Tenant"] permissions', () => {
        const meta = getMethodMetadata('updateMyConfig');
        expect(meta).toEqual([{ action: 'update', subject: 'Tenant' }]);
    });

    it('me (GET) stays bare-@Authorize() self-service — no method-level requirement added', () => {
        expect(getMethodMetadata('me')).toBeUndefined();
    });

    it('myConfig (GET) stays bare-@Authorize() self-service — no method-level requirement added', () => {
        expect(getMethodMetadata('myConfig')).toBeUndefined();
    });
});
