import { render, screen } from '@testing-library/react';
import { ForbiddenError } from '../forbidden-error';

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

describe('ForbiddenError', () => {
    it('should render 403 heading', () => {
        render(<ForbiddenError />);
        expect(screen.getByText('403')).toBeInTheDocument();
    });

    it('should render "Access Forbidden" message', () => {
        render(<ForbiddenError />);
        expect(screen.getByText('Access Forbidden')).toBeInTheDocument();
    });

    it('should render descriptive text', () => {
        render(<ForbiddenError />);
        expect(
            screen.getByText(/don't have permission/i),
        ).toBeInTheDocument();
    });

    it('should render Go Back button', () => {
        render(<ForbiddenError />);
        expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
    });

    it('should render Back to Home button', () => {
        render(<ForbiddenError />);
        expect(screen.getByRole('button', { name: /back to home/i })).toBeInTheDocument();
    });
});
