import { describe, it, expect } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { IsString, IsOptional } from 'class-validator';
import { plainToInstance } from 'class-transformer';

class FakeDto {
  @IsString() id!: string;
  @IsString() value!: string;
  @IsOptional() @IsString() description?: string;
}

/**
 * Strict ValidationPipe contract pin.
 *
 * Locks the NestJS 11 ValidationPipe configuration that closes the JWT
 * mass-assignment chain at the HTTP boundary. Mirrors main.ts.
 */
describe('Phase 0 Item 1 — global ValidationPipe must strip + reject unknown keys', () => {
  const pipeCfg = {
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  } as const;

  it('throws BadRequestException naming the smuggled property on unknown keys', async () => {
    const pipe = new ValidationPipe(pipeCfg);
    const evil = plainToInstance(FakeDto, {
      id: 'gs-1',
      value: 'v',
      key: 'JWT_SECRET_KEY',
      locked: true,
    });

    let caught: unknown;
    try {
      await pipe.transform(evil, { type: 'body', metatype: FakeDto } as never);
    } catch (err) {
      caught = err;
    }

    expect(caught, 'pipe must reject unknown keys').toBeInstanceOf(BadRequestException);
    const response = (caught as BadRequestException).getResponse() as { message: string | string[] };
    const messages = Array.isArray(response.message) ? response.message : [response.message];
    expect(
      messages.some((m: string) => /property key should not exist/i.test(m)),
      `expected a "property key should not exist" message; got: ${JSON.stringify(messages)}`,
    ).toBe(true);
    expect(
      messages.some((m: string) => /property locked should not exist/i.test(m)),
      `expected a "property locked should not exist" message; got: ${JSON.stringify(messages)}`,
    ).toBe(true);
  });

  it('strips unknown keys silently when forbidNonWhitelisted is OFF (stage 1 baseline)', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const evil = plainToInstance(FakeDto, {
      id: 'gs-1',
      value: 'v',
      key: 'JWT_SECRET_KEY',
      locked: true,
    });

    const out = await pipe.transform(evil, { type: 'body', metatype: FakeDto } as never);
    expect(out, 'stage-1 strip-only pipe must drop unknown keys').not.toHaveProperty('key');
    expect(out).not.toHaveProperty('locked');
    expect(out).toEqual({ id: 'gs-1', value: 'v' });
  });
});
