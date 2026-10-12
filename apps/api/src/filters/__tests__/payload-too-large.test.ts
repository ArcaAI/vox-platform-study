import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from '../all-exceptions.filter';

function host(): {
  host: never;
  response: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
} {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn(), send: vi.fn(), headersSent: false };
  const request = { method: 'POST', url: '/api/v1/internal/guardrail/evaluations', headers: {} };
  return {
    response: response as never,
    host: { getType: () => 'http', switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as never,
  };
}

describe('AllExceptionsFilter payload too large', () => {
  it('keeps 413 for a body-parser PayloadTooLargeError instead of 500', () => {
    const h = host();
    const error = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413, statusCode: 413 });
    new AllExceptionsFilter().catch(error, h.host);
    expect(h.response.status).toHaveBeenCalledWith(413);
  });
});
