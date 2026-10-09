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
  CONTRACT_LOAD_CONFIG,
  CONTRACT_LOAD_REQUEST,
  CONTRACT_REPORT_MODEL_KEYS,
} from './fixtures.mjs';
import { parseLoadBody, parseUnloadBody } from './http.mjs';
import { buildLoadRequest, loadConfigFromFields } from './loadspec.mjs';

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
