import { render, screen } from '@testing-library/react';
import { LoginForm } from '../components/login-form';

vi.mock('@arcaai/ui/tabs', () => ({
    Tabs: ({ children, ...props }: any) => <div data-testid="tabs" {...props}>{children}</div>,
    TabsList: ({ children, ...props }: any) => (
        <div role="tablist" {...props}>{children}</div>
    ),
    TabsTrigger: ({ children, value, ...props }: any) => (
        <button role="tab" data-value={value} {...props}>{children}</button>
    ),
    TabsContent: ({ children, value, ...props }: any) => (
        <div role="tabpanel" data-value={value} {...props}>{children}</div>
    ),
}));

vi.mock('@arcaai/ui/card', () => ({
    Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    CardDescription: ({ children, ...props }: any) => <p {...props}>{children}</p>,
    CardHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    CardTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
}));

vi.mock('../components/api-key-form', () => ({
    ApiKeyForm: () => <div data-testid="api-key-form">API Key Form</div>,
}));

vi.mock('../components/credentials-form', () => ({
    CredentialsForm: () => <div data-testid="credentials-form">Credentials Form</div>,
}));

vi.mock('lucide-react', () => ({
    Zap: () => <span data-testid="icon-zap" />,
}));

describe('LoginForm', () => {
    it('should render ArcaVox Playground heading', () => {
        render(<LoginForm />);
        expect(
            screen.getByRole('heading', { name: /arcavox playground/i }),
        ).toBeInTheDocument();
    });

    it('should render authentication description text', () => {
        render(<LoginForm />);
        expect(
            screen.getByText(/sign in to access the interactive sdk playground/i),
        ).toBeInTheDocument();
    });

    it('should render Authentication card title', () => {
        render(<LoginForm />);
        expect(screen.getByText('Authentication')).toBeInTheDocument();
    });

    it('should render method description', () => {
        render(<LoginForm />);
        expect(
            screen.getByText(/choose your authentication method/i),
        ).toBeInTheDocument();
    });

    it('should render API Key and Credentials tabs', () => {
        render(<LoginForm />);
        expect(screen.getByRole('tab', { name: /api key/i })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /credentials/i })).toBeInTheDocument();
    });

    it('should show API Key tab content', () => {
        render(<LoginForm />);
        expect(screen.getByTestId('api-key-form')).toBeInTheDocument();
    });

    it('should show Credentials tab content', () => {
        render(<LoginForm />);
        expect(screen.getByTestId('credentials-form')).toBeInTheDocument();
    });
});
