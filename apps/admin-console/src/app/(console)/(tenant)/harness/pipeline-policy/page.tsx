import type { Metadata } from 'next';
import { PipelinePolicyScreen } from '@/features/pipeline-policy/components/pipeline-policy-screen';

export const metadata: Metadata = { title: 'Pipeline Policy (Post-Consultation)' };

/** Frame 39 — post-consultation pipeline policy cascade (tier 30-49, working tenant). Governs the post-consultation
 * summarization/NER pipeline only — not the live consultation lane (F-23, TASK-852 item 7). */
export default function PipelinePolicyPage() {
  return <PipelinePolicyScreen />;
}
