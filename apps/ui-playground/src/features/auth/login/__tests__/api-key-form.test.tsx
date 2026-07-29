import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeyForm } from '../components/api-key-form';

vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@arcaai/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock('@arcaai/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ redirect: undefined }),
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => {
    const store = { setApiKeyAuth: vi.fn() };
    return selector ? selector(store) : store;
  },
}));

vi.mock('lucide-react', () => ({
  Key: () => <span data-testid="icon-key" />,
  Building2: () => <span data-testid="icon-building" />,
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: (schema: any) => {
    return async (values: any) => {
      try {
        const result = schema.safeParse(values);
        if (result.success) {
          return { values: result.data, errors: {} };
        }
        const fieldErrors: Record<string, any> = {};
        for (const issue of result.error.issues) {
          const path = issue.path.join('.');
          if (!fieldErrors[path]) {
            fieldErrors[path] = { message: issue.message, type: issue.code };
          }
        }
        return { values: {}, errors: fieldErrors };
      } catch {
        return { values: {}, errors: {} };
      }
    };
  },
}));

describe('ApiKeyForm', () => {
  it('should render API Key input field', () => {
    render(<ApiKeyForm />);
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
  });

  it('should render Tenant ID input field', () => {
    render(<ApiKeyForm />);
    expect(screen.getByLabelText(/tenant id/i)).toBeInTheDocument();
  });

  it('should render submit button with "Connect with API Key" text', () => {
    render(<ApiKeyForm />);
    expect(screen.getByRole('button', { name: /connect with api key/i })).toBeInTheDocument();
  });

  it('should show validation error when submitting empty API key', async () => {
    const user = userEvent.setup();
    render(<ApiKeyForm />);

    await user.click(screen.getByRole('button', { name: /connect with api key/i }));

    await waitFor(() => {
      expect(screen.getByText(/api key is required/i)).toBeInTheDocument();
    });
  });

  it('should show validation error when submitting empty tenant ID', async () => {
    const user = userEvent.setup();
    render(<ApiKeyForm />);

    const apiKeyInput = screen.getByLabelText(/api key/i);
    await user.type(apiKeyInput, 'test-api-key-123');
    await user.click(screen.getByRole('button', { name: /connect with api key/i }));

    await waitFor(() => {
      expect(screen.getByText(/must be a valid tenant uuid/i)).toBeInTheDocument();
    });
  });

  it('should accept input in API Key field', async () => {
    const user = userEvent.setup();
    render(<ApiKeyForm />);

    const apiKeyInput = screen.getByLabelText(/api key/i);
    await user.type(apiKeyInput, 'my-secret-key');

    expect(apiKeyInput).toHaveValue('my-secret-key');
  });

  it('should accept input in Tenant ID field', async () => {
    const user = userEvent.setup();
    render(<ApiKeyForm />);

    const tenantIdInput = screen.getByLabelText(/tenant id/i);
    await user.type(tenantIdInput, '50000000-0000-0000-0000-000000000001');

    expect(tenantIdInput).toHaveValue('50000000-0000-0000-0000-000000000001');
  });
});
