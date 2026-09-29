/**
 * The gateway error pipeline, end to end through a real Nest app: CLS id
 * middleware → guards → ContextInterceptor → ExceptionInterceptor → the
 * global filters, with the production validation pipe.
 *
 * Contract under test:
 *  - `X-Request-Id` on every response, equal to the body `correlationId`
 *    (200, guard 401, uncaught 500).
 *  - Uncaught non-HTTP errors → `{statusCode:500, code:'INTERNAL.UNEXPECTED',
 *    message, correlationId}` (the catch-all filter).
 *  - Exactly ONE failure line per failed request, written by the terminal
 *    filter: ≥500 `error` (with the Error), 4xx `warn`.
 *  - The failure line carries `requestId`, `method`, `route` (template, never
 *    the query string), `status`, `code`, `errorName`, `durationMs`, and the
 *    CLS `tenantId`/`userId`.
 *  - Validation 400 logs `violations: [{property, constraints:[names]}]`, never
 *    the submitted value; the client body is unchanged.
 *  - Prisma errors log code / modelName / first message line, never the
 *    invocation block.
 *  - A domain 500 carries no `cause`/`stack` in the client body.
 *  - A consent 403 body carries no `externalPatientId`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for framework types */
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@arcaai/database';
import { BaseException, ConsentDeniedException, DataNotFoundException } from '@arcaai/exceptions';
import {
  Body,
  CanActivate,
  Controller,
  Get,
  Inject,
  Injectable,
  type INestApplication,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsEmail, IsString, ValidateNested } from 'class-validator';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextInterceptor } from '../../interceptors/context.interceptor';
import { ExceptionInterceptor } from '../../interceptors/exception.interceptor';
import { CLS_MODULE_OPTIONS } from '../../request-id';
import { GLOBAL_EXCEPTION_FILTERS } from '../global-filters';
import { createGlobalValidationPipe } from '../validation-violations';

class BoomException extends BaseException {
  code = 'TEST.BOOM';
}

class ChildDto {
  @IsString()
  name!: string;
}

class BodyDto {
  @IsEmail()
  email!: string;

  @ValidateNested()
  @Type(() => ChildDto)
  child!: ChildDto;
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('Authentication required');
  }
}

@Injectable()
class ConsentGuard implements CanActivate {
  canActivate(): boolean {
    throw new ConsentDeniedException('Consent denied', {
      tenantId: 'tenant-1',
      externalPatientId: 'EXT-PAT-777',
      purpose: 'TREATMENT',
      reason: 'NO_ACTIVE_GRANT',
    } as any);
  }
}

@Injectable()
class IdentityGuard implements CanActivate {
  constructor(@Inject(ClsService) private readonly cls: ClsService) {}
  canActivate(): boolean {
    this.cls.set('tenantId', 'tenant-1');
    this.cls.set('userId', 'user-1');
    this.cls.set('credentialClass', 'jwt');
    return true;
  }
}

const PRISMA_UNIQUE_MESSAGE = [
  '',
  'Invalid `prisma.user.create()` invocation in',
  '/app/packages/domains/src/common/repository.ts:88:5',
  '',
  "→ 88 prisma.user.create({ data: { email: 'patient@example.com' } })",
  '',
  'Unique constraint failed on the fields: (`email`)',
].join('\n');

const PRISMA_INVOCATION_MESSAGE = [
  '',
  'Invalid `prisma.user.findMany()` invocation in',
  '/app/packages/domains/src/common/repository.ts:120:5',
  '',
  '  117 ',
  "→ 120 prisma.user.findMany({ where: { emial: 'patient@example.com' } })",
  '',
  'Unknown argument `emial`. Did you mean `email`? Available options are marked with ?.',
].join('\n');

