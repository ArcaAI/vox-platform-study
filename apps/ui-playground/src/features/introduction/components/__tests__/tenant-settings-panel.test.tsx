import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TenantAudioConfig } from '@arcaai/vox';
import { TenantSettingsPanel } from '../tenant-settings-panel';
import type { TenantConfig } from '@/features/admin/api/tenants';

vi.mock('@arcaai/ui/card', () => ({
    Card: ({ children, ...props }: any) => <div data-testid="card" {...props}>{children}</div>,
    CardContent: ({ children, ...props }: any) => <div data-testid="card-content" {...props}>{children}</div>,
    CardHeader: ({ children, ...props }: any) => <div data-testid="card-header" {...props}>{children}</div>,
    CardTitle: ({ children, ...props }: any) => <h3 data-testid="card-title" {...props}>{children}</h3>,
}));

vi.mock('@arcaai/ui/badge', () => ({
    Badge: ({ children, ...props }: any) => <span data-testid="badge" {...props}>{children}</span>,
}));

vi.mock('@arcaai/ui/skeleton', () => ({
    Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
}));

vi.mock('@arcaai/ui/switch', () => ({
    Switch: ({ checked, onCheckedChange, ...props }: any) => (
        <button
            role="switch"
            aria-checked={checked}
            data-testid="switch"
            onClick={() => onCheckedChange?.(!checked)}
            {...props}
        />
    ),
}));

