import type { Metadata } from 'next';
import { ContextSchemaDetailScreen } from '@/features/context-schemas/components/context-schema-detail-screen';

export const metadata: Metadata = { title: 'Context schema' };

/**
 * One context schema (tier 30-49) — the definition editor, its version history,
 * and the publish it gates. A page rather than a drawer: the record carries a
 * draft, a history and an action that changes what every client of this tenant
 * may send.
 */
export default async function ContextSchemaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContextSchemaDetailScreen id={id} />;
}
