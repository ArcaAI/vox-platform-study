import { render, screen } from '@testing-library/react';
import { CtaCard, type CtaProps } from '../cta-card';

vi.mock('@arcaai/ui/card', () => ({
    Card: ({ children, ...props }: any) => <div data-testid="card" {...props}>{children}</div>,
    CardHeader: ({ children, ...props }: any) => <div data-testid="card-header" {...props}>{children}</div>,
    CardTitle: ({ children, ...props }: any) => <h3 data-testid="card-title" {...props}>{children}</h3>,
    CardDescription: ({ children, ...props }: any) => <p data-testid="card-description" {...props}>{children}</p>,
    CardContent: ({ children, ...props }: any) => <div data-testid="card-content" {...props}>{children}</div>,
    CardFooter: ({ children, ...props }: any) => <div data-testid="card-footer" {...props}>{children}</div>,
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@tanstack/react-router', () => ({
    Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

const defaultProps: CtaProps = {
    title: 'Try the Playground',
    description: 'Explore the SDK interactively.',
    buttonLabel: 'Get Started',
    href: '/installation',
};

describe('CtaCard', () => {
    it('should render the title', () => {
        render(<CtaCard {...defaultProps} />);
        expect(screen.getByText('Try the Playground')).toBeInTheDocument();
    });

    it('should render the description', () => {
        render(<CtaCard {...defaultProps} />);
        expect(screen.getByText('Explore the SDK interactively.')).toBeInTheDocument();
    });

    it('should render a button with the correct label', () => {
        render(<CtaCard {...defaultProps} />);
        expect(screen.getByRole('button', { name: 'Get Started' })).toBeInTheDocument();
    });

    it('should link to the provided href', () => {
        render(<CtaCard {...defaultProps} />);
        const link = screen.getByRole('link');
        expect(link).toHaveAttribute('href', '/installation');
    });

    it('should use Card composition (header, content/footer)', () => {
        render(<CtaCard {...defaultProps} />);
        expect(screen.getByTestId('card')).toBeInTheDocument();
        expect(screen.getByTestId('card-header')).toBeInTheDocument();
        expect(screen.getByTestId('card-title')).toBeInTheDocument();
        expect(screen.getByTestId('card-description')).toBeInTheDocument();
    });
});
