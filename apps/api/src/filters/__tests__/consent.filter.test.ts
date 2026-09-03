/**
 * `ConsentExceptionFilter` unit tests (consent-abac).
 *
 * The exception this filter exists for is thrown from a GUARD
 * (`PatientConsentGuard`), which NestJS's request lifecycle never routes
 * through `ExceptionInterceptor` — only through the exception-filter chain.
 * Pins: `ConsentDeniedException` → 403, `ConsentUnavailableException` → 503
 * (R4 — never the same status), and the response body carries `err.toJSON()`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { ConsentDeniedException, ConsentUnavailableException } from '@arcaai/exceptions';
import { ConsentExceptionFilter } from '../consent.filter';

function makeArgumentsHost(): { host: ArgumentsHost; statusSpy: ReturnType<typeof vi.fn>; jsonSpy: ReturnType<typeof vi.fn> } {
  const jsonSpy = vi.fn().mockReturnThis();
  const statusSpy = vi.fn().mockReturnValue({ json: jsonSpy });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/api/v1/consultations/c-1/recording/start' }),
      getResponse: () => ({ status: statusSpy }),
    }),
  } as unknown as ArgumentsHost;
  return { host, statusSpy, jsonSpy };
}

describe('ConsentExceptionFilter', () => {
  let filter: ConsentExceptionFilter;

  beforeEach(() => {
    filter = new ConsentExceptionFilter();
  });

  it('maps ConsentDeniedException to 403 with err.toJSON() as the body', () => {
    const exception = new ConsentDeniedException('denied', {
      tenantId: 't-1',
      externalPatientId: 'EHR-A:1',
      purpose: 'AI_DOCUMENTATION',
      reason: 'no_grant',
    });
    const { host, statusSpy, jsonSpy } = makeArgumentsHost();

    filter.catch(exception, host);

    expect(statusSpy).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    const body = jsonSpy.mock.calls[0]?.[0] as { code: string; metadata?: { reason: string } };
    expect(body.code).toBe('DOMAIN.CONSENT_DENIED');
    expect(body.metadata).toMatchObject({ reason: 'no_grant' });
  });

  it('maps ConsentUnavailableException to 503 — a DIFFERENT status from a genuine denial (R4)', () => {
    const exception = new ConsentUnavailableException('unavailable', {
      tenantId: 't-1',
      externalPatientId: 'EHR-A:1',
      purpose: 'AI_DOCUMENTATION',
      cause: 'grant_lookup_failed',
    });
    const { host, statusSpy, jsonSpy } = makeArgumentsHost();

    filter.catch(exception, host);

    expect(statusSpy).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(statusSpy).not.toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    const body = jsonSpy.mock.calls[0]?.[0] as { code: string };
    expect(body.code).toBe('DOMAIN.CONSENT_UNAVAILABLE');
  });

  it('logs a genuine denial at debug and an unavailability verdict at error — different alerting posture (R4)', () => {
    const debugSpy = vi.spyOn((filter as any).logger, 'debug').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);

    filter.catch(
      new ConsentDeniedException('denied', { tenantId: 't-1', externalPatientId: 'p', purpose: 'AI_DOCUMENTATION', reason: 'no_grant' }),
      makeArgumentsHost().host,
    );
    expect(debugSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    filter.catch(
      new ConsentUnavailableException('unavailable', { tenantId: 't-1', externalPatientId: 'p', purpose: 'AI_DOCUMENTATION', cause: 'grant_lookup_failed' }),
      makeArgumentsHost().host,
    );
    expect(errorSpy).toHaveBeenCalled();
  });
});
