import type { Metadata } from 'next';
import { AiServicesScreen } from '@/features/ai-services/components/ai-services-screen';

export const metadata: Metadata = { title: 'AI services' };

/** Guardrail/NLP status + config and the agentic instruction set, tier 10-19. */
export default function AiServicesPage() {
  return <AiServicesScreen />;
}
