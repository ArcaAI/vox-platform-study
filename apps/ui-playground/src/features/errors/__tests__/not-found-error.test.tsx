import { render, screen } from '@testing-library/react';
import { NotFoundError } from '../not-found-error';

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

describe('NotFoundError', () => {
  it('should render 404 heading', () => {
    render(<NotFoundError />);
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('should render "Page Not Found" message', () => {
    render(<NotFoundError />);
    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
  });

  it('should render descriptive text', () => {
    render(<NotFoundError />);
    expect(screen.getByText(/the page you're looking for/i)).toBeInTheDocument();
  });

  it('should render Go Back button', () => {
    render(<NotFoundError />);
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
  });

  it('should render Back to Home button', () => {
    render(<NotFoundError />);
    expect(screen.getByRole('button', { name: /back to home/i })).toBeInTheDocument();
  });
});
