/**
 * TASK-1038 OD-35 — the two "read all runs" scopes, on both machine credential classes.
 *
 * Business-plane run reads are bound to the starting principal; these are the deliberate
 * exceptions an integrator grants a credential that must read EVERY run of its tenant (a
 * dashboard, a reconciliation job). They are new grants: no preset carries them and no seeded
 * credential holds them, so issuing one is always a decision someone made.
 */
import { describe, expect, it } from 'vitest';
import { API_KEY_SCOPE_PRESETS, API_KEY_SCOPE_REGISTRY, isValidScope } from '../apikey-scopes.registry';
import {
  AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES,
  SERVICE_ACCOUNT_SCOPE_REGISTRY,
  isValidServiceAccountScope,
} from '../../serviceAccount/service-account-scopes.registry';
import { RUN_READ_ALL_SCOPES } from '../../workflow-run/run-principal-access';

describe('OD-35 — run read-all scopes', () => {
  it('registers `workflow:run:read-all` and `agent:run:read-all` as grantable API-key scopes', () => {
    for (const scope of [RUN_READ_ALL_SCOPES.workflow.apiKey, RUN_READ_ALL_SCOPES.agent.apiKey]) {
      expect(isValidScope(scope), scope).toBe(true);
      expect(API_KEY_SCOPE_REGISTRY[scope].implies.length, `${scope} declares its ability`).toBeGreaterThan(0);
    }
    expect(API_KEY_SCOPE_REGISTRY['workflow:run:read-all'].implies).toEqual([{ action: 'read', subject: 'WorkflowRun' }]);
    expect(API_KEY_SCOPE_REGISTRY['agent:run:read-all'].implies).toEqual([{ action: 'read', subject: 'Agent' }]);
  });

  it('derives the machine-identity twins in the agent/workflow business-plane family', () => {
    expect(AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES).toContain('workflow:run:read-all');
    expect(AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES).toContain('agent:run:read-all');
    for (const scope of [RUN_READ_ALL_SCOPES.workflow.serviceAccount, RUN_READ_ALL_SCOPES.agent.serviceAccount]) {
      expect(isValidServiceAccountScope(scope), scope).toBe(true);
    }
    expect(SERVICE_ACCOUNT_SCOPE_REGISTRY['svc:workflow:run:read-all'].implies).toEqual(API_KEY_SCOPE_REGISTRY['workflow:run:read-all'].implies);
    expect(SERVICE_ACCOUNT_SCOPE_REGISTRY['svc:agent:run:read-all'].implies).toEqual(API_KEY_SCOPE_REGISTRY['agent:run:read-all'].implies);
  });

  it('is in no preset: a credential reads every run only when someone granted that on purpose', () => {
    for (const preset of API_KEY_SCOPE_PRESETS) {
      expect(preset.scopes, preset.key).not.toContain('workflow:run:read-all');
      expect(preset.scopes, preset.key).not.toContain('agent:run:read-all');
    }
  });
});
