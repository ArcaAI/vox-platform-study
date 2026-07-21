/**
 * `RequestWithAuth` interface narrows the authentication-pipeline-set
 * fields on the Express `Request` so that
 * controllers, guards, and interceptors reading `request.apiKey`,
 * `request.user`, and `request.tenantId` get a typed handle instead of
 * an `any` / bracket-notation lookup that silently swallows typos
 * (`request.aip_key` → `undefined` → unauthenticated bypass).
 *
 * The interface is the type contract; this file pins its shape with
 * `expectTypeOf` type-level assertions and uses `@ts-expect-error` to
 * lock the "typo on the field name doesn't compile" guarantee.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { Request } from 'express';
import type { ApiKeyEntity } from '@arcaai/domains';
import type { UserSession } from '@arcaai/applications';

import type { RequestWithAuth } from '../request-with-auth';

describe('RequestWithAuth interface (TASK-310 E-6 / AC-6)', () => {
  it('extends express Request without losing any base fields', () => {
    expectTypeOf<RequestWithAuth>().toExtend<Request>();
  });

  it('narrows `apiKey` to `ApiKeyEntity | undefined`', () => {
    expectTypeOf<RequestWithAuth['apiKey']>().toEqualTypeOf<ApiKeyEntity | undefined>();
  });

  it('narrows `user` to `UserSession | undefined`', () => {
    expectTypeOf<RequestWithAuth['user']>().toEqualTypeOf<UserSession | undefined>();
  });

  it('narrows `tenantId` to `string | undefined`', () => {
    expectTypeOf<RequestWithAuth['tenantId']>().toEqualTypeOf<string | undefined>();
  });

  it('rejects typos at compile-time (catches `aip_key` → undefined silent bypass)', () => {
    const r = {} as RequestWithAuth;
    // @ts-expect-error — typo on apiKey field must NOT compile
    void r.aip_key;
    // @ts-expect-error — typo on user field must NOT compile
    void r.usr;
    // @ts-expect-error — typo on tenantId field must NOT compile
    void r.tennatId;
  });
});
