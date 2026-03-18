/**
 * BrowserCompatibilityBanner Tests (TASK-237)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { BrowserCompatibilityBanner } from '../browser-compatibility-banner';

vi.mock('@arcaai/room', () => ({
    useBrowserCapabilities: vi.fn(),
}));

vi.mock('@arcaai/ui/alert', () => ({
    Alert: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div data-testid="alert" data-variant={props.variant}>{children}</div>
    ),
    AlertTitle: ({ children }: React.PropsWithChildren) => <h5>{children}</h5>,
    AlertDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('@arcaai/ui/badge', () => ({
    Badge: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));

vi.mock('lucide-react', () => ({
    AlertTriangle: () => <svg data-testid="icon-alert-triangle" />,
    Ban: () => <svg data-testid="icon-ban" />,
    Info: () => <svg data-testid="icon-info" />,
}));

import { useBrowserCapabilities } from '@arcaai/room';
const mockUseBrowserCapabilities = vi.mocked(useBrowserCapabilities);

describe('BrowserCompatibilityBanner', () => {
    it('should render nothing when no limitations', () => {
        mockUseBrowserCapabilities.mockReturnValue({
            capabilities: {
                browserName: 'chrome',
                browserVersion: '120.0',
                isSupported: true,
                supportsMultipleMics: true,
                supportsAudioWorklet: true,
                audioWorkletReliable: true,
                supportsPersistentPermissions: true,
                supportsBackgroundAudio: true,
                supportsSharedArrayBuffer: true,
                supportsWasmSimd: true,
                requiresUserGesture: true,
                recommendedSampleRate: 48000,
            },
            limitations: [],
            isSupported: true,
            supportsMultipleMics: true,
            checkFeature: () => true,
        });

        const { container } = render(<BrowserCompatibilityBanner />);
        expect(container.firstChild).toBeNull();
    });

    it('should show blocker for unsupported browser', () => {
        mockUseBrowserCapabilities.mockReturnValue({
            capabilities: {
                browserName: 'unknown',
                browserVersion: '0',
                isSupported: false,
                supportsMultipleMics: false,
                supportsAudioWorklet: false,
                audioWorkletReliable: false,
                supportsPersistentPermissions: false,
                supportsBackgroundAudio: false,
                supportsSharedArrayBuffer: false,
                supportsWasmSimd: false,
                requiresUserGesture: true,
                recommendedSampleRate: 48000,
            },
            limitations: [
                {
                    feature: 'browser-version',
                    severity: 'blocker',
                    description: 'Browser not supported',
                    workaround: 'Update your browser',
                },
            ],
            isSupported: false,
            supportsMultipleMics: false,
            checkFeature: () => false,
        });

        render(<BrowserCompatibilityBanner />);
        expect(screen.getByText('Browser Not Supported')).toBeDefined();
    });

    it('should show Firefox multi-mic limitation', () => {
        mockUseBrowserCapabilities.mockReturnValue({
            capabilities: {
                browserName: 'firefox',
                browserVersion: '121.0',
                isSupported: true,
                supportsMultipleMics: false,
                supportsAudioWorklet: true,
                audioWorkletReliable: true,
                supportsPersistentPermissions: true,
                supportsBackgroundAudio: true,
                supportsSharedArrayBuffer: true,
                supportsWasmSimd: true,
                requiresUserGesture: true,
                recommendedSampleRate: 48000,
            },
            limitations: [
                {
                    feature: 'multiple-microphones',
                    severity: 'degraded',
                    description: 'Firefox cannot capture from multiple microphones simultaneously.',
                    workaround: 'Use single microphone mode.',
                },
            ],
            isSupported: true,
            supportsMultipleMics: false,
            checkFeature: (f: string) => f !== 'multiple-mics',
        });

        render(<BrowserCompatibilityBanner />);
        expect(screen.getByText('Limited Browser Support')).toBeDefined();
    });

    it('should show info-level limitations when no blockers or degraded', () => {
        mockUseBrowserCapabilities.mockReturnValue({
            capabilities: {
                browserName: 'safari',
                browserVersion: '17.4',
                isSupported: true,
                supportsMultipleMics: true,
                supportsAudioWorklet: true,
                audioWorkletReliable: true,
                supportsPersistentPermissions: false,
                supportsBackgroundAudio: true,
                supportsSharedArrayBuffer: true,
                supportsWasmSimd: true,
                requiresUserGesture: true,
                recommendedSampleRate: 48000,
            },
            limitations: [
                {
                    feature: 'persistent-permissions',
                    severity: 'info',
                    description: 'Safari only grants microphone permission for the current session.',
                },
            ],
            isSupported: true,
            supportsMultipleMics: true,
            checkFeature: (f: string) => f !== 'persistent-permissions',
        });

        render(<BrowserCompatibilityBanner />);
        expect(screen.getByText('Browser Notes')).toBeDefined();
    });
});
