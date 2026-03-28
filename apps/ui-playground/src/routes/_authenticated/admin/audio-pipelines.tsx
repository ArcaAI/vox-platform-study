import AudioPipelineManagementPage from '@/features/admin/audio-pipelines';
import { useAuthStore } from '@/store/auth-store';
import { createFileRoute, Navigate } from '@tanstack/react-router';

function GuardedAudioPipelinePage() {
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  if (!isSuperAdmin()) {
    return <Navigate to="/403" />;
  }
  return <AudioPipelineManagementPage />;
}

export const Route = createFileRoute('/_authenticated/admin/audio-pipelines')({
  component: GuardedAudioPipelinePage,
});
