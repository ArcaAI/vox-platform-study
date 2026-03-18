import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@nestjs/passport', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@nestjs/passport')>();
    return {
        ...actual,
        PassportSerializer: class MockPassportSerializer {
            constructor() {}
        },
    };
});

import { SessionSerializer, SessionSerializerCallback } from '../session.serializer';

describe('SessionSerializer', () => {
    let serializer: SessionSerializer;

    beforeEach(() => {
        vi.clearAllMocks();
        serializer = new SessionSerializer();
    });

    describe('serializeUser', () => {
        it('should call done with null error and user.id', () => {
            const done: SessionSerializerCallback = vi.fn();
            const user = { id: 'uuid-abc-123', email: 'test@example.com', name: 'Test User' };

            serializer.serializeUser(user, done);

            expect(done).toHaveBeenCalledTimes(1);
            expect(done).toHaveBeenCalledWith(null, 'uuid-abc-123');
        });

        it('should handle user with string id', () => {
            const done: SessionSerializerCallback = vi.fn();
            const user = { id: 'string-id-value' };

            serializer.serializeUser(user, done);

            expect(done).toHaveBeenCalledWith(null, 'string-id-value');
        });

        it('should handle user with numeric id', () => {
            const done: SessionSerializerCallback = vi.fn();
            const user = { id: 42 };

            serializer.serializeUser(user, done);

            expect(done).toHaveBeenCalledWith(null, 42);
        });
    });

    describe('deserializeUser', () => {
        it('should call done with null error and user object', () => {
            const done: SessionSerializerCallback = vi.fn();
            const user = { id: 'user-1', email: 'test@example.com', roles: ['admin'] };

            serializer.deserializeUser(user, done);

            expect(done).toHaveBeenCalledTimes(1);
            expect(done).toHaveBeenCalledWith(null, user);
            const passedUser = (done as ReturnType<typeof vi.fn>).mock.calls[0][1];
            expect(passedUser).toBe(user);
        });
    });
});
