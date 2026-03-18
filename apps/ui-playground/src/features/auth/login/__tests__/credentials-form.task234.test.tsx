import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/store/auth-store';

const mockLogin = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@arcaai/vox', () => ({
    useAuth: () => ({ login: mockLogin }),
}));

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mockNavigate,
    useSearch: () => ({ redirect: undefined }),
}));

vi.mock('sonner', () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@arcaai/ui/input', () => ({
    Input: (props: any) => <input {...props} />,
}));

vi.mock('@arcaai/ui/label', () => ({
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock('lucide-react', () => ({
    User: () => <span />,
    Lock: () => <span />,
    Building2: () => <span />,
}));

import { CredentialsForm } from '../components/credentials-form';

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

describe('CredentialsForm — TASK-234 refresh token storage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        useAuthStore.getState().logout();
    });

    it('should store refreshToken from login response in auth store', async () => {
        mockLogin.mockResolvedValueOnce({
            token: 'access-jwt-123',
            refreshToken: 'refresh_u1_1234_abc',
            user: {
                id: 'u-1',
                email: 'test@test.com',
                username: 'tester',
                roles: ['admin'],
                permissions: ['read'],
                tenantId: TENANT_UUID,
                tenantKey: 'acme',
            },
        });

        render(<CredentialsForm />);

        await userEvent.type(screen.getByPlaceholderText(/enter your username/i), 'tester');
        await userEvent.type(screen.getByPlaceholderText(/enter your password/i), 'pass123');
        await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

        await waitFor(() => {
            expect(useAuthStore.getState().refreshToken).toBe('refresh_u1_1234_abc');
        });
    });

    it('should store empty refreshToken when login response has no refreshToken', async () => {
        mockLogin.mockResolvedValueOnce({
            token: 'access-jwt-123',
            user: {
                id: 'u-1',
                email: 'test@test.com',
                username: 'tester',
                roles: ['admin'],
                permissions: ['read'],
                tenantId: TENANT_UUID,
                tenantKey: 'acme',
            },
        });

        render(<CredentialsForm />);

        await userEvent.type(screen.getByPlaceholderText(/enter your username/i), 'tester');
        await userEvent.type(screen.getByPlaceholderText(/enter your password/i), 'pass123');
        await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

        await waitFor(() => {
            expect(useAuthStore.getState().refreshToken).toBe('');
        });
    });
});
