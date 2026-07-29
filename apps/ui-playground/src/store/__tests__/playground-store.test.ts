import { usePlaygroundStore } from '../playground-store';

function resetStore() {
  const { setSidebarOpen, setLastConsultation, setDebugMode, setApiBaseUrl } = usePlaygroundStore.getState();
  setSidebarOpen(true);
  setLastConsultation(null);
  setDebugMode(false);
  setApiBaseUrl(import.meta.env.VITE_API_URL || 'http://localhost:8868/api');
}

describe('usePlaygroundStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  describe('initial state', () => {
    it('should start with sidebarOpen true', () => {
      expect(usePlaygroundStore.getState().sidebarOpen).toBe(true);
    });

    it('should start with lastConsultationId null', () => {
      expect(usePlaygroundStore.getState().lastConsultationId).toBeNull();
    });

    it('should start with debugMode false', () => {
      expect(usePlaygroundStore.getState().debugMode).toBe(false);
    });

    it('should have a default apiBaseUrl', () => {
      expect(usePlaygroundStore.getState().apiBaseUrl).toBe(import.meta.env.VITE_API_URL || 'http://localhost:8868/api');
    });
  });

  describe('toggleSidebar', () => {
    it('should toggle from true to false', () => {
      usePlaygroundStore.getState().toggleSidebar();
      expect(usePlaygroundStore.getState().sidebarOpen).toBe(false);
    });

    it('should toggle from false to true', () => {
      usePlaygroundStore.getState().setSidebarOpen(false);
      usePlaygroundStore.getState().toggleSidebar();
      expect(usePlaygroundStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('setSidebarOpen', () => {
    it('should set the value directly', () => {
      usePlaygroundStore.getState().setSidebarOpen(false);
      expect(usePlaygroundStore.getState().sidebarOpen).toBe(false);

      usePlaygroundStore.getState().setSidebarOpen(true);
      expect(usePlaygroundStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('setLastConsultation', () => {
    it('should store the consultation id', () => {
      usePlaygroundStore.getState().setLastConsultation('consult-abc');
      expect(usePlaygroundStore.getState().lastConsultationId).toBe('consult-abc');
    });

    it('should accept null to clear', () => {
      usePlaygroundStore.getState().setLastConsultation('consult-abc');
      usePlaygroundStore.getState().setLastConsultation(null);
      expect(usePlaygroundStore.getState().lastConsultationId).toBeNull();
    });
  });

  describe('setDebugMode', () => {
    it('should enable debug mode', () => {
      usePlaygroundStore.getState().setDebugMode(true);
      expect(usePlaygroundStore.getState().debugMode).toBe(true);
    });

    it('should disable debug mode', () => {
      usePlaygroundStore.getState().setDebugMode(true);
      usePlaygroundStore.getState().setDebugMode(false);
      expect(usePlaygroundStore.getState().debugMode).toBe(false);
    });
  });

  describe('setApiBaseUrl', () => {
    it('should update the URL', () => {
      usePlaygroundStore.getState().setApiBaseUrl('https://prod.example.com/api');
      expect(usePlaygroundStore.getState().apiBaseUrl).toBe('https://prod.example.com/api');
    });
  });
});
