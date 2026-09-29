import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { fallbackOnNotFound, isNotFoundError, warnAndFallback } from '../swallow-policy';

const makeCtx = () => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  return { logger, ctx: { logger, message: 'lookup failed', meta: { modelId: 'm1' } } };
};

describe('isNotFoundError', () => {
  it('recognises the repository and the service 404 and nothing else', () => {
    expect(isNotFoundError(new DataNotFoundException('AiModel', 'x'))).toBe(true);
    expect(isNotFoundError(new NotFoundException('gone'))).toBe(true);
    expect(isNotFoundError(new Error('connection reset'))).toBe(false);
  });
});

describe('fallbackOnNotFound', () => {
  it('answers a not-found with the fallback and logs nothing', async () => {
    const { logger, ctx } = makeCtx();
    const value = await Promise.reject(new DataNotFoundException('AiModel', 'x')).catch(fallbackOnNotFound(null, ctx));
    expect(value).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an infrastructure failure once, with the Error object and the ids, and rethrows it', async () => {
    const { logger, ctx } = makeCtx();
    const outage = new Error('ECONNRESET');
    await expect(Promise.reject(outage).catch(fallbackOnNotFound(null, ctx))).rejects.toBe(outage);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ message: 'lookup failed', error: outage, modelId: 'm1' });
  });
});

describe('warnAndFallback', () => {
  it('answers a not-found silently', async () => {
    const { logger, ctx } = makeCtx();
    const value = await Promise.reject(new NotFoundException('gone')).catch(warnAndFallback([] as string[], ctx));
    expect(value).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('degrades to the fallback on an outage but leaves a warn with the Error object', async () => {
    const { logger, ctx } = makeCtx();
    const outage = new Error('prometheus down');
    const value = await Promise.reject(outage).catch(warnAndFallback([] as string[], ctx));
    expect(value).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith({ message: 'lookup failed', error: outage, modelId: 'm1' });
  });
});
