import type { Metadata } from 'next';
import { KnowledgeDocumentsScreen } from '@/features/knowledge/components/knowledge-documents-screen';

export const metadata: Metadata = { title: 'Knowledge Base' };

/** Frame — Knowledge Base list (tier 30-49). */
export default function KnowledgePage() {
  return <KnowledgeDocumentsScreen />;
}
