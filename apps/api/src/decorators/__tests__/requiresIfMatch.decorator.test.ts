/**
 * `@RequiresIfMatch()` decorator + `RequiresIfMatchGuard` unit tests
 * — TASK-302 Stream D Phase D (D.2).
 *
 * The decorator is a metadata-only marker (`SetMetadata`). The companion
 * guard runs globally and, on annotated routes, flips
 * `req._requiresIfMatch = true` so the `@ExpectedVersion()` parameter
 * decorator (D.2.2) can decide whether to throw 428 on a missing header.
 *
 * Splitting the responsibility this way means:
 *   - The decorator is trivially-composable on a controller method.
 *   - The 428 logic lives where the header is actually parsed, keeping
 *     errors close to their source.
 *   - Non-annotated routes pay zero cost (the guard's only branch is a
 *     single Reflector lookup).
 *
 * @see apps/api/src/decorators/requiresIfMatch.decorator.ts
 * @see apps/api/src/decorators/requiresIfMatch.guard.ts
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { RequiresIfMatch, REQUIRES_IF_MATCH_KEY } from '../requiresIfMatch.decorator';
import { RequiresIfMatchGuard } from '../requiresIfMatch.guard';
import type { ExecutionContext } from '@nestjs/common';

class Controller {
    @RequiresIfMatch()
    update() {}

    plainGet() {}
}

interface MockReq {
    headers: Record<string, string | undefined>;
    _requiresIfMatch?: boolean;
}

const buildCtx = (handler: () => void, klass: typeof Controller, req: MockReq): ExecutionContext =>
    ({
        getHandler: () => handler,
        getClass: () => klass,
        switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

describe('@RequiresIfMatch (TASK-302 Stream D Phase D)', () => {
    it('marks the handler with REQUIRES_IF_MATCH_KEY metadata = true', () => {
        const reflector = new Reflector();
        const flag = reflector.get(REQUIRES_IF_MATCH_KEY, Controller.prototype.update);
        expect(flag).toBe(true);
    });

    it('does NOT mark a plain (un-annotated) handler', () => {
        const reflector = new Reflector();
        const flag = reflector.get(REQUIRES_IF_MATCH_KEY, Controller.prototype.plainGet);
        // No metadata on plainGet — the lookup returns undefined.
        expect(flag).toBeUndefined();
    });
});

describe('RequiresIfMatchGuard (TASK-302 Stream D Phase D)', () => {
    it('sets req._requiresIfMatch = true on @RequiresIfMatch()-annotated handlers', () => {
        const reflector = new Reflector();
        const guard = new RequiresIfMatchGuard(reflector);
        const req: MockReq = { headers: {} };
        const ctx = buildCtx(Controller.prototype.update, Controller, req);

        expect(guard.canActivate(ctx)).toBe(true);
        // The whole point of the guard is to mutate the request so the
        // downstream @ExpectedVersion() extractor can throw 428.
        expect(req._requiresIfMatch).toBe(true);
    });

    it('leaves req._requiresIfMatch unset on non-annotated handlers', () => {
        const reflector = new Reflector();
        const guard = new RequiresIfMatchGuard(reflector);
        const req: MockReq = { headers: {} };
        const ctx = buildCtx(Controller.prototype.plainGet, Controller, req);

        expect(guard.canActivate(ctx)).toBe(true);
        // Non-annotated routes pay zero cost and have no contract change.
        expect(req._requiresIfMatch).toBeUndefined();
    });

    it('always returns true (the param decorator does the throwing, not the guard)', () => {
        // Critical contract: the guard does NOT block requests. Its only
        // job is metadata propagation onto the request object. If a guard
        // returned `false`, the param decorator would never run and we'd
        // emit a 403 Forbidden instead of the correct 428 Precondition
        // Required.
        const reflector = new Reflector();
        const guard = new RequiresIfMatchGuard(reflector);
        const req: MockReq = { headers: {} };
        expect(guard.canActivate(buildCtx(Controller.prototype.update, Controller, req))).toBe(true);
        expect(guard.canActivate(buildCtx(Controller.prototype.plainGet, Controller, req))).toBe(true);
    });
});
