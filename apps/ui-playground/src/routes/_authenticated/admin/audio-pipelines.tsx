import AudioPipelineManagementPage from '@/features/admin/audio-pipelines';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/audio-pipelines')({
  component: () => (
    <RequireAdmin>
      <AudioPipelineManagementPage />
    </RequireAdmin>
  ),
});
