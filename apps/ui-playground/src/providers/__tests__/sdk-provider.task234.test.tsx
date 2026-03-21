import { vi } from 'vitest';

const { mockUseAutoRefresh } = vi.hoisted(() => ({
    mockUseAutoRefresh: vi.fn(),
}));

vi.mock('@/hooks/use-auto-refresh', () => ({
    useAutoRefresh: mockUseAutoRefresh,
}));

vi.mock('@arcaai/vox', () => ({
    AgenticProvider: ({ children }: any) => <div data-testid="agentic-provider">{children}</div>,
}));

vi.mock('@/store/auth-store', () => ({
    useAuthStore: vi.fn(() => ({
        authMethod: 'credentials',
        apiKey: '',
        tenantId: 'tid-1',
        accessToken: 'token-1',
        isImpersonating: false,
        impersonationToken: '',
    })),
}));

vi.mock('@/store/playground-store', () => ({
    usePlaygroundStore: vi.fn(() => ({
        apiBaseUrl: 'http://localhost:8868/api/v1',
        debugMode: false,
    })),
}));

import { render, screen } from '@testing-library/react';
import { SDKProvider } from '../sdk-provider';

describe('SDKProvider — TASK-234 auto-refresh integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should call useAutoRefresh inside the provider', () => {
        render(
            <SDKProvider>
                <div data-testid="child">child</div>
            </SDKProvider>,
        );

        expect(screen.getByTestId('child')).toBeInTheDocument();
        expect(mockUseAutoRefresh).toHaveBeenCalled();
    });
});
