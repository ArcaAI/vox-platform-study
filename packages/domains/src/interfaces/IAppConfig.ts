export interface IAppConfig {
  //=========== APPLICATION ============//
  NODE_ENV: 'production' | 'development' | string;
  DEBUG: boolean;
  NEST_DEBUG: boolean;
  SERVICE_NAME: string;

  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  //=========== FILE LOGGING ============//
  LOG_FILE_ENABLED?: boolean;
  LOG_FILE_PATH?: string;
  LOG_FILE_MAX_SIZE?: string;
  LOG_FILE_MAX_FILES?: number;
  LOG_FILE_DATE_PATTERN?: string;
  LOG_FILE_SEPARATE_ERROR?: boolean;

  //=========== AUTH / REGISTRATION ============//
  /**
   * Verified self-signup master switch. OFF by default — a
   * healthcare/PHI platform cannot expose open registration without email
   * verification gating tenant provisioning.
   */
  REGISTRATION_SELF_SIGNUP_ENABLED: boolean;

  //=========== INTERNAL SERVICES ============//
  PORT: string;
  URL: string;
  STT_URL: string;
  SMR_PORT: string;
  SMR_URL: string;
  NLP_PORT: string;
  NLP_URL: string;
  GUARDRAIL_URL: string;
  HARNESS_URL: string;
  TTS_PORT: string;
  TTS_URL: string;

  //=========== MQTT ============//
  MQTT_HOST: string;
  MQTT_PORT: number;
  MQTT_USER: string;
  MQTT_PASS: string;

  //=========== REDIS ============//
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASS: string;

  //=========== DATABASE ============//
  /**
   * Optional override for the `PrismaPg` adapter's `max` pool size.
   * Defaults to 5 in `packages/database/src/client.ts`.
   * Budget rule: pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections.
   */
  PRISMA_PG_MAX?: number;

  /**
   * Direct (un-pooled) connection string.
   * Consumed exclusively by `prisma.config.ts` for migrations (advisory locks
   * do not survive PgBouncer transaction-mode swaps).
   */
  DIRECT_URL?: string;
}
