import { render, screen } from '@testing-library/react';
import { GeneralError } from '../general-error';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { go: vi.fn() } }),
}));

vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

describe('GeneralError', () => {
  it('should render 500 heading', () => {
    render(<GeneralError />);
    expect(screen.getByText('500')).toBeInTheDocument();
  });

  it('should render error message text', () => {
    render(<GeneralError />);
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/we apologize for the inconvenience/i)).toBeInTheDocument();
  });

  it('should render Go Back button', () => {
    render(<GeneralError />);
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
  });

  it('should render Back to Home button', () => {
    render(<GeneralError />);
    expect(screen.getByRole('button', { name: /back to home/i })).toBeInTheDocument();
  });

  it('should not render 500 heading when minimal is true', () => {
    render(<GeneralError minimal />);
    expect(screen.queryByText('500')).not.toBeInTheDocument();
  });

  it('should not render buttons when minimal is true', () => {
    render(<GeneralError minimal />);
    expect(screen.queryByRole('button', { name: /go back/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back to home/i })).not.toBeInTheDocument();
  });

  it('should still render error message when minimal is true', () => {
    render(<GeneralError minimal />);
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});
