import { render, screen } from '@testing-library/react';
import { UnauthorizedError } from '../unauthorized-error';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

describe('UnauthorizedError', () => {
  it('should render 401 heading', () => {
    render(<UnauthorizedError />);
    expect(screen.getByText('401')).toBeInTheDocument();
  });

  it('should render "Unauthorized" message', () => {
    render(<UnauthorizedError />);
    expect(screen.getByText('Unauthorized')).toBeInTheDocument();
  });

  it('should render descriptive text about session expiry', () => {
    render(<UnauthorizedError />);
    expect(screen.getByText(/session has expired/i)).toBeInTheDocument();
  });

  it('should render Go to Login button', () => {
    render(<UnauthorizedError />);
    expect(screen.getByRole('button', { name: /go to login/i })).toBeInTheDocument();
  });

  it('should not render Go Back or Back to Home buttons', () => {
    render(<UnauthorizedError />);
    expect(screen.queryByRole('button', { name: /go back/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back to home/i })).not.toBeInTheDocument();
  });
});
