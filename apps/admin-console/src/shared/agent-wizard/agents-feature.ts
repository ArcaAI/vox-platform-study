/**
 * The agents feature's authoring surface, as the wizard consumes it.
 *
 * Rule 13 forbids feature-to-feature imports, and the Workflow Studio must open the agent
 * wizard, so the wizard lives in `shared/`. Its parts (the agent API hooks, the model picker, the
 * instruction form, the parameters form) are still owned and tested by `features/agents`; this
 * file is the ONE place `shared/agent-wizard` reaches into it, so the dependency is a single
 * greppable line to flip the day those parts move here. Nothing in `features/agents` imports the
 * wizard's internals back: `features/agents/components/create-agent-wizard.tsx` is a re-export.
 */
export * from '@/features/agents/api';
export { JsonField } from '@/features/agents/components/json-field';
export { ModelPicker, fallbackModelOptionLabel, useTaskModelCatalogue } from '@/features/agents/components/model-picker';
export {
  ContextSchemaField,
  InstructionBindingForm,
  instructionFromBinding,
  instructionToBinding,
  type InstructionBindingValue,
} from '@/features/agents/components/instruction-binding-form';
export { ParametersForm } from '@/features/agents/components/parameters-form';
export { AgentIoSummary } from '@/features/agents/components/agent-overview';
export { generationFacts, taskSwitchFacts, type Fact } from '@/features/agents/components/agent-summary';
