import { Header, applyDecorators } from '@nestjs/common';
/** Mirrors `DECORATORS.API_OPERATION` from `@nestjs/swagger/dist/constants` — that path is not an exported subpath, so the key is restated here. */
const API_OPERATION_METADATA = 'swagger/apiOperation';

export interface ApiDeprecatedOptions {
  /** The ticket that deprecated the route — becomes the `@deprecated TASK-nnn` marker the deprecation register keys on. */
  ticket: string;
  /** The release the route is REMOVED in (register column "Remove in"). */
  removeIn: string;
  /** Where callers go instead — emitted as `Link: <…>; rel="successor-version"` when given. */
  replacement?: string;
  /**
   * RFC 8594 `Sunset` HTTP-date. Optional until the owner names the release
   * tags (TASK-859 OD-2); the `Deprecation` header is emitted regardless.
   */
  sunsetAt?: string;
}

/**
 * TASK-862 — the program-wide route deprecation marker
 * (`docs/implementation/TASK-859-…` §6): `Deprecation: true` (RFC 9745) plus
 * an operator-readable `X-Deprecation-Notice`, `Link: …; rel="successor-version"`
 * when a replacement exists, `Sunset` when a date is known, and
 * `deprecated: true` on the route's OpenAPI operation.
 *
 * Place it ABOVE `@ApiOperation(...)` (decorators apply bottom-up, so this one
 * runs last and MERGES `deprecated: true` into the operation metadata the
 * `@ApiOperation` below it already wrote — it never replaces the summary).
 */
/** HTTP header values are ISO-8859-1; anything outside printable ASCII is replaced so a notice can never break the response. */
export function toHeaderSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '-');
}

export function ApiDeprecated(options: ApiDeprecatedOptions): MethodDecorator {
  // ASCII only: Node rejects a non-Latin-1 header value with ERR_INVALID_CHAR, which turned every
  // deprecated route into a 500 (the original text carried an em-dash).
  const notice = toHeaderSafe(`${options.ticket} - removed in ${options.removeIn}${options.replacement ? `; use ${options.replacement}` : ''}`);
  const headers: MethodDecorator[] = [Header('Deprecation', 'true'), Header('X-Deprecation-Notice', notice)];
  if (options.replacement) headers.push(Header('Link', `<${options.replacement}>; rel="successor-version"`));
  if (options.sunsetAt) headers.push(Header('Sunset', options.sunsetAt));

  const markOperation: MethodDecorator = (_target, _propertyKey, descriptor) => {
    const existing = (Reflect.getMetadata(API_OPERATION_METADATA, descriptor.value as object) ?? {}) as Record<string, unknown>;
    const description = [existing.description, `DEPRECATED (${notice}).`].filter(Boolean).join(' ');
    Reflect.defineMetadata(API_OPERATION_METADATA, { ...existing, deprecated: true, description }, descriptor.value as object);
    return descriptor;
  };

  return applyDecorators(...headers, markOperation);
}
