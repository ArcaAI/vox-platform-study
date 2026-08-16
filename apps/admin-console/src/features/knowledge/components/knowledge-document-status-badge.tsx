import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { KnowledgeDocumentStatus } from '../api/types';

const STATUS_VARIANT: Record<KnowledgeDocumentStatus, 'default' | 'secondary' | 'outline'> = {
  DRAFT: 'outline',
  APPROVED: 'default',
  ARCHIVED: 'secondary',
};

export function KnowledgeDocumentStatusBadge({ status }: { status: KnowledgeDocumentStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}
