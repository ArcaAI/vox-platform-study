import { AllExceptionsFilter } from './all-exceptions.filter';
import { ConsentExceptionFilter } from './consent.filter';
import { DataNotFoundExceptionFilter } from './data-not-found.filter';
import { HttpExceptionEnvelopeFilter } from './http-exception-envelope.filter';

/**
 * The gateway's global exception filters, in REGISTRATION order.
 *
 * With several `APP_FILTER` providers Nest consults the LAST-registered
 * matching filter first, so the order runs from the widest net to the
 * narrowest: the `@Catch()` catch-all, then the `@Catch(HttpException)`
 * envelope normaliser, then the two domain-specific filters. Each exception
 * therefore lands on exactly one filter, and that filter writes the request's
 * single failure line.
 */
export const GLOBAL_EXCEPTION_FILTERS = [
  AllExceptionsFilter,
  HttpExceptionEnvelopeFilter,
  DataNotFoundExceptionFilter,
  ConsentExceptionFilter,
] as const;
