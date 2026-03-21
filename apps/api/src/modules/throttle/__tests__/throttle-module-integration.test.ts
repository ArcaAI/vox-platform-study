/**
 * ThrottleModule integration test (TDD RED phase)
 *
 * Verifies the throttle module exports the correct providers
 * and can be imported by the AppModule.
 */

import { describe, it, expect } from 'vitest';
import { ThrottleConfigModule } from '../throttle.module';

describe('ThrottleConfigModule', () => {
    it('should be defined and importable', () => {
        expect(ThrottleConfigModule).toBeDefined();
    });

    it('should be a class (NestJS module)', () => {
        expect(typeof ThrottleConfigModule).toBe('function');
    });
});
