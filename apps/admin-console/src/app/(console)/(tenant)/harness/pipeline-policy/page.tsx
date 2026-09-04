import { redirect } from 'next/navigation';

/**
 * TASK-861 — `/harness/pipeline-policy` is RETIRED. `PipelinePolicy` is deprecated
 * (removed in R4); its toggles become `enabled` flags on the nodes of the workflow a
 * department is assigned, edited on `/workflow-studio/assignments` (TASK-864). This
 * redirect stub survives ONE release; delete the folder in R3.
 */
export default function PipelinePolicyPage() {
  redirect('/workflow-studio/assignments');
}
