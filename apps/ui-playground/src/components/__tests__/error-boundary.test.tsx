import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../error-boundary';

vi.mock('@/features/errors/general-error', () => ({
  GeneralError: () => <div data-testid="general-error">General Error Fallback</div>,
}));

function ThrowingComponent(): never {
  throw new Error('Test error');
}

function GoodComponent() {
  return <div>Good content</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should render children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <GoodComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Good content')).toBeInTheDocument();
  });

  it('should render GeneralError fallback when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('general-error')).toBeInTheDocument();
    expect(screen.getByText('General Error Fallback')).toBeInTheDocument();
  });

  it('should render custom fallback when provided and child throws', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback UI</div>}>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Custom fallback UI')).toBeInTheDocument();
    expect(screen.queryByTestId('general-error')).not.toBeInTheDocument();
  });

  it('should catch the error via componentDidCatch', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(console.error).toHaveBeenCalledWith(
      'ErrorBoundary caught:',
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });
});
