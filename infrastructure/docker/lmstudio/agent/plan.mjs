// =============================================================================
// The served LM Studio plan, cached for `ensure` (TASK-1055 wave 3, G1)
// =============================================================================
// GET ${HOPE_API_URL}/api/v1/internal/effective-config?service=lmstudio — the
// same URL, header (X-Service-Token = INTERNAL_ACCESS_TOKEN) and `{ data }`
// tolerance as the boot loader (../loader/load.mjs fetchEffectiveConfig) —
// fetched at start and then every HOPE_PLAN_FETCH_SECONDS (default 60, the
// loader's). `lmStudioServing.profiles` (one resolved entry per enabled
// SYSTEM lm-studio model) is cached by slug with the plan's `defaults`.
//
// Never on the request path: `ensure` reads only this cache, so a request
// never waits on the gateway and no gateway -> text -> lmstudio -> gateway
// cycle exists. A failed refresh KEEPS the last good cache (warning logged);
// no URL or no token = no fetch at all, and ensure knows no profiles.
// Logs carry status codes and counts only — never the body, never the token.
// =============================================================================

export const DEFAULT_PLAN_REFRESH_SECONDS = 60;
const ATTEMPT_TIMEOUT_MS = 5_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The refresh cadence. A bad value must not crash the agent: it falls back to the default. */
export function planRefreshSeconds(env) {
  const raw = env.HOPE_PLAN_FETCH_SECONDS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_PLAN_REFRESH_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PLAN_REFRESH_SECONDS;
}

/**
 * @param {{ env: object, token: string, fetchImpl?: typeof fetch,
 *           log?: (level, event, fields) => void,
 *           setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} deps
 *   `token` is the REAL secret ('' when absent or the placeholder), as server.mjs resolves it.
 */
export function createPlanCache({
  env,
  token,
  fetchImpl = fetch,
  log = () => {},
  setInterval: every = setInterval,
  clearInterval: cancel = clearInterval,
}) {
  const base = String(env.HOPE_API_URL ?? '').trim();
  const enabled = base !== '' && typeof token === 'string' && token !== '';
  const url = `${base.replace(/\/+$/, '')}/api/v1/internal/effective-config?service=lmstudio`;
  const intervalSeconds = planRefreshSeconds(env);

  /** slug -> { profile, defaults } */
  let profiles = new Map();
  let lastSlugs = null;
  let inflight = null;
  let timer = null;
  let disabledLogged = false;

  const fail = (reason) => {
    log('warn', 'agent.plan_refresh_failed', { reason, cached_profiles: profiles.size });
    return false;
  };

  const fetchOnce = async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'X-Service-Token': token, Accept: 'application/json' },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (error) {
      return fail(error?.name === 'TimeoutError' ? 'timed out' : `unreachable (${error?.message ?? error})`);
    }
    if (!response.ok) return fail(`HTTP ${response.status}`);

    let body;
    try {
      body = await response.json();
    } catch {
      return fail('the body is not JSON');
    }
    const config = body?.lmStudioServing !== undefined ? body : (body?.data ?? body);
    const serving = config?.lmStudioServing;
    if (!isObject(serving)) return fail('the answer carries no lmStudioServing');

    const defaults = isObject(serving.defaults) ? serving.defaults : {};
    const next = new Map();
    for (const [index, entry] of (Array.isArray(serving.profiles) ? serving.profiles : []).entries()) {
      const slug = typeof entry?.slug === 'string' ? entry.slug.trim() : '';
      if (slug === '') {
        log('warn', 'agent.plan_profile_skipped', { index, reason: 'no slug' });
        continue;
      }
      next.set(slug, { profile: { ...entry, slug }, defaults });
    }
    profiles = next;

    const slugs = [...next.keys()].sort().join(',');
    if (slugs !== lastSlugs) {
      lastSlugs = slugs;
      log('info', 'agent.plan_refreshed', { profiles: [...next.keys()].sort() });
    }
    return true;
  };

  /** One refresh; concurrent callers share it. Resolves true on success, false otherwise. */
  function refresh() {
    if (!enabled) {
      if (!disabledLogged) {
        disabledLogged = true;
        log('info', 'agent.plan_refresh_disabled', {
          reason: 'HOPE_API_URL / INTERNAL_ACCESS_TOKEN not both set — ensure knows no serving profiles',
        });
      }
      return Promise.resolve(false);
    }
    inflight ??= fetchOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** Fetch now, then on the cadence. The timer never holds the process open. */
  function start() {
    const first = refresh();
    if (enabled && timer === null) {
      timer = every(() => refresh(), intervalSeconds * 1000);
      timer?.unref?.();
    }
    return first;
  }

  function stop() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  return {
    refresh,
    start,
    stop,
    profileFor: (slug) => profiles.get(slug),
    slugs: () => [...profiles.keys()],
  };
}
