import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureGateBoundary } from '../feature-gate-boundary';

const useFeatureGatesMock = vi.fn();
vi.mock('../use-feature-gates', () => ({ useFeatureGates: () => useFeatureGatesMock() }));

const notFoundMock = vi.fn(() => {
  // next/navigation's notFound() unwinds rendering via a thrown error the
  // nearest not-found boundary catches — mirror that so a component that
  // keeps rendering after calling it would fail the test instead of passing
  // by accident.
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound: () => notFoundMock() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeatureGateBoundary', () => {
  it('renders a skeleton while the gate map is loading — never the children, never a 404', () => {
    useFeatureGatesMock.mockReturnValue({ gates: {}, isLoading: true, isError: false });
    render(
      <FeatureGateBoundary gate="console.tools.mcp.enabled">
        <p>screen body</p>
      </FeatureGateBoundary>,
    );

    expect(screen.queryByText('screen body')).toBeNull();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('renders the children once the gate resolves true', () => {
    useFeatureGatesMock.mockReturnValue({ gates: { 'console.tools.mcp.enabled': true }, isLoading: false, isError: false });
    render(
      <FeatureGateBoundary gate="console.tools.mcp.enabled">
        <p>screen body</p>
      </FeatureGateBoundary>,
    );

    expect(screen.getByText('screen body')).toBeDefined();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('404s when the gate resolves false', () => {
    useFeatureGatesMock.mockReturnValue({ gates: { 'console.tools.mcp.enabled': false }, isLoading: false, isError: false });
    expect(() =>
      render(
        <FeatureGateBoundary gate="console.tools.mcp.enabled">
          <p>screen body</p>
        </FeatureGateBoundary>,
      ),
    ).toThrow('NEXT_NOT_FOUND');
    // React re-invokes a throwing render once in development to distinguish a
    // genuine render error from a transient one — assert it fired, not an
    // exact count that depends on that internal (and version-specific) retry.
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('404s when the gate key is absent from the map — fail closed, not "assume off is fine"', () => {
    useFeatureGatesMock.mockReturnValue({ gates: {}, isLoading: false, isError: false });
    expect(() =>
      render(
        <FeatureGateBoundary gate="console.mlflow.enabled">
          <p>screen body</p>
        </FeatureGateBoundary>,
      ),
    ).toThrow('NEXT_NOT_FOUND');
  });

  it('404s on an error state too — an outage never silently reveals a gated screen', () => {
    useFeatureGatesMock.mockReturnValue({ gates: {}, isLoading: false, isError: true });
    expect(() =>
      render(
        <FeatureGateBoundary gate="console.agenticPolicy.enabled">
          <p>screen body</p>
        </FeatureGateBoundary>,
      ),
    ).toThrow('NEXT_NOT_FOUND');
  });
});
