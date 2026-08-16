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

  //=========== WORKFLOW EXPOSURE (TASK-722) ============//
  /**
   * R-1 kill-switch: the whole `/api/v1/workflows/:slug/…` public-invoke
   * surface. OFF by default — design.md's precondition is that API-key
   * scope enforcement (TASK-708) is verified end-to-end before this surface
   * is enabled, and Temporal is not yet production-ready (R-2). Optional
   * (unlike `REGISTRATION_SELF_SIGNUP_ENABLED`) so existing `IAppConfig`
   * fixtures that predate this field stay valid — `undefined` is treated as
   * `false` by every reader, same posture as an explicit `false`.
   */
  WORKFLOW_EXPOSURE_ENABLED?: boolean;
  /**
   * Decision #6 (R-8): may a workflow invoked through the PUBLIC exposure
   * plane route to a cloud LLM provider (`isCloudByoProvider('llm', …)` —
   * azure/bedrock/openai/anthropic/vertex)? OFF by default — public exposure
   * inherits the strictest egress posture; a tenant must opt in explicitly.
   * Platform-wide today (not yet per-tenant — see the ticket README §7 for
   * why a per-tenant entitlement column was deliberately not built ahead of
   * any node type that could actually select a cloud provider).
   */
  WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS?: boolean;

  //=========== INTERNAL SERVICES ============//
  PORT: string;
  URL: string;
  STT_URL: string;
  TEXT_PORT: string;
  TEXT_URL: string;
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
