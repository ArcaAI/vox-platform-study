// The plan cache: the gateway's lmStudioServing.profiles, refreshed on a
// cadence, keyed by slug. fetch and the timers are fakes; nothing leaves the
// process.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_LMSTUDIO_SERVING } from './fixtures.mjs';
import { DEFAULT_PLAN_REFRESH_SECONDS, createPlanCache, planRefreshSeconds } from './plan.mjs';

const ENV = { HOPE_API_URL: 'http://hope-api:8868/', INTERNAL_ACCESS_TOKEN: 'tok' };

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function harness({ env = ENV, token = 'tok', answers = [] } = {}) {
  const calls = [];
  const logs = [];
  const queue = [...answers];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  const timers = [];
  const plan = createPlanCache({
    env,
    token,
    fetchImpl,
    log: (level, event, fields) => logs.push({ level, event, ...fields }),
    setInterval: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => timers.splice(timers.indexOf(timer), 1),
  });
  return { plan, calls, logs, timers };
}

test('refresh: GETs the effective config with the service token and caches every profile by slug', async () => {
  const { plan, calls } = harness({ answers: [json({ lmStudioServing: CONTRACT_LMSTUDIO_SERVING })] });
  assert.equal(await plan.refresh(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://hope-api:8868/api/v1/internal/effective-config?service=lmstudio');
  assert.equal(calls[0].init.headers['X-Service-Token'], 'tok');
  assert.ok(calls[0].init.signal, 'every attempt is bounded');

  const granite = plan.profileFor('granite-guardian-4.1-8b');
  assert.equal(granite.profile.contextLength, 16384);
  assert.deepEqual(granite.defaults, CONTRACT_LMSTUDIO_SERVING.defaults);
  assert.equal(plan.profileFor('qwen3guard-gen-0.6b').profile.gpu, 1);
  assert.equal(plan.profileFor('nope'), undefined);
  assert.deepEqual(plan.slugs(), ['gemma-4-e2b-it-qat', 'granite-guardian-4.1-8b', 'qwen3guard-gen-0.6b']);
});

test('refresh: a `{ data: … }` envelope is tolerated, as the boot loader does', async () => {
  const { plan } = harness({ answers: [json({ data: { lmStudioServing: CONTRACT_LMSTUDIO_SERVING } })] });
  assert.equal(await plan.refresh(), true);
  assert.ok(plan.profileFor('gemma-4-e2b-it-qat'));
});

test('refresh: a failure KEEPS the last good cache and logs a warning (status only, never the token)', async () => {
  const { plan, logs } = harness({
    answers: [json({ lmStudioServing: CONTRACT_LMSTUDIO_SERVING }), json({}, 503), new Error('connect ECONNREFUSED'), json({ nope: 1 })],
  });
  assert.equal(await plan.refresh(), true);
  for (const reason of [/HTTP 503/, /unreachable/, /lmStudioServing/]) {
    assert.equal(await plan.refresh(), false);
    assert.ok(plan.profileFor('granite-guardian-4.1-8b'), 'the last good plan is kept');
    const warn = logs.filter((l) => l.event === 'agent.plan_refresh_failed').at(-1);
    assert.equal(warn.level, 'warn');
    assert.match(warn.reason, reason);
    assert.equal(warn.cached_profiles, 3);
  }
  assert.ok(!JSON.stringify(logs).includes('tok'), 'the token is never logged');
});

test('refresh: a plan with no `profiles` (an older gateway) is valid and empties the cache', async () => {
  const { plan } = harness({
    answers: [json({ lmStudioServing: CONTRACT_LMSTUDIO_SERVING }), json({ lmStudioServing: { defaults: {}, preload: [] } })],
  });
  await plan.refresh();
  assert.equal(await plan.refresh(), true);
  assert.equal(plan.profileFor('granite-guardian-4.1-8b'), undefined);
});

test('refresh: entries with no slug are skipped, not fatal', async () => {
  const { plan, logs } = harness({
    answers: [json({ lmStudioServing: { defaults: {}, profiles: [{ contextLength: 1 }, null, { slug: ' m ' }] } })],
  });
  assert.equal(await plan.refresh(), true);
  assert.deepEqual(plan.slugs(), ['m']);
  assert.ok(logs.some((l) => l.event === 'agent.plan_profile_skipped'));
});

test('refreshed plans log only when the slug set changes', async () => {
  const { plan, logs } = harness({ answers: [json({ lmStudioServing: CONTRACT_LMSTUDIO_SERVING })] });
  await plan.refresh();
  await plan.refresh();
  assert.equal(logs.filter((l) => l.event === 'agent.plan_refreshed').length, 1);
});

test('without HOPE_API_URL or a token there is no fetch at all: disabled, logged once, no profiles', async () => {
  for (const [env, token] of [
    [{ INTERNAL_ACCESS_TOKEN: 'tok' }, 'tok'],
    [{ HOPE_API_URL: 'http://x' }, ''],
  ]) {
    const { plan, calls, logs, timers } = harness({ env, token });
    plan.start();
    assert.equal(await plan.refresh(), false);
    assert.equal(calls.length, 0);
    assert.equal(timers.length, 0);
    assert.equal(logs.filter((l) => l.event === 'agent.plan_refresh_disabled').length, 1);
    assert.equal(plan.profileFor('granite-guardian-4.1-8b'), undefined);
  }
});

test('start: fetches at once, then on the HOPE_PLAN_FETCH_SECONDS cadence (unref); stop clears it', async () => {
  const { plan, calls, timers } = harness({
    env: { ...ENV, HOPE_PLAN_FETCH_SECONDS: '30' },
    answers: [json({ lmStudioServing: CONTRACT_LMSTUDIO_SERVING })],
  });
  await plan.start();
  assert.equal(calls.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30_000);
  await timers[0].fn();
  assert.equal(calls.length, 2);
  plan.stop();
  assert.equal(timers.length, 0);
});

test('planRefreshSeconds: default 60 (the loader\'s), invalid or non-positive falls back with no crash', () => {
  assert.equal(DEFAULT_PLAN_REFRESH_SECONDS, 60);
  assert.equal(planRefreshSeconds({}), 60);
  assert.equal(planRefreshSeconds({ HOPE_PLAN_FETCH_SECONDS: '15' }), 15);
  assert.equal(planRefreshSeconds({ HOPE_PLAN_FETCH_SECONDS: '0' }), 60);
  assert.equal(planRefreshSeconds({ HOPE_PLAN_FETCH_SECONDS: 'abc' }), 60);
});
