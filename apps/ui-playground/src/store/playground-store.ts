import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEYS } from '@/lib/constants';

interface PlaygroundState {
  sidebarOpen: boolean;
  lastConsultationId: string | null;
  debugMode: boolean;
  apiBaseUrl: string;
}

interface PlaygroundActions {
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setLastConsultation: (id: string | null) => void;
  setDebugMode: (enabled: boolean) => void;
  setApiBaseUrl: (url: string) => void;
}

export const usePlaygroundStore = create<PlaygroundState & PlaygroundActions>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      lastConsultationId: null,
      debugMode: false,
      apiBaseUrl: import.meta.env.VITE_API_URL || 'http://localhost:8868/api/v1',

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setLastConsultation: (id) => set({ lastConsultationId: id }),
      setDebugMode: (enabled) => set({ debugMode: enabled }),
      setApiBaseUrl: (url) => set({ apiBaseUrl: url }),
    }),
    {
      name: STORAGE_KEYS.SIDEBAR_STATE,
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        lastConsultationId: state.lastConsultationId,
        debugMode: state.debugMode,
        apiBaseUrl: state.apiBaseUrl,
      }),
    },
  ),
);
