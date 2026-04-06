import StudioPage from '@/features/admin/components/studio-page';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/studio')({
  component: StudioPage,
});
