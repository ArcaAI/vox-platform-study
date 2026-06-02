import ConsultationDetail from '@/features/consultation/components/consultation-detail';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/consultation/$id')({
  component: ConsultationDetail,
});
