export interface DocEntry {
  content: string;
}

export type DocRegistry = Record<string, DocEntry>;

export type RegistryLoader = () => Promise<DocRegistry>;

export type DocRegistryMap = Record<string, RegistryLoader>;

export interface DocPanelState {
  isOpen: boolean;
  isLoading: boolean;
  activeDocKey: string | null;
  activeScope: string | null;
}

export interface DocPanelActions {
  setOpen: (open: boolean) => void;
  setActiveDocKey: (key: string | null) => void;
  setActiveScope: (featureId: string | null) => void;
  setLoading: (loading: boolean) => void;
}
