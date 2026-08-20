import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController, ApiExcludeEndpoint } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';

import {
  API_EXCLUDE_CONTROLLER_KEY,
  API_EXCLUDE_ENDPOINT_KEY,
  isControllerApiExcluded,
  isEndpointApiExcluded,
} from '../api-exclude-metadata';

/**
 * TASK-783 — regression lock on the `apiExcluded` readers.
 *
 * These tests apply the REAL `@nestjs/swagger` decorators rather than writing
 * the metadata by hand, so they fail if that package ever changes either the
 * metadata KEY or the stored SHAPE. Both matter: `emit-route-manifest.ts`
 * previously read them with `=== true`, which is always false for the wrapped
 * values the decorators actually store, and the resulting
 * `apiExcluded: false`-for-everything went unnoticed precisely because no test
 * exercised a really-decorated class.
 */

@ApiExcludeController()
class ExcludedController {
  @Get()
  handler(): void {}
}

@Controller('kept')
class PartiallyExcludedController {
  @Get('hidden')
  @ApiExcludeEndpoint()
  hidden(): void {}

  @Get('visible')
  visible(): void {}
}

@Controller('plain')
class PlainController {
  @Get()
  handler(): void {}
}

describe('isControllerApiExcluded', () => {
  it('sees a controller decorated with the real @ApiExcludeController()', () => {
    expect(isControllerApiExcluded(ExcludedController)).toBe(true);
  });

  it('returns false for an undecorated controller', () => {
    expect(isControllerApiExcluded(PlainController)).toBe(false);
  });

  it('honours @ApiExcludeController(false)', () => {
    @ApiExcludeController(false)
    class NotActuallyExcluded {}

    expect(isControllerApiExcluded(NotActuallyExcluded)).toBe(false);
  });

  it('the decorator stores an ARRAY, not a boolean — the bug this reader fixes', () => {
    const stored: unknown = Reflect.getMetadata(API_EXCLUDE_CONTROLLER_KEY, ExcludedController);

    expect(stored).toEqual([true]);
    // The pre-TASK-783 read. Documented here so the reason for the helper is
    // visible at the point of failure if this ever regresses.
    expect(stored === true).toBe(false);
  });
});

describe('isEndpointApiExcluded', () => {
  it('sees a handler decorated with the real @ApiExcludeEndpoint()', () => {
    expect(isEndpointApiExcluded(PartiallyExcludedController.prototype.hidden)).toBe(true);
  });

  it('returns false for a sibling handler on the same controller', () => {
    expect(isEndpointApiExcluded(PartiallyExcludedController.prototype.visible)).toBe(false);
  });

  it('honours @ApiExcludeEndpoint(false)', () => {
    class Mixed {
      @ApiExcludeEndpoint(false)
      handler(): void {}
    }

    expect(isEndpointApiExcluded(Mixed.prototype.handler)).toBe(false);
  });

  it('the decorator stores an OBJECT, not a boolean — the bug this reader fixes', () => {
    const stored: unknown = Reflect.getMetadata(API_EXCLUDE_ENDPOINT_KEY, PartiallyExcludedController.prototype.hidden);

    expect(stored).toEqual({ disable: true });
    expect(stored === true).toBe(false);
  });
});
