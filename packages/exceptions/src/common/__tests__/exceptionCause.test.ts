import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArgumentInvalidException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '../../backend/application';
import { BaseException } from '../base.exception';

type Opts = { cause?: unknown; metadata?: Record<string, unknown> };

const factories: Record<string, (message: string, opts?: Opts) => BaseException> = {
  NotFoundException: (m, o) => new NotFoundException(m, o),
  ArgumentInvalidException: (m, o) => new ArgumentInvalidException(m, o),
  ConflictException: (m, o) => new ConflictException(m, o),
  InternalServerErrorException: (m, o) => new InternalServerErrorException(m, o),
  UnauthorizedException: (m, o) => new UnauthorizedException(m, o),
};

describe('application exceptions accept { cause, metadata }', () => {
  const originalEnv = process.env['NODE_ENV'];
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });
  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
  });

  for (const [name, make] of Object.entries(factories)) {
    it(`${name} exposes cause and metadata`, () => {
      const cause = new Error('root');
      const exc = make('boom', { cause, metadata: { tenantId: 't-1' } });
      expect(exc.cause).toBe(cause);
      expect(exc.metadata).toEqual({ tenantId: 't-1' });
      expect(exc.message).toBe('boom');
    });

    it(`${name} still works with a single argument`, () => {
      const exc = make('only message');
      expect(exc.cause).toBeUndefined();
      expect(exc.metadata).toBeUndefined();
    });
  }

  it('default message is kept with no arguments', () => {
    expect(new NotFoundException().message).toBe(NotFoundException.message);
  });
});

describe('BaseException.toJSON — cause serialisation', () => {
  const originalEnv = process.env['NODE_ENV'];
  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
  });

  it('emits cause as { name, message } outside production, never the stack', () => {
    process.env['NODE_ENV'] = 'test';
    const exc = new InternalServerErrorException('boom', { cause: new TypeError('root cause') });
    const json = exc.toJSON();
    expect(json.cause).toEqual({ name: 'TypeError', message: 'root cause' });
    expect(JSON.stringify(json.cause)).not.toContain('at ');
  });

  it('emits no cause in production', () => {
    process.env['NODE_ENV'] = 'production';
    const exc = new InternalServerErrorException('boom', { cause: new Error('root cause') });
    const json = exc.toJSON();
    expect(json.cause).toBeUndefined();
    expect(json.stack).toBeUndefined();
  });

  it('handles a non-Error cause without throwing', () => {
    process.env['NODE_ENV'] = 'test';
    const exc = new InternalServerErrorException('boom', { cause: 'plain string' });
    expect(exc.toJSON().cause).toEqual({ name: 'NonError', message: 'plain string' });
  });
});
