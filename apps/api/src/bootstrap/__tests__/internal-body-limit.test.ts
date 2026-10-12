import 'reflect-metadata';
import { Controller, Module, Post, Body } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { AllExceptionsFilter } from '../../filters/all-exceptions.filter';
import { applyInternalBodyLimits, GUARDRAIL_EVALUATIONS_BODY_LIMIT_PATH } from '../internal-body-limit';

@Controller()
class EchoController {
  @Post('internal/guardrail/evaluations')
  internal(@Body() body: { rows: string[] }) {
    return { n: body.rows.length };
  }
  @Post('other')
  other(@Body() body: { rows: string[] }) {
    return { n: body.rows.length };
  }
}

@Module({ controllers: [EchoController], providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }] })
class EchoModule {}

async function boot() {
  const app = await NestFactory.create(EchoModule, { logger: false, rawBody: true });
  app.setGlobalPrefix('api/v1');
  applyInternalBodyLimits(app);
  await app.init();
  return app;
}

const big = { rows: Array.from({ length: 300 }, () => 'x'.repeat(1000)) }; // ~300 kB

describe('internal guardrail evaluations body limit', () => {
  it('accepts a ~300 kB batch on the internal evaluations route', async () => {
    const app = await boot();
    const res = await request(app.getHttpServer()).post('/api/v1/internal/guardrail/evaluations').send(big);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ n: 300 });
    expect(GUARDRAIL_EVALUATIONS_BODY_LIMIT_PATH).toContain('internal/guardrail/evaluations');
    await app.close();
  });

  it('keeps the default limit elsewhere, answering 413 (not 500)', async () => {
    const app = await boot();
    const res = await request(app.getHttpServer()).post('/api/v1/other').send(big);
    expect(res.status).toBe(413);
    await app.close();
  });

  it('refuses a body over 2 MB on the internal route with 413', async () => {
    const app = await boot();
    const huge = { rows: Array.from({ length: 2200 }, () => 'x'.repeat(1000)) };
    const res = await request(app.getHttpServer()).post('/api/v1/internal/guardrail/evaluations').send(huge);
    expect(res.status).toBe(413);
    await app.close();
  });
});
