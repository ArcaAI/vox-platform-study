import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { useTheme } from '@/providers/theme-provider';
import { Studio } from '@prisma/studio-core/ui';
import { createPostgresAdapter } from '@prisma/studio-core/data/postgres-core';
import { createStudioBFFClient } from '@prisma/studio-core/data/bff';
import '@prisma/studio-core/ui/index.css';
import './studio-theme-overrides.css';
import { useEffect, useMemo } from 'react';

export default function StudioPage() {
  const token = useAuthStore((s) => s.accessToken);
  const apiBaseUrl = usePlaygroundStore((s) => s.apiBaseUrl);
  const { resolvedTheme } = useTheme();

  const adapter = useMemo(() => {
    const executor = createStudioBFFClient({
      url: `${apiBaseUrl}/admin/pstudio`,
      customHeaders: { Authorization: `Bearer ${token}` },
    });
    // TASK-336 BR-02: HOPE tables all live in the `core` schema. studio-core's
    // postgres adapter hardcodes `defaultSchema: "public"` (empty here), so the
    // UI renders "No tables found". Override it so the table list resolves.
    return Object.assign(createPostgresAdapter({ executor }), { defaultSchema: 'core' });
  }, [token, apiBaseUrl]);

  useEffect(() => {
    const ps = document.querySelector<HTMLElement>('.ps');
    if (!ps) return;
    ps.classList.toggle('dark', resolvedTheme === 'dark');
  }, [resolvedTheme]);

  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <Studio adapter={adapter} />
    </div>
  );
}
