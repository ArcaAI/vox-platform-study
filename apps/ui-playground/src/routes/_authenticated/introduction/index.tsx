import Introduction from '@/features/introduction';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/introduction/')({
  component: Introduction,
});