@Controller('t')
class PipelineController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('guarded')
  @UseGuards(DenyGuard)
  guarded() {
    return { ok: true };
  }

  @Get('boom')
  boom() {
    throw new TypeError('x is not a function');
  }

  @Get('items/:id')
  @UseGuards(IdentityGuard)
  item() {
    throw new NotFoundException('Resource not found');
  }

  @Get('missing')
  missing() {
    throw new DataNotFoundException('User', 'user-9');
  }

  @Post('validate')
  validate(@Body() body: BodyDto) {
    return body;
  }

  @Get('domain')
  domain() {
    throw new BoomException('boom happened', new Error('root cause'));
  }

  @Get('prisma-validation')
  prismaValidation() {
    throw new PrismaClientValidationError(PRISMA_INVOCATION_MESSAGE, { clientVersion: '7.0.0' });
  }

  @Get('prisma-known')
  prismaKnown() {
    throw new PrismaClientKnownRequestError(PRISMA_UNIQUE_MESSAGE, {
      code: 'P2002',
      clientVersion: '7.0.0',
      meta: { modelName: 'User', target: ['email'] },
    });
  }

  @Get('consent')
  consent() {
    throw new ConsentDeniedException('Consent denied', {
      tenantId: 'tenant-1',
      externalPatientId: 'EXT-PAT-777',
      purpose: 'TREATMENT',
      reason: 'NO_ACTIVE_GRANT',
    } as any);
  }

  @Get('consent-guard')
  @UseGuards(ConsentGuard)
  consentGuard() {
    return { ok: true };
  }
}

// The suite runs without emitDecoratorMetadata, so the validation pipe would
// see no metatype for `@Body()`; declare it the way tsc would have.
Reflect.defineMetadata('design:paramtypes', [BodyDto], PipelineController.prototype, 'validate');

const logger = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
  fatal: vi.fn(),
};

type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
function linesWith(message: string): Array<{ level: LogLevel; fields: Record<string, any> }> {
  const out: Array<{ level: LogLevel; fields: Record<string, any> }> = [];
  for (const level of Object.keys(logger) as LogLevel[]) {
    for (const call of logger[level].mock.calls) {
      const first = call[0];
      if (first && typeof first === 'object' && first.message === message) out.push({ level, fields: first });
    }
  }
  return out;
}

function failureLine(): { level: LogLevel; fields: Record<string, any> } {
  const lines = linesWith('Request failed');
  expect(lines).toHaveLength(1);
  return lines[0];
}

/** Every warn/error call — the "one failure line" budget. */
function alarmingCallCount(): number {
  return logger.warn.mock.calls.length + logger.error.mock.calls.length + logger.fatal.mock.calls.length;
}