vi.mock('@arcaai/ui/input', () => ({
    Input: (props: any) => <input data-testid="input" {...props} />,
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

const fullConfig: TenantAudioConfig = {
    defaultSttModel: 'whisper-large-v3',
    vadSensitivity: 0.5,
    defaultSmrProvider: 'ollama',
    defaultSmrModel: 'llama3.1:8b',
    defaultLanguage: 'en',
    features: {
        realTimeTranscription: true,
        nerExtraction: true,
        codeSwitching: false,
        dnaStyle: true,
        crossChainSummary: false,
    },
};

function makeRawConfig(overrides?: Partial<TenantConfig>): TenantConfig {
    return {
        id: 'cfg-001',
        name: 'Default Language',
        key: 'default-language',
        value: 'en',
        dataType: 'String',
        namespace: 'general',
        tenantId: 'tenant-1',
        tenantCode: 'ACME',
        ...overrides,
    };
}

const rawConfigs: TenantConfig[] = [
    makeRawConfig({ id: 'cfg-01', key: 'default-language', name: 'Default Language', value: 'en', namespace: 'general', dataType: 'String' }),
    makeRawConfig({ id: 'cfg-02', key: 'default-stt-model', name: 'Default STT Model', value: 'whisper-large-v3', namespace: 'stt', dataType: 'String' }),
    makeRawConfig({ id: 'cfg-03', key: 'vad-sensitivity', name: 'VAD Sensitivity', value: '0.5', namespace: 'stt', dataType: 'Float' }),
    makeRawConfig({ id: 'cfg-04', key: 'default-smr-provider', name: 'Default SMR Provider', value: 'ollama', namespace: 'smr', dataType: 'String' }),
    makeRawConfig({ id: 'cfg-05', key: 'default-smr-model', name: 'Default SMR Model', value: 'llama3.1:8b', namespace: 'smr', dataType: 'String' }),
    makeRawConfig({ id: 'cfg-06', key: 'enable-real-time-transcription', name: 'Real-time Transcription', value: 'true', namespace: 'feature-flags', dataType: 'Boolean' }),
    makeRawConfig({ id: 'cfg-07', key: 'enable-ner-extraction', name: 'NER Extraction', value: 'true', namespace: 'feature-flags', dataType: 'Boolean' }),
    makeRawConfig({ id: 'cfg-08', key: 'enable-code-switching', name: 'Code Switching', value: 'false', namespace: 'feature-flags', dataType: 'Boolean' }),
    makeRawConfig({ id: 'cfg-09', key: 'enable-dna-style', name: 'DNA Writing Style', value: 'true', namespace: 'feature-flags', dataType: 'Boolean' }),
    makeRawConfig({ id: 'cfg-10', key: 'enable-cross-chain-summary', name: 'Cross-Chain Summary', value: 'false', namespace: 'feature-flags', dataType: 'Boolean' }),
    makeRawConfig({ id: 'cfg-11', key: 'max-concurrent-sessions', name: 'Max Concurrent Sessions', value: '10', namespace: 'general', dataType: 'Integer' }),
    makeRawConfig({ id: 'cfg-12', key: 'session-timeout-minutes', name: 'Session Timeout (Minutes)', value: '30', namespace: 'general', dataType: 'Integer' }),
];

describe('TenantSettingsPanel', () => {
    describe('loading state', () => {
        it('should render skeleton cards when tenantConfig is null', () => {
            render(<TenantSettingsPanel tenantConfig={null} rawConfigs={undefined} onSave={vi.fn()} isSaving={false} />);
            const skeletons = screen.getAllByTestId('skeleton');
            expect(skeletons.length).toBeGreaterThan(0);
            const cards = screen.getAllByTestId('card');
            expect(cards).toHaveLength(4);
        });
    });

    describe('read-only display (no rawConfigs)', () => {
        it('should render the General section with language', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={undefined} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('General')).toBeInTheDocument();
            expect(screen.getByText('Default Language')).toBeInTheDocument();
            expect(screen.getByText('en')).toBeInTheDocument();
        });

        it('should render the Speech-to-Text section', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={undefined} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('Speech-to-Text')).toBeInTheDocument();
            expect(screen.getByText('whisper-large-v3')).toBeInTheDocument();
        });

        it('should render feature flags with Enabled/Disabled badges', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={undefined} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('Feature Flags')).toBeInTheDocument();
            expect(screen.getAllByText('Enabled')).toHaveLength(3);
            expect(screen.getAllByText('Disabled')).toHaveLength(2);
        });

        it('should not show a Save button when rawConfigs is not provided', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={undefined} onSave={vi.fn()} isSaving={false} />);
            expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
        });
    });

    describe('editable mode (rawConfigs provided)', () => {
        it('should render Switch controls for boolean configs', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={rawConfigs} onSave={vi.fn()} isSaving={false} />);
            const switches = screen.getAllByRole('switch');
            expect(switches.length).toBe(5);
        });

        it('should render Input controls for string/number configs', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={rawConfigs} onSave={vi.fn()} isSaving={false} />);
            const inputs = screen.getAllByTestId('input');
            expect(inputs.length).toBeGreaterThanOrEqual(5);
        });

        it('should show Save button only after a value is changed', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={rawConfigs} onSave={vi.fn()} isSaving={false} />);
            expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

            const switches = screen.getAllByRole('switch');
            fireEvent.click(switches[0]);

            expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
        });

        it('should call onSave with changed configs when Save is clicked', async () => {
            const onSave = vi.fn();
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={rawConfigs} onSave={onSave} isSaving={false} />);

            const switches = screen.getAllByRole('switch');
            fireEvent.click(switches[0]);

            const saveBtn = screen.getByRole('button', { name: /save/i });
            fireEvent.click(saveBtn);

            expect(onSave).toHaveBeenCalledTimes(1);
            const payload = onSave.mock.calls[0][0];
            expect(payload).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: expect.any(String), value: expect.any(String) }),
                ]),
            );
        });

        it('should disable Save button when isSaving is true', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={rawConfigs} onSave={vi.fn()} isSaving={true} />);

            const switches = screen.getAllByRole('switch');
            fireEvent.click(switches[0]);

            const saveBtn = screen.getByRole('button', { name: /save/i });
            expect(saveBtn).toBeDisabled();
        });
    });

    describe('partial config', () => {
        it('should handle config with missing optional fields gracefully', () => {
            const partialConfig: TenantAudioConfig = {
                features: {
                    realTimeTranscription: true,
                    nerExtraction: false,
                    codeSwitching: false,
                    dnaStyle: false,
                    crossChainSummary: false,
                },
            };
            render(<TenantSettingsPanel tenantConfig={partialConfig} rawConfigs={undefined} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('Feature Flags')).toBeInTheDocument();
            expect(screen.queryByText('Default STT Model')).not.toBeInTheDocument();
        });
    });

    describe('ux-constants namespace (available models)', () => {
        const uxRawConfigs: TenantConfig[] = [
            ...rawConfigs,
            makeRawConfig({
                id: 'cfg-13',
                key: 'local-asr-models',
                name: 'Local ASR Models',
                value: JSON.stringify([
                    { id: 'whisper-tiny', name: 'Whisper Tiny' },
                    { id: 'whisper-base', name: 'Whisper Base' },
                    { id: 'whisper-small', name: 'Whisper Small' },
                    { id: 'whisper-medium', name: 'Whisper Medium' },
                ]),
                namespace: 'ux-constants',
                dataType: 'Json',
            }),
            makeRawConfig({
                id: 'cfg-14',
                key: 'local-vad-models',
                name: 'Local VAD Models',
                value: JSON.stringify([
                    { id: 'silero-v5', name: 'Silero VAD v5' },
                    { id: 'silero-v6', name: 'Silero VAD v6' },
                ]),
                namespace: 'ux-constants',
                dataType: 'Json',
            }),
            makeRawConfig({
                id: 'cfg-15',
                key: 'local-noise-suppression-models',
                name: 'Local Noise Suppression Models',
                value: JSON.stringify([
                    { id: 'rnnoise', name: 'RNNoise' },
                ]),
                namespace: 'ux-constants',
                dataType: 'Json',
            }),
        ];

        it('should render the Available Models section header', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={uxRawConfigs} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('Available Models')).toBeInTheDocument();
        });

        it('should display ASR model names from ux-constants', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={uxRawConfigs} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('Whisper Tiny')).toBeInTheDocument();
            expect(screen.getByText('Whisper Base')).toBeInTheDocument();
        });

        it('should display VAD model names from ux-constants', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={uxRawConfigs} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('Silero VAD v5')).toBeInTheDocument();
            expect(screen.getByText('Silero VAD v6')).toBeInTheDocument();
        });

        it('should display noise suppression model names from ux-constants', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={uxRawConfigs} onSave={vi.fn()} isSaving={false} />);
            expect(screen.getByText('RNNoise')).toBeInTheDocument();
        });

        it('should not render ux-constants as editable Input fields', () => {
            render(<TenantSettingsPanel tenantConfig={fullConfig} rawConfigs={uxRawConfigs} onSave={vi.fn()} isSaving={false} />);
            const inputs = screen.getAllByTestId('input');
            const inputValues = inputs.map((i: HTMLElement) => (i as HTMLInputElement).value);
            expect(inputValues).not.toContain(expect.stringContaining('whisper-tiny'));
        });
    });
});
