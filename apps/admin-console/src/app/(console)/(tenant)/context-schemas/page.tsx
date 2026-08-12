import type { Metadata } from 'next';
import { ContextSchemasScreen } from '@/features/context-schemas/components/context-schemas-screen';

export const metadata: Metadata = { title: 'Context Schemas' };

/** Context Schemas — tenant-defined consultation context vocabulary (tier 30-49, TASK-658/666). */
export default function ContextSchemasPage() {
  return <ContextSchemasScreen />;
}
