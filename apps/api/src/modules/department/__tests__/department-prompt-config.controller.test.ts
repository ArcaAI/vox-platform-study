/**
 * DepartmentController.updatePromptConfig — TASK-294 DEF-C3
 *
 * The PATCH /:id/prompt-config endpoint MUST be gated on
 * `@Authorize(['manage', 'Department'])`. Only that single handler
 * should carry the method-level tuple — class-level `@Authorize()` is
 * left untouched on purpose.
 */

import { describe, it, expect } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { DepartmentController } from '../department.controller';

describe('DepartmentController.updatePromptConfig — DEF-C3 authorization metadata', () => {
    const getMethodMetadata = (method: string) =>
        Reflect.getMetadata(
            REQUIRED_PERMISSIONS_KEY,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (DepartmentController.prototype as any)[method],
        );

    it('updatePromptConfig should require ["manage","Department"] permissions', () => {
        const meta = getMethodMetadata('updatePromptConfig');
        expect(meta).toEqual([{ action: 'manage', subject: 'Department' }]);
    });
});
