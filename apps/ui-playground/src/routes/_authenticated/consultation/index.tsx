import ConsultationPage from '@/features/consultation';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/consultation/')({
  component: ConsultationPage,
});
