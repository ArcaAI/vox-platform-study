/**
 * Compile-time type assertions for IAppConfig.
 *
 * IAppConfig is a type — there is no runtime to test. This file uses TypeScript
 * conditional types as the assertion harness; if either declaration is removed
 * or its shape regresses, this test file FAILS TO COMPILE, which in turn fails
 * the Vitest run for this package.
 */

import { describe, it, expect } from 'vitest';
import type { IAppConfig } from '../IAppConfig';

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;

type _PrismaPgMaxIsOptionalNumber = Assert<
  Equals<IAppConfig['PRISMA_PG_MAX'], number | undefined>
>;

type _DirectUrlIsOptionalString = Assert<
  Equals<IAppConfig['DIRECT_URL'], string | undefined>
>;

describe('IAppConfig — Stream C Phase 0 fields', () => {
  it('declares PRISMA_PG_MAX as an optional number', () => {
    const sample: IAppConfig = {
      NODE_ENV: 'test',
      DEBUG: false,
      NEST_DEBUG: false,
      SERVICE_NAME: 'test',
      LOG_LEVEL: 'info',
      REGISTRATION_SELF_SIGNUP_ENABLED: false,
      PORT: '8868',
      URL: 'http://localhost:8868',
      STT_V2_URL: '',
      SMR_PORT: '',
      SMR_URL: '',
      NLP_PORT: '',
      NLP_URL: '',
      GUARDRAIL_URL: '',
      HARNESS_URL: '',
      TTS_PORT: '',
      TTS_URL: '',
      MQTT_HOST: '',
      MQTT_PORT: 1883,
      MQTT_USER: '',
      MQTT_PASS: '',
      REDIS_HOST: '',
      REDIS_PORT: 6379,
      REDIS_PASS: '',
      PRISMA_PG_MAX: 5,
    };
    expect(sample.PRISMA_PG_MAX).toBe(5);
  });

  it('declares DIRECT_URL as an optional string', () => {
    const sample: IAppConfig = {
      NODE_ENV: 'test',
      DEBUG: false,
      NEST_DEBUG: false,
      SERVICE_NAME: 'test',
      LOG_LEVEL: 'info',
      REGISTRATION_SELF_SIGNUP_ENABLED: false,
      PORT: '8868',
      URL: 'http://localhost:8868',
      STT_V2_URL: '',
      SMR_PORT: '',
      SMR_URL: '',
      NLP_PORT: '',
      NLP_URL: '',
      GUARDRAIL_URL: '',
      HARNESS_URL: '',
      TTS_PORT: '',
      TTS_URL: '',
      MQTT_HOST: '',
      MQTT_PORT: 1883,
      MQTT_USER: '',
      MQTT_PASS: '',
      REDIS_HOST: '',
      REDIS_PORT: 6379,
      REDIS_PASS: '',
      DIRECT_URL: 'postgresql://user:pw@127.0.0.1:5432/db',
    };
    expect(sample.DIRECT_URL).toMatch(/^postgresql:/);
  });

  it('permits both PRISMA_PG_MAX and DIRECT_URL to be omitted (backwards-compatible)', () => {
    const sample: IAppConfig = {
      NODE_ENV: 'test',
      DEBUG: false,
      NEST_DEBUG: false,
      SERVICE_NAME: 'test',
      LOG_LEVEL: 'info',
      REGISTRATION_SELF_SIGNUP_ENABLED: false,
      PORT: '8868',
      URL: 'http://localhost:8868',
      STT_V2_URL: '',
      SMR_PORT: '',
      SMR_URL: '',
      NLP_PORT: '',
      NLP_URL: '',
      GUARDRAIL_URL: '',
      HARNESS_URL: '',
      TTS_PORT: '',
      TTS_URL: '',
      MQTT_HOST: '',
      MQTT_PORT: 1883,
      MQTT_USER: '',
      MQTT_PASS: '',
      REDIS_HOST: '',
      REDIS_PORT: 6379,
      REDIS_PASS: '',
    };
    expect(sample.PRISMA_PG_MAX).toBeUndefined();
    expect(sample.DIRECT_URL).toBeUndefined();
  });
});
