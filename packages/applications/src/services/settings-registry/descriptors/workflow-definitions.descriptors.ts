// TASK-1036 lane B3b — the workflow-definition compiler's release switch.
//
// `workflows.emitDataContract` turns on the compiler's DATA CONTRACT for every compile the gateway
// performs (publish, validate, sandbox): per-node `bindings` and `consultationReads`, and the
// top-level `settings` of the compiled artifact. It stays OFF until the harness interpreter's
// `compiled_config` model (which forbids unknown keys) mirrors the shape — lane B1 — and the
// orchestrator flips it on the SYSTEM tier. Platform-wide and platform-owned: a tenant cannot run
// ahead of the interpreter, so there is no tenant lane.

import { SettingDescriptor } from '../registry.types';

export const WORKFLOWS_EMIT_DATA_CONTRACT_KEY = 'workflows.emitDataContract';

export const WORKFLOW_DEFINITION_SETTINGS: SettingDescriptor[] = [
  {
    key: WORKFLOWS_EMIT_DATA_CONTRACT_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    editableBy: 'GlobalSetting',
    maxScope: 'system',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Workflow Runs',
    label: 'Emit the workflow data contract',
    description:
      'When on, every workflow compile (publish, validate, sandbox) emits per-node bindings, declared consultation reads and the workflow settings into the compiled config. Leave off until the harness interpreter supports the data contract; it applies to versions compiled after the switch.',
    default: false,
  },
];
