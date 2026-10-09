// Pins the agent to the FROZEN TASK-1055 contract
// (tests/contracts/model-residency-task1055.fixture.json, `lmStudioAgent`).
//
// The fixture lives outside the image's build context, so inside the image
// these tests SKIP and the in-tree copies (fixtures.mjs) carry the shapes; in
// every repo checkout they run and fail on any drift between the two.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  CONTRACT_DEVICE_KEYS,
  CONTRACT_ENSURE_REQUEST,
  CONTRACT_ENSURE_RESPONSES,
  CONTRACT_LMSTUDIO_SERVING,
  CONTRACT_LOAD_CONFIG,
  CONTRACT_LOAD_REQUEST,
  CONTRACT_REPORT_MODEL_KEYS,
} from './fixtures.mjs';
import { parseEnsureBody, parseLoadBody, parseUnloadBody } from './http.mjs';
import { buildLoadRequest, loadConfigFromFields, loadSpecFromProfile } from './loadspec.mjs';

const FIXTURE_URL = new URL('../../../../tests/contracts/model-residency-task1055.fixture.json', import.meta.url);
const fixture = existsSync(FIXTURE_URL) ? JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) : null;
const skip = fixture ? false : 'contract fixture not in this tree (image build context)';

test('the in-tree load request IS the contract lmStudioAgent.loadRequest', { skip }, () => {
  assert.deepEqual(CONTRACT_LOAD_REQUEST, fixture.lmStudioAgent.loadRequest);
});

test('the in-tree report-model keys and load_config ARE the contract reportModel', { skip }, () => {
  const model = fixture.lmStudioAgent.reportModel;
  assert.deepEqual([...CONTRACT_REPORT_MODEL_KEYS].sort(), Object.keys(model).sort());
  assert.deepEqual(CONTRACT_LOAD_CONFIG, model.load_config);
});

test('the in-tree device keys ARE the contract python.report device shape', { skip }, () => {
  assert.deepEqual([...CONTRACT_DEVICE_KEYS].sort(), Object.keys(fixture.python.report.devices[0]).sort());
});

test('the contract load and unload bodies pass the agent HTTP validation unchanged', { skip }, () => {
  assert.deepEqual(parseLoadBody(structuredClone(fixture.lmStudioAgent.loadRequest)), fixture.lmStudioAgent.loadRequest);
  const unload = parseUnloadBody(structuredClone(fixture.python.unloadRequest));
  assert.equal(unload.device, 'cuda:1');
  assert.equal(unload.reason, 'admin');
});

test('the contract load_spec round-trips to the contract load_config through the kvConfig', { skip }, () => {
  const { model_ref: modelRef, load_spec: loadSpec, device } = fixture.lmStudioAgent.loadRequest;
  const request = buildLoadRequest({ modelRef, loadSpec, device, pin: false, ttlSeconds: null, gpuCount: 2, env: {} });
  assert.deepEqual(loadConfigFromFields(request.kvConfig.fields), fixture.lmStudioAgent.reportModel.load_config);
});

// ── wave 3: lmStudioOnDemand ─────────────────────────────────────────────────

test('the in-tree served plan IS the contract wave3 lmStudioServing (profiles included)', { skip }, () => {
  assert.deepEqual(CONTRACT_LMSTUDIO_SERVING, fixture.wave3.lmStudioOnDemand.effectiveConfig.lmStudioServing);
});

test('the in-tree ensure request and responses ARE the contract wave3 ensure', { skip }, () => {
  const ensure = fixture.wave3.lmStudioOnDemand.ensure;
  assert.equal(ensure.request.method, 'POST');
  assert.equal(ensure.request.path, '/internal/residency/ensure');
  assert.deepEqual(CONTRACT_ENSURE_REQUEST, ensure.request.body);
  assert.deepEqual(CONTRACT_ENSURE_RESPONSES, ensure.responses);
  assert.deepEqual(parseEnsureBody(structuredClone(ensure.request.body)), ensure.request.body);
});

test('every contract profile builds a valid load request on a 2-GPU box', { skip }, () => {
  const { profiles, defaults } = fixture.wave3.lmStudioOnDemand.effectiveConfig.lmStudioServing;
  for (const profile of profiles) {
    const { loadSpec, device } = loadSpecFromProfile(profile, defaults);
    const request = buildLoadRequest({ modelRef: profile.slug, loadSpec, device, pin: false, ttlSeconds: null, gpuCount: 2, env: {} });
    assert.equal(request.identifier, profile.slug);
  }
});
