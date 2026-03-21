import { create } from 'zustand';
import type { DocPanelActions, DocPanelState } from '../types';

const initialState: DocPanelState = {
  isOpen: false,
  isLoading: false,
  activeDocKey: null,
  activeScope: null,
};

export const useDocPanelStore = create<DocPanelState & DocPanelActions>()((set) => ({
  ...initialState,

  setOpen: (open) => set({ isOpen: open }),

  setActiveDocKey: (key) => set({ activeDocKey: key }),

  setActiveScope: (featureId) =>
    set((state) => ({
      ...(state.activeScope !== featureId
        ? {
            activeScope: featureId,
            activeDocKey: null,
          }
        : {}),
    })),

  setLoading: (loading) => set({ isLoading: loading }),
}));
