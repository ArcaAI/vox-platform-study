/**
 * The LLM EGRESS wire contract: what a caller states on `apps/text` `POST /api/v1/generate` so the
 * text service can decide, per provider actually called, whether PHI is pseudonymized before it
 * leaves the platform, and what the text service reports back.
 *
 * Types only. The gateway's producers live in `@arcaai/applications` (`services/text-request`);
 * the receiving half is `apps/text` `GenerateRequest`. Field names are the snake_case WIRE names.
 */

/**
 * Where a provider runs. `local` = a platform-served engine (LM Studio, vLLM, Ollama, llama.cpp,
 * the platform's own `built-in` services): PII is detected and audited, never redacted. `cloud` =
 * a vendor the request leaves the platform for: PII is always pseudonymized and restored.
 *
 * The stamp is ADVISORY to `apps/text`: absent, unknown or contradicted by a known cloud provider
 * name, the text service treats the provider as `cloud` (fail closed). A stamp can never downgrade
 * a known cloud provider.
 */
export type ProviderLocality = 'local' | 'cloud';

/** `GenerateRequest.provider_locality` — keyed by provider name, covering `provider` and `fallback_provider`. */
export type ProviderLocalityMap = Record<string, ProviderLocality>;

/**
 * One value the caller already knows is PHI, replaced deterministically on a cloud call in addition
 * to the detector's spans. `label` is the context-schema kind / field key (or a platform identity
 * label such as `patient id`); `value` is at least 2 characters. Never logged by either side.
 */
export interface KnownPhiEntry {
  label: string;
  value: string;
}

/**
 * `GenerateRequest.medical_exempt`. The medical-relevance judge ALWAYS runs on a business-plane
 * call; only an internal service caller (nlp topic / intent) names itself exempt, explicitly. The
 * gateway never sets it.
 */
export type MedicalExempt = 'internal';

/** The `egress` object on a non-stream `/generate` response and on the terminal SSE event. Counts only. */
export interface EgressReport {
  locality: ProviderLocality;
  /** Detected PII spans per taxonomy label. */
  detected: Record<string, number>;
  redacted: number;
  restored: number;
  pii_leak_blocked: boolean;
}
