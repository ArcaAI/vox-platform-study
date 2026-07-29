import { getLocalStorage, setLocalStorage, removeLocalStorage } from '../local-storage';

describe('local-storage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('getLocalStorage', () => {
    it('should return null for non-existent key', () => {
      expect(getLocalStorage('missing')).toBeNull();
    });

    it('should return stored value', () => {
      localStorage.setItem('key', 'value');
      expect(getLocalStorage('key')).toBe('value');
    });

    it('should return null when localStorage throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      expect(getLocalStorage('key')).toBeNull();
    });
  });

  describe('setLocalStorage', () => {
    it('should store a value', () => {
      setLocalStorage('key', 'value');
      expect(localStorage.getItem('key')).toBe('value');
    });

    it('should overwrite existing value', () => {
      setLocalStorage('key', 'first');
      setLocalStorage('key', 'second');
      expect(localStorage.getItem('key')).toBe('second');
    });

    it('should silently fail when localStorage throws', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      expect(() => setLocalStorage('key', 'value')).not.toThrow();
    });
  });

  describe('removeLocalStorage', () => {
    it('should remove a stored key', () => {
      localStorage.setItem('key', 'value');
      removeLocalStorage('key');
      expect(localStorage.getItem('key')).toBeNull();
    });

    it('should not throw for non-existent key', () => {
      expect(() => removeLocalStorage('nonexistent')).not.toThrow();
    });
  });
});
