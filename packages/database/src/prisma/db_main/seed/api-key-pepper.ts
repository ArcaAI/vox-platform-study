/**
 * Vault-aware API_KEY_PEPPER resolution for the API-key seed.
 *
 * Dev ships SECRETS_PROVIDER=vault, so the running API validates keys with
 * HMAC-SHA256 using the pepper in Vault KV (`secret/hope/API_KEY_PEPPER`,
 * written by infrastructure/docker/configs/vault/dev-init.sh). The tracked
 * .env.dev keeps API_KEY_PEPPER blank on purpose, so the
 * seed must read the pepper from the same source the API does — otherwise
 * it writes plain-SHA-256 hashes that 401 against the API (a real
 * 2026-06-10 incident).
 *
 * Resolution order:
 *   1. Non-empty process.env.API_KEY_PEPPER (CI variables / .env.test).
 *   2. SECRETS_PROVIDER=vault → Vault KV v2 read. A failure here THROWS:
 *      silently falling back to plain SHA-256 in vault mode would seed
 *      keys the API can never validate.
 *   3. Otherwise undefined → plain SHA-256, matching the env secrets
 *      provider seeing the same empty variable at runtime.
 *
 * Auth uses VAULT_TOKEN, else VAULT_DEV_ROOT_TOKEN, else "root". The seed
 * only ever runs in dev/test (see `shouldSeedApiKeys`), where the dev-mode
 * root token is the documented bootstrap credential (dev-setup.sh uses it
 * the same way) — AppRole creds may not exist yet at seed time (dev-setup
 * Step 3 runs before Step 4 refreshes them).
 */

export async function resolveApiKeyPepper(): Promise<string | undefined> {
  const envPepper = process.env.API_KEY_PEPPER;
  if (envPepper) return envPepper;

  const provider = (process.env.SECRETS_PROVIDER ?? '').toLowerCase().trim();
  if (provider !== 'vault') return undefined;

  const addr = (process.env.VAULT_ADDR || 'http://localhost:8200').replace(/\/+$/, '');
  const mount = process.env.VAULT_KV_MOUNT || 'secret';
  const prefix = process.env.VAULT_KV_PREFIX || 'hope';
  const token = process.env.VAULT_TOKEN || process.env.VAULT_DEV_ROOT_TOKEN || 'root';
  const url = `${addr}/v1/${mount}/data/${prefix}/API_KEY_PEPPER`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'X-Vault-Token': token },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(
      `SECRETS_PROVIDER=vault but API_KEY_PEPPER could not be read from Vault at ${url}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Seeding without the pepper would write API-key hashes the API can never validate. ' +
        'Start Vault (pnpm infra:up) or set API_KEY_PEPPER in the environment.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `SECRETS_PROVIDER=vault but Vault returned HTTP ${response.status} for API_KEY_PEPPER at ${url}. ` +
        'Ensure vault-init has seeded secret/hope/API_KEY_PEPPER (pnpm infra:up), ' +
        'or set API_KEY_PEPPER in the environment.',
    );
  }

  const body = (await response.json()) as { data?: { data?: { value?: string } } };
  const value = body.data?.data?.value;
  if (!value) {
    throw new Error(`SECRETS_PROVIDER=vault but the Vault secret at ${url} has no "value" field for API_KEY_PEPPER.`);
  }
  return value;
}
