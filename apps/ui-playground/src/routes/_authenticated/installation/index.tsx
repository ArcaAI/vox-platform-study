import Installation from '@/features/installation';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/installation/')({
  component: Installation,
});
