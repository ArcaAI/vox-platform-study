/**
 * TASK-957 — `POST /agents/:slug/speech` answers the status it documents.
 *
 * The handler is `@Post` + `@Res()`. Nest's `RouterExecutionContext` calls
 * `responseController.setStatus(res, httpStatusCode)` UNCONDITIONALLY before the handler runs —
 * `@Res()` changes who WRITES the body, not who set the status line — and with no `@HttpCode`
 * that status is the POST default, **201**. The route's own `@ApiResponse({ status: 200 })` and
 * `openapi.json` published 200, so a generated client that branches on the documented status
 * (or an integrator's `=== 200`) saw a synthesis it had been told was a failure.
 *
 * Every sibling on this controller was already explicit: `invocations` carries
 * `@HttpCode(HttpStatus.OK)`, `transcriptions` carries `@HttpCode(HttpStatus.CREATED)` and
 * documents 201. This route was the one that inherited its status by accident.
 *
 * Pinned against the METADATA rather than a live HTTP round-trip because that is exactly what
 * Nest reads (`HTTP_CODE_METADATA`) and what `@nestjs/swagger` reads to publish the document —
 * one fact, asserted at the one place the two consumers agree on.
 */
import 'reflect-metadata';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AgentController } from '../agent.controller';

/** Nest's own key for `@HttpCode` (`@nestjs/common`'s `HTTP_CODE_METADATA`). */
const HTTP_CODE_METADATA = '__httpCode__';

const httpCodeOf = (method: keyof AgentController): unknown =>
  Reflect.getMetadata(HTTP_CODE_METADATA, AgentController.prototype[method] as never);

describe('AgentController — declared HTTP status', () => {
  it('speech() declares 200, matching the `@ApiResponse` and openapi.json', () => {
    expect(httpCodeOf('speech')).toBe(HttpStatus.OK);
  });

  it('the metered siblings stay as they are — this is not a blanket 200', () => {
    // `invocations` already answered 200; `transcriptions` returns a job resource and
    // documents 201. A fix that harmonised all three would break the second.
    expect(httpCodeOf('invoke')).toBe(HttpStatus.OK);
    expect(httpCodeOf('transcribe')).toBe(HttpStatus.CREATED);
  });
});
