/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

export enum AgentStepType {
  LLM_CALL = 'LLM_CALL',
  TOOL_CALL = 'TOOL_CALL',
  SENSOR = 'SENSOR',
  RETRIEVAL = 'RETRIEVAL',
  GUARDRAIL = 'GUARDRAIL',
  THINKING = 'THINKING',
  SIGNAL = 'SIGNAL',
  GATE = 'GATE',
  PHASE = 'PHASE',
  /** One WorkflowInterpreter graph-node dispatch (Substrate B). See TASK-789 C-9. */
  NODE = 'NODE',
}
