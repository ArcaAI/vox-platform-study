// Browser API mocks for component testing
if (typeof window !== 'undefined') {
  // Mock matchMedia for useIsMobile hook
  window.matchMedia = window.matchMedia || function(query: string) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList
  }
}

// Import global styles for component tests
import '../src/styles/globals.css'

// This file serves as the entry point for Playwright component tests.
// The CSS import ensures all components have proper styling during tests.