describe('gateway request failure pipeline', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot(CLS_MODULE_OPTIONS)],
      controllers: [PipelineController],
      providers: [
        DenyGuard,
        ConsentGuard,
        IdentityGuard,
        ...GLOBAL_EXCEPTION_FILTERS.map((useClass) => ({ provide: APP_FILTER, useClass })),
        { provide: APP_INTERCEPTOR, useClass: ContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ExceptionInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useLogger(logger);
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    for (const fn of Object.values(logger)) fn.mockClear();
  });

  describe('A2 — X-Request-Id on every response', () => {
    it('200: header present and echoes a valid inbound id', async () => {
      const res = await request(app.getHttpServer()).get('/t/ok').set('x-request-id', 'client-rid-1').expect(200);
      expect(res.headers['x-request-id']).toBe('client-rid-1');
    });

    it('guard 401: header equals body correlationId', async () => {
      const res = await request(app.getHttpServer()).get('/t/guarded').expect(401);
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(res.body.correlationId).toBe(res.headers['x-request-id']);
      expect(res.body.code).toBe('HTTP.UNAUTHORIZED');
    });

    it('uncaught TypeError 500: header equals body correlationId', async () => {
      const res = await request(app.getHttpServer()).get('/t/boom').set('x-request-id', 'client-rid-500').expect(500);
      expect(res.headers['x-request-id']).toBe('client-rid-500');
      expect(res.body.correlationId).toBe('client-rid-500');
    });
  });

  describe('A3 — catch-all filter', () => {
    it('uncaught Error → unified envelope and exactly ONE error line with the stack', async () => {
      const res = await request(app.getHttpServer()).get('/t/boom').set('x-request-id', 'rid-a3').expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL.UNEXPECTED',
        message: 'Internal server error',
        correlationId: 'rid-a3',
      });

      const line = failureLine();
      expect(line.level).toBe('error');
      expect(line.fields.requestId).toBe('rid-a3');
      expect(line.fields.route).toBe('/t/boom');
      expect(line.fields.method).toBe('GET');
      expect(line.fields.status).toBe(500);
      expect(line.fields.code).toBe('INTERNAL.UNEXPECTED');
      expect(line.fields.errorName).toBe('TypeError');
      expect(line.fields.error).toBeInstanceOf(Error);
      expect(line.fields.error.stack).toContain('x is not a function');
      expect(typeof line.fields.durationMs).toBe('number');
      expect(alarmingCallCount()).toBe(1);
    });
  });

  describe('A4 — validation 400', () => {
    it('logs violations (property path + constraint NAMES) and never the value; client body unchanged', async () => {
      const res = await request(app.getHttpServer())
        .post('/t/validate')
        .send({ email: 'not-an-email-SECRETVALUE', child: { name: 424242 } })
        .expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION.FAILED',
        message: 'Validation error',
        error: 'Bad Request',
      });
      expect(res.body.subErrors).toEqual(expect.arrayContaining(['email must be an email', 'child.name must be a string']));
      expect(res.body.details).toEqual(res.body.subErrors);
      expect(res.body.correlationId).toBe(res.headers['x-request-id']);

      const line = failureLine();
      expect(line.level).toBe('warn');
      expect(line.fields.status).toBe(400);
      expect(line.fields.code).toBe('VALIDATION.FAILED');
      expect(line.fields.violations).toEqual(
        expect.arrayContaining([
          { property: 'email', constraints: ['isEmail'] },
          { property: 'child.name', constraints: ['isString'] },
        ]),
      );
      const serialized = JSON.stringify(logger.warn.mock.calls) + JSON.stringify(logger.error.mock.calls) + JSON.stringify(logger.debug.mock.calls);
      expect(serialized).not.toContain('SECRETVALUE');
      expect(serialized).not.toContain('424242');
      expect(alarmingCallCount()).toBe(1);
    });
  });

  describe('A5 — level by status, one line', () => {
    it('404 → warn, once', async () => {
      await request(app.getHttpServer()).get('/t/missing').expect(404);
      const line = failureLine();
      expect(line.level).toBe('warn');
      expect(line.fields.status).toBe(404);
      expect(line.fields.code).toBe('HTTP.NOT_FOUND');
      expect(alarmingCallCount()).toBe(1);
    });

    it('guard 401 → warn, once', async () => {
      await request(app.getHttpServer()).get('/t/guarded').expect(401);
      const line = failureLine();
      expect(line.level).toBe('warn');
      expect(line.fields.status).toBe(401);
      expect(alarmingCallCount()).toBe(1);
    });

    it('ContextInterceptor writes no failure line of its own, and no completion line for a failed request', async () => {
      await request(app.getHttpServer()).get('/t/boom').expect(500);
      expect(linesWith('Request failed')).toHaveLength(1);
      expect(linesWith('Request completed')).toHaveLength(0);
    });

    it('a successful request still gets exactly one completion line', async () => {
      await request(app.getHttpServer()).get('/t/ok').expect(200);
      expect(linesWith('Request completed')).toHaveLength(1);
      expect(linesWith('Request failed')).toHaveLength(0);
    });
  });

  describe('A7 — generic BaseException 500', () => {
    it('logs at error with the Error (cause chain intact); body carries no cause and no stack', async () => {
      const res = await request(app.getHttpServer()).get('/t/domain').expect(500);
      expect(res.body.statusCode).toBe(500);
      expect(res.body.code).toBe('TEST.BOOM');
      expect(res.body).not.toHaveProperty('cause');
      expect(res.body).not.toHaveProperty('stack');

      const line = failureLine();
      expect(line.level).toBe('error');
      expect(line.fields.errorName).toBe('BoomException');
      expect(line.fields.error).toBeInstanceOf(BoomException);
      expect(line.fields.error.cause).toBeInstanceOf(Error);
      expect(line.fields.error.cause.message).toBe('root cause');
      expect(alarmingCallCount()).toBe(1);
    });
  });

  describe('A8 — Prisma errors', () => {
    it('validation error: logs the first meaningful line, never the invocation block', async () => {
      const res = await request(app.getHttpServer()).get('/t/prisma-validation').expect(400);
      expect(res.body.code).toBe('PERSISTENCE.QUERY_INVALID');

      const line = failureLine();
      expect(line.fields.errorName).toBe('PrismaClientValidationError');
      expect(line.fields.prismaMessage).toBe('Unknown argument `emial`. Did you mean `email`? Available options are marked with ?.');
      const serialized = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]);
      expect(serialized).not.toContain('patient@example.com');
      expect(serialized).not.toContain('Invalid `prisma');
      expect(serialized).not.toContain('repository.ts');
      expect(alarmingCallCount()).toBe(1);
    });

    it('known request error: logs code, modelName and target; still 409 with the same body', async () => {
      const res = await request(app.getHttpServer()).get('/t/prisma-known').expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION',
        message: 'Unique constraint violation',
        error: 'Unique constraint violation',
      });

      const line = failureLine();
      expect(line.level).toBe('warn');
      expect(line.fields.prismaCode).toBe('P2002');
      expect(line.fields.modelName).toBe('User');
      expect(line.fields.target).toEqual(['email']);
      expect(line.fields.prismaMessage).toBe('Unique constraint failed on the fields: (`email`)');
      const serialized = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
      expect(serialized).not.toContain('patient@example.com');
      expect(serialized).not.toContain('Invalid `prisma');
    });
  });

  describe('A9 — consent 403', () => {
    it('handler throw: body has no externalPatientId; the log passes it under its own key', async () => {
      const res = await request(app.getHttpServer()).get('/t/consent').expect(403);
      expect(JSON.stringify(res.body)).not.toContain('EXT-PAT-777');
      expect(res.body.metadata).toMatchObject({ purpose: 'TREATMENT', reason: 'NO_ACTIVE_GRANT' });
      expect(res.body).not.toHaveProperty('stack');
      expect(res.body).not.toHaveProperty('cause');

      const line = failureLine();
      expect(line.level).toBe('warn');
      expect(line.fields.externalPatientId).toBe('EXT-PAT-777');
    });

    it('guard throw: body has no externalPatientId', async () => {
      const res = await request(app.getHttpServer()).get('/t/consent-guard').expect(403);
      expect(JSON.stringify(res.body)).not.toContain('EXT-PAT-777');
      expect(res.body.code).toBe('DOMAIN.CONSENT_DENIED');
      expect(res.body.correlationId).toBe(res.headers['x-request-id']);
      expect(res.body).not.toHaveProperty('stack');

      const line = failureLine();
      expect(line.level).toBe('warn');
      expect(line.fields.status).toBe(403);
      expect(line.fields.externalPatientId).toBe('EXT-PAT-777');
    });
  });

  describe('A10 — route template, never the query string', () => {
    it('failure line uses req.route.path and carries CLS tenant/user', async () => {
      await request(app.getHttpServer()).get('/t/items/abc-123?secret=hunter2').expect(404);
      const line = failureLine();
      expect(line.fields.route).toBe('/t/items/:id');
      expect(line.fields.tenantId).toBe('tenant-1');
      expect(line.fields.userId).toBe('user-1');
      expect(line.fields.credentialClass).toBe('jwt');
      const serialized = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.log.mock.calls, logger.debug.mock.calls]);
      expect(serialized).not.toContain('hunter2');
    });

    it('completion line uses the route template too', async () => {
      await request(app.getHttpServer()).get('/t/ok?secret=hunter2').expect(200);
      const [line] = linesWith('Request completed');
      expect(line.fields.route).toBe('/t/ok');
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain('hunter2');
    });
  });
});
