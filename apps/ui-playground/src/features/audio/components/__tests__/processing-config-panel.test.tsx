/**
 * ProcessingConfigPanel Tests (TASK-244)
 *
 * Tests the 3-tier config integration: locked fields, user preference persistence,
 * config-ready gating, and all audio processing controls.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

// ── shadcn/ui mocks ────────────────────────────────────────────────

vi.mock('@arcaai/ui/card', () => ({
    Card: ({ children, ...props }: any) => <div data-testid="card" {...props}>{children}</div>,
    CardContent: ({ children, ...props }: any) => <div data-testid="card-content" {...props}>{children}</div>,
    CardHeader: ({ children, ...props }: any) => <div data-testid="card-header" {...props}>{children}</div>,
    CardTitle: ({ children, ...props }: any) => <h3 data-testid="card-title" {...props}>{children}</h3>,
}));

vi.mock('@arcaai/ui/badge', () => ({
    Badge: ({ children, onClick, onKeyDown, variant, ...props }: any) => (
        <span
            data-testid="badge"
            data-variant={variant}
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={onKeyDown}
            {...props}
        >
            {children}
        </span>
    ),
}));

vi.mock('@arcaai/ui/label', () => ({
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock('@arcaai/ui/separator', () => ({
    Separator: () => <hr data-testid="separator" />,
}));

vi.mock('@arcaai/ui/slider', () => ({
    Slider: ({ value, onValueChange, disabled, ...props }: any) => (
        <input
            type="range"
            data-testid="slider"
            value={value?.[0] ?? 0}
            disabled={disabled}
            onChange={(e) => onValueChange?.([Number(e.target.value)])}
            {...props}
        />
    ),
}));

vi.mock('@arcaai/ui/switch', () => ({
    Switch: ({ checked, onCheckedChange, disabled, ...props }: any) => (
        <button
            role="switch"
            aria-checked={!!checked}
            data-testid="switch"
            disabled={disabled}
            onClick={() => !disabled && onCheckedChange?.(!checked)}
            {...props}
        />
    ),
}));

const SelectContext = React.createContext<{ onValueChange?: (v: string) => void }>({});

vi.mock('@arcaai/ui/select', () => ({
    Select: ({ children, value, onValueChange, disabled }: any) => (
        <SelectContext.Provider value={{ onValueChange }}>
            <div data-testid="select-root" data-value={value} data-disabled={disabled || undefined}>
                {children}
            </div>
        </SelectContext.Provider>
    ),
    SelectTrigger: ({ children, ...props }: any) => (
        <button data-testid="select-trigger" {...props}>{children}</button>
    ),
    SelectContent: ({ children }: any) => (
        <div data-testid="select-content">{children}</div>
    ),
    SelectItem: ({ children, value, ...props }: any) => {
        const { onValueChange } = React.useContext(SelectContext);
        return (
            <div
                data-testid="select-item"
                data-value={value}
                onClick={() => onValueChange?.(value)}
                {...props}
            >
                {children}
            </div>
        );
    },
    SelectValue: () => <span data-testid="select-value" />,
}));

vi.mock('@arcaai/ui/tooltip', () => ({
    Tooltip: ({ children }: any) => <>{children}</>,
    TooltipContent: ({ children }: any) => <div data-testid="tooltip-content">{children}</div>,
    TooltipProvider: ({ children }: any) => <>{children}</>,
    TooltipTrigger: ({ children, asChild }: any) => (asChild ? children : <span>{children}</span>),
}));

// ── lucide-react mocks ─────────────────────────────────────────────

vi.mock('lucide-react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('lucide-react')>();
    return {
        ...actual,
        AlertCircle: () => <svg data-testid="icon-alert-circle" />,
        Languages: () => <svg data-testid="icon-languages" />,
        Settings: () => <svg data-testid="icon-settings" />,
        Volume2: () => <svg data-testid="icon-volume" />,
        Brain: () => <svg data-testid="icon-brain" />,
        Server: () => <svg data-testid="icon-server" />,
        Repeat: () => <svg data-testid="icon-repeat" />,
        Lock: (props: any) => <svg data-testid="icon-lock" {...props} />,
    };
});

// ── @arcaai/vox mock ───────────────────────────────────────────────

const mockIsLocked = vi.fn<(path: string) => boolean>().mockReturnValue(false);
const mockSetUserPreference = vi.fn<(path: string, value: unknown) => boolean>().mockReturnValue(true);

const mockListPipelines = vi.fn<() => Promise<any[]>>().mockResolvedValue([]);
const mockUsePipelinesReturn = {
    pipelines: [
        { id: 'pipe-1', name: 'Pipeline Alpha', slug: 'pipeline-alpha', description: 'First pipeline' },
        { id: 'pipe-2', name: 'Pipeline Beta', slug: 'pipeline-beta', description: null },
    ],
    selectedPipeline: null,
    isLoading: false,
    error: null,
    list: mockListPipelines,
    get: vi.fn(),
    getBySlug: vi.fn(),
    select: vi.fn(),
    createPipeline: vi.fn(),
    updatePipeline: vi.fn(),
    deletePipeline: vi.fn(),
    validateConfig: vi.fn(),
    assignToTenant: vi.fn(),
};

let pipelinesOverrides: Partial<typeof mockUsePipelinesReturn> = {};

vi.mock('@arcaai/vox', () => ({
    useArcaConfig: () => ({
        isLocked: mockIsLocked,
        setUserPreference: mockSetUserPreference,
    }),
    usePipelines: () => ({ ...mockUsePipelinesReturn, ...pipelinesOverrides }),
}));

// ── audio store mock ───────────────────────────────────────────────

const mockSetProcessingMethod = vi.fn();
const mockToggleNoiseFilter = vi.fn();
const mockSetNoiseFilterLevel = vi.fn();
const mockToggleVAD = vi.fn();
const mockSetVADThreshold = vi.fn();
const mockToggleDiarization = vi.fn();
const mockToggleCodeSwitching = vi.fn();
const mockSetWhisperModel = vi.fn();
const mockSetLanguage = vi.fn();
const mockSetSelectedPipelineId = vi.fn();

const defaultStoreState = {
    processingMethod: 'backend_socket' as const,
    noiseFilterEnabled: false,
    noiseFilterLevel: 'medium' as const,
    vadEnabled: false,
    vadThreshold: 0.5,
    diarizationEnabled: false,
    codeSwitchingEnabled: false,
    whisperModel: 'whisper-tiny',
    availableAudioModels: [
        { id: 'whisper-tiny', name: 'Whisper Tiny', size: '~75 MB' },
        { id: 'whisper-base', name: 'Whisper Base', size: '~150 MB' },
        { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
    ],
    language: 'en',
    isCapturing: false,
    configReady: true,
    selectedPipelineId: null as string | null,
    setProcessingMethod: mockSetProcessingMethod,
    toggleNoiseFilter: mockToggleNoiseFilter,
    setNoiseFilterLevel: mockSetNoiseFilterLevel,
    toggleVAD: mockToggleVAD,
    setVADThreshold: mockSetVADThreshold,
    toggleDiarization: mockToggleDiarization,
    toggleCodeSwitching: mockToggleCodeSwitching,
    setWhisperModel: mockSetWhisperModel,
    setLanguage: mockSetLanguage,
    setSelectedPipelineId: mockSetSelectedPipelineId,
};

let storeOverrides: Partial<typeof defaultStoreState> = {};

vi.mock('@/store/audio-store', () => ({
    useAudioStore: () => ({ ...defaultStoreState, ...storeOverrides }),
}));

// ── import component under test ────────────────────────────────────

import { ProcessingConfigPanel } from '../processing-config-panel';

// ── helpers ────────────────────────────────────────────────────────

function renderPanel(overrides: Partial<typeof defaultStoreState> = {}) {
    storeOverrides = overrides;
    return render(<ProcessingConfigPanel />);
}

function getSwitch(label: RegExp) {
    const labelEl = screen.getByText(label);
    // Walk up to the flex row that contains both label and switch
    let container = labelEl.parentElement;
    while (container && !container.querySelector('[role="switch"]')) {
        container = container.parentElement;
    }
    const switchEl = container?.querySelector('[role="switch"]');
    if (!switchEl) throw new Error(`No switch found near label "${label}"`);
    return switchEl as HTMLElement;
}

function getSwitches() {
    return screen.getAllByRole('switch');
}

// ── tests ──────────────────────────────────────────────────────────

describe('ProcessingConfigPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeOverrides = {};
        pipelinesOverrides = {};
        mockIsLocked.mockReturnValue(false);
        mockSetUserPreference.mockReturnValue(true);
    });

    // ── 1. Processing method rendering ─────────────────────────────

    describe('processing method selection', () => {
        it('should render Local AI and Backend WebSocket options', () => {
            renderPanel();

            expect(screen.getByText('Local AI')).toBeInTheDocument();
            expect(screen.getByText('Backend (WebSocket)')).toBeInTheDocument();
        });

        it('should highlight the active processing method with an indicator dot', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const localBtn = screen.getByText('Local AI').closest('button')!;
            const dotInLocal = localBtn.querySelector('.rounded-full');
            expect(dotInLocal).toBeTruthy();

            const backendBtn = screen.getByText('Backend (WebSocket)').closest('button')!;
            const dotInBackend = backendBtn.querySelector('.rounded-full');
            expect(dotInBackend).toBeFalsy();
        });

        it('should call setProcessingMethod when clicking a method', () => {
            renderPanel();

            fireEvent.click(screen.getByText('Local AI').closest('button')!);
            expect(mockSetProcessingMethod).toHaveBeenCalledWith('local_ai');
        });

        it('should disable method buttons when isCapturing is true', () => {
            renderPanel({ isCapturing: true });

            const localBtn = screen.getByText('Local AI').closest('button')!;
            expect(localBtn).toBeDisabled();

            const backendBtn = screen.getByText('Backend (WebSocket)').closest('button')!;
            expect(backendBtn).toBeDisabled();
        });
    });

    // ── 2. Config-ready gate ───────────────────────────────────────

    describe('config-ready gate', () => {
        it('should disable Select-based controls when configReady is false', () => {
            renderPanel({ configReady: false, processingMethod: 'local_ai' });

            const modelCard = screen.getByText('Local AI Model').closest('[data-testid="card"]')!;
            const modelSelect = within(modelCard).getByTestId('select-root');
            expect(modelSelect.dataset.disabled).toBeDefined();
        });

        it('should disable switches when isCapturing is true', () => {
            renderPanel({ processingMethod: 'local_ai', isCapturing: true, noiseFilterEnabled: true, vadEnabled: true });

            const switches = getSwitches();
            for (const sw of switches) {
                expect(sw).toBeDisabled();
            }
        });

        it('should enable switches when configReady is true and isCapturing is false', () => {
            renderPanel({ processingMethod: 'local_ai', configReady: true, isCapturing: false });

            const switches = getSwitches();
            for (const sw of switches) {
                expect(sw).not.toBeDisabled();
            }
        });
    });

    // ── 3. Locked fields ───────────────────────────────────────────

    describe('locked fields', () => {
        it('should show lock indicator on language when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'stt.language');
            renderPanel({ processingMethod: 'local_ai' });

            const languageCard = screen.getByText('Language').closest('[data-testid="card"]')!;
            const lockIcon = within(languageCard).queryByTestId('icon-lock');
            expect(lockIcon).toBeInTheDocument();
        });

        it('should show lock indicator on noise cancellation when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.noiseSuppression');
            renderPanel({ processingMethod: 'local_ai' });

            const lockIcons = screen.getAllByTestId('icon-lock');
            expect(lockIcons.length).toBeGreaterThanOrEqual(1);
        });

        it('should show lock indicator on VAD when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.vadEnabled');
            renderPanel({ processingMethod: 'local_ai' });

            const lockIcons = screen.getAllByTestId('icon-lock');
            expect(lockIcons.length).toBeGreaterThanOrEqual(1);
        });

        it('should show lock indicator on diarization when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.diarization');
            renderPanel({ processingMethod: 'local_ai' });

            const lockIcons = screen.getAllByTestId('icon-lock');
            expect(lockIcons.length).toBeGreaterThanOrEqual(1);
        });

        it('should show lock indicator on code-switching when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.codeSwitching');
            renderPanel({ processingMethod: 'local_ai' });

            const lockIcons = screen.getAllByTestId('icon-lock');
            expect(lockIcons.length).toBeGreaterThanOrEqual(1);
        });

        it('should show lock indicator on default model when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'stt.defaultModel');
            renderPanel({ processingMethod: 'local_ai' });

            const modelCard = screen.getByText('Local AI Model').closest('[data-testid="card"]')!;
            const lockIcon = within(modelCard).queryByTestId('icon-lock');
            expect(lockIcon).toBeInTheDocument();
        });

        it('should disable language select when language is locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'stt.language');
            renderPanel({ processingMethod: 'local_ai' });

            const languageCard = screen.getByText('Language').closest('[data-testid="card"]')!;
            const selectRoot = within(languageCard).getByTestId('select-root');
            expect(selectRoot.dataset.disabled).toBeDefined();
        });

        it('should disable noise cancellation switch when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.noiseSuppression');
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Noise Cancellation/);
            expect(sw).toBeDisabled();
        });

        it('should disable VAD switch when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.vadEnabled');
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Voice Activity Detection/);
            expect(sw).toBeDisabled();
        });

        it('should disable diarization switch when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.diarization');
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Speaker Diarization/);
            expect(sw).toBeDisabled();
        });

        it('should disable code-switching switch when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.codeSwitching');
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Code-Switching/);
            expect(sw).toBeDisabled();
        });
    });

    // ── 4. Local AI Model card visibility ──────────────────────────

    describe('Local AI Model card', () => {
        it('should show Local AI Model card when processingMethod is local_ai', () => {
            renderPanel({ processingMethod: 'local_ai' });

            expect(screen.getByText('Local AI Model')).toBeInTheDocument();
        });

        it('should hide Local AI Model card when processingMethod is backend_socket', () => {
            renderPanel({ processingMethod: 'backend_socket' });

            expect(screen.queryByText('Local AI Model')).not.toBeInTheDocument();
        });

        it('should display available model options', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const modelCard = screen.getByText('Local AI Model').closest('[data-testid="card"]')!;
            const selectItems = within(modelCard).getAllByTestId('select-item');
            const labels = selectItems.map((el) => el.textContent?.trim());
            expect(labels).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Whisper Tiny'),
                    expect.stringContaining('Whisper Base'),
                    expect.stringContaining('Whisper Small'),
                ]),
            );
        });

        it('should display model size info', () => {
            renderPanel({ processingMethod: 'local_ai' });

            expect(screen.getByText('(~75 MB)')).toBeInTheDocument();
            expect(screen.getByText('(~150 MB)')).toBeInTheDocument();
            expect(screen.getByText('(~500 MB)')).toBeInTheDocument();
        });

        it('should disable model select when locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'stt.defaultModel');
            renderPanel({ processingMethod: 'local_ai' });

            const modelCard = screen.getByText('Local AI Model').closest('[data-testid="card"]')!;
            const selectRoot = within(modelCard).getByTestId('select-root');
            expect(selectRoot.dataset.disabled).toBeDefined();
        });
    });

    // ── 5. Language selector ───────────────────────────────────────

    describe('language selector', () => {
        it('should display supported languages', () => {
            renderPanel({ processingMethod: 'local_ai' });

            expect(screen.getByText('English')).toBeInTheDocument();
            expect(screen.getByText('Hindi')).toBeInTheDocument();
            expect(screen.getByText('Tamil')).toBeInTheDocument();
            expect(screen.getByText('Malayalam')).toBeInTheDocument();
            expect(screen.getByText('Spanish')).toBeInTheDocument();
            expect(screen.getByText('French')).toBeInTheDocument();
            expect(screen.getByText('German')).toBeInTheDocument();
            expect(screen.getByText('Thai')).toBeInTheDocument();
        });

        it('should call setUserPreference and setLanguage on language change', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const languageCard = screen.getByText('Language').closest('[data-testid="card"]')!;
            const frenchItem = within(languageCard).getByText('French');
            fireEvent.click(frenchItem);

            expect(mockSetUserPreference).toHaveBeenCalledWith('stt.language', 'fr');
            expect(mockSetLanguage).toHaveBeenCalledWith('fr');
        });

        it('should NOT call setLanguage when setUserPreference returns false', () => {
            mockSetUserPreference.mockReturnValue(false);
            renderPanel({ processingMethod: 'local_ai' });

            const languageCard = screen.getByText('Language').closest('[data-testid="card"]')!;
            const frenchItem = within(languageCard).getByText('French');
            fireEvent.click(frenchItem);

            expect(mockSetUserPreference).toHaveBeenCalledWith('stt.language', 'fr');
            expect(mockSetLanguage).not.toHaveBeenCalled();
        });
    });

    // ── 6. Audio processing toggles ────────────────────────────────

    describe('audio processing toggles', () => {
        it('should call setUserPreference and toggleNoiseFilter on noise toggle', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Noise Cancellation/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.noiseSuppression', true);
            expect(mockToggleNoiseFilter).toHaveBeenCalledTimes(1);
        });

        it('should NOT call toggleNoiseFilter when setUserPreference returns false', () => {
            mockSetUserPreference.mockReturnValue(false);
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Noise Cancellation/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.noiseSuppression', true);
            expect(mockToggleNoiseFilter).not.toHaveBeenCalled();
        });

        it('should call setUserPreference and toggleVAD on VAD toggle', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Voice Activity Detection/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.vadEnabled', true);
            expect(mockToggleVAD).toHaveBeenCalledTimes(1);
        });

        it('should NOT call toggleVAD when setUserPreference returns false', () => {
            mockSetUserPreference.mockReturnValue(false);
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Voice Activity Detection/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.vadEnabled', true);
            expect(mockToggleVAD).not.toHaveBeenCalled();
        });

        it('should call setUserPreference and toggleDiarization on diarization toggle', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Speaker Diarization/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.diarization', true);
            expect(mockToggleDiarization).toHaveBeenCalledTimes(1);
        });

        it('should NOT call toggleDiarization when setUserPreference returns false', () => {
            mockSetUserPreference.mockReturnValue(false);
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Speaker Diarization/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.diarization', true);
            expect(mockToggleDiarization).not.toHaveBeenCalled();
        });

        it('should call setUserPreference and toggleCodeSwitching on code-switching toggle', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Code-Switching/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.codeSwitching', true);
            expect(mockToggleCodeSwitching).toHaveBeenCalledTimes(1);
        });

        it('should NOT call toggleCodeSwitching when setUserPreference returns false', () => {
            mockSetUserPreference.mockReturnValue(false);
            renderPanel({ processingMethod: 'local_ai' });

            const sw = getSwitch(/Code-Switching/);
            fireEvent.click(sw);

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.codeSwitching', true);
            expect(mockToggleCodeSwitching).not.toHaveBeenCalled();
        });

        it('should reflect checked state for noise cancellation', () => {
            renderPanel({ processingMethod: 'local_ai', noiseFilterEnabled: true });

            const sw = getSwitch(/Noise Cancellation/);
            expect(sw.getAttribute('aria-checked')).toBe('true');
        });

        it('should reflect checked state for VAD', () => {
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true });

            const sw = getSwitch(/Voice Activity Detection/);
            expect(sw.getAttribute('aria-checked')).toBe('true');
        });

        it('should reflect checked state for diarization', () => {
            renderPanel({ processingMethod: 'local_ai', diarizationEnabled: true });

            const sw = getSwitch(/Speaker Diarization/);
            expect(sw.getAttribute('aria-checked')).toBe('true');
        });

        it('should reflect checked state for code-switching', () => {
            renderPanel({ processingMethod: 'local_ai', codeSwitchingEnabled: true });

            const sw = getSwitch(/Code-Switching/);
            expect(sw.getAttribute('aria-checked')).toBe('true');
        });
    });

    // ── 7. Noise filter level badges ───────────────────────────────

    describe('noise filter level badges', () => {
        it('should render level badges when noise filter is enabled', () => {
            renderPanel({ processingMethod: 'local_ai', noiseFilterEnabled: true });

            expect(screen.getByText('low')).toBeInTheDocument();
            expect(screen.getByText('medium')).toBeInTheDocument();
            expect(screen.getByText('high')).toBeInTheDocument();
        });

        it('should NOT render level badges when noise filter is disabled', () => {
            renderPanel({ processingMethod: 'local_ai', noiseFilterEnabled: false });

            expect(screen.queryByText('low')).not.toBeInTheDocument();
            expect(screen.queryByText('medium')).not.toBeInTheDocument();
            expect(screen.queryByText('high')).not.toBeInTheDocument();
        });

        it('should mark the active level badge with default variant', () => {
            renderPanel({ processingMethod: 'local_ai', noiseFilterEnabled: true, noiseFilterLevel: 'high' });

            const highBadge = screen.getByText('high').closest('[data-testid="badge"]')!;
            expect(highBadge.dataset.variant).toBe('default');

            const lowBadge = screen.getByText('low').closest('[data-testid="badge"]')!;
            expect(lowBadge.dataset.variant).toBe('outline');
        });

        it('should call setUserPreference and setNoiseFilterLevel on badge click', () => {
            renderPanel({ processingMethod: 'local_ai', noiseFilterEnabled: true, noiseFilterLevel: 'medium' });

            fireEvent.click(screen.getByText('high'));

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.noiseFilterLevel', 'high');
            expect(mockSetNoiseFilterLevel).toHaveBeenCalledWith('high');
        });

        it('should NOT change level when isCapturing is true', () => {
            renderPanel({ processingMethod: 'local_ai', noiseFilterEnabled: true, isCapturing: true });

            fireEvent.click(screen.getByText('high'));

            expect(mockSetUserPreference).not.toHaveBeenCalledWith('audio.noiseFilterLevel', expect.anything());
            expect(mockSetNoiseFilterLevel).not.toHaveBeenCalled();
        });

        it('should NOT change level when noiseFilterLevel is locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.noiseFilterLevel');
            renderPanel({ processingMethod: 'local_ai', noiseFilterEnabled: true });

            fireEvent.click(screen.getByText('high'));

            expect(mockSetUserPreference).not.toHaveBeenCalledWith('audio.noiseFilterLevel', expect.anything());
            expect(mockSetNoiseFilterLevel).not.toHaveBeenCalled();
        });
    });

    // ── 8. VAD threshold slider ────────────────────────────────────

    describe('VAD threshold slider', () => {
        it('should render slider when VAD is enabled', () => {
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true });

            expect(screen.getByTestId('slider')).toBeInTheDocument();
            expect(screen.getByText('VAD Sensitivity')).toBeInTheDocument();
        });

        it('should NOT render slider when VAD is disabled', () => {
            renderPanel({ processingMethod: 'local_ai', vadEnabled: false });

            expect(screen.queryByTestId('slider')).not.toBeInTheDocument();
            expect(screen.queryByText('VAD Sensitivity')).not.toBeInTheDocument();
        });

        it('should display current threshold percentage', () => {
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true, vadThreshold: 0.7 });

            expect(screen.getByText('70%')).toBeInTheDocument();
        });

        it('should call setUserPreference and setVADThreshold on slider change', () => {
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true, vadThreshold: 0.5 });

            const slider = screen.getByTestId('slider');
            fireEvent.change(slider, { target: { value: '75' } });

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.vadThreshold', 0.75);
            expect(mockSetVADThreshold).toHaveBeenCalledWith(0.75);
        });

        it('should NOT call setVADThreshold when setUserPreference returns false', () => {
            mockSetUserPreference.mockReturnValue(false);
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true, vadThreshold: 0.5 });

            const slider = screen.getByTestId('slider');
            fireEvent.change(slider, { target: { value: '75' } });

            expect(mockSetUserPreference).toHaveBeenCalledWith('audio.vadThreshold', 0.75);
            expect(mockSetVADThreshold).not.toHaveBeenCalled();
        });

        it('should disable slider when isCapturing is true', () => {
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true, isCapturing: true });

            expect(screen.getByTestId('slider')).toBeDisabled();
        });

        it('should disable slider when vadThreshold is locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.vadThreshold');
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true });

            expect(screen.getByTestId('slider')).toBeDisabled();
        });

        it('should show lock indicator for VAD sensitivity when vadThreshold is locked', () => {
            mockIsLocked.mockImplementation((path) => path === 'audio.vadThreshold');
            renderPanel({ processingMethod: 'local_ai', vadEnabled: true });

            const lockIcons = screen.getAllByTestId('icon-lock');
            expect(lockIcons.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ── 9. Code-switching info text ────────────────────────────────

    describe('code-switching info text', () => {
        it('should show info text when code-switching is enabled', () => {
            renderPanel({ processingMethod: 'local_ai', codeSwitchingEnabled: true });

            expect(
                screen.getByText('Enables multi-language detection within a single audio stream.'),
            ).toBeInTheDocument();
        });

        it('should NOT show info text when code-switching is disabled', () => {
            renderPanel({ processingMethod: 'local_ai', codeSwitchingEnabled: false });

            expect(
                screen.queryByText('Enables multi-language detection within a single audio stream.'),
            ).not.toBeInTheDocument();
        });
    });

    // ── 10. Card structure ─────────────────────────────────────────

    describe('card structure', () => {
        it('should render Processing Method card', () => {
            renderPanel();
            expect(screen.getByText('Processing Method')).toBeInTheDocument();
        });

        it('should render Language card', () => {
            renderPanel({ processingMethod: 'local_ai' });
            expect(screen.getByText('Language')).toBeInTheDocument();
        });

        it('should render Audio Processing card', () => {
            renderPanel({ processingMethod: 'local_ai' });
            expect(screen.getByText('Audio Processing')).toBeInTheDocument();
        });

        it('should render 3 cards by default (no local_ai)', () => {
            renderPanel({ processingMethod: 'backend_socket' });

            const titles = screen.getAllByTestId('card-title').map((t) => t.textContent);
            expect(titles).toEqual(
                expect.arrayContaining(['Processing Method', 'Audio Pipeline']),
            );
            expect(titles).not.toContain('Local AI Model');
        });

        it('should render 4 cards when processingMethod is local_ai', () => {
            renderPanel({ processingMethod: 'local_ai' });

            const titles = screen.getAllByTestId('card-title').map((t) => t.textContent);
            expect(titles).toEqual(
                expect.arrayContaining(['Processing Method', 'Local AI Model', 'Language', 'Audio Processing']),
            );
            expect(titles).not.toContain('Audio Pipeline');
        });
    });

    // ── 11. Audio Pipeline selection ──────────────────────────────────

    describe('Audio Pipeline selection', () => {
        it('should render the Audio Pipeline card when processing method is backend_socket', () => {
            renderPanel({ processingMethod: 'backend_socket' });
            expect(screen.getByText('Audio Pipeline')).toBeInTheDocument();
        });

        it('should NOT render Audio Pipeline card when processing method is local_ai', () => {
            renderPanel({ processingMethod: 'local_ai' });
            expect(screen.queryByText('Audio Pipeline')).not.toBeInTheDocument();
        });

        it('should display available pipelines in the dropdown', () => {
            renderPanel();

            const pipelineCard = screen.getByText('Audio Pipeline').closest('[data-testid="card"]')!;
            const selectItems = within(pipelineCard).getAllByTestId('select-item');
            const labels = selectItems.map((el) => el.textContent?.trim());
            expect(labels).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Pipeline Alpha'),
                    expect.stringContaining('Pipeline Beta'),
                ]),
            );
        });

        it('should enable pipeline select when processingMethod is backend_socket', () => {
            renderPanel({ processingMethod: 'backend_socket' });

            const pipelineCard = screen.getByText('Audio Pipeline').closest('[data-testid="card"]')!;
            const selectRoot = within(pipelineCard).getByTestId('select-root');
            expect(selectRoot.dataset.disabled).toBeUndefined();
        });

        it('should hide pipeline select when processingMethod is local_ai', () => {
            renderPanel({ processingMethod: 'local_ai' });

            expect(screen.queryByText('Audio Pipeline')).not.toBeInTheDocument();
            expect(screen.queryByTestId('select-root')).not.toBeInTheDocument();
        });

        it('should disable pipeline select when isCapturing is true', () => {
            renderPanel({ processingMethod: 'backend_socket', isCapturing: true });

            const pipelineCard = screen.getByText('Audio Pipeline').closest('[data-testid="card"]')!;
            const selectRoot = within(pipelineCard).getByTestId('select-root');
            expect(selectRoot.dataset.disabled).toBeDefined();
        });

        it('should call setSelectedPipelineId when a pipeline is selected', () => {
            renderPanel({ processingMethod: 'backend_socket' });

            const pipelineCard = screen.getByText('Audio Pipeline').closest('[data-testid="card"]')!;
            const item = within(pipelineCard).getByText('Pipeline Beta').closest('[data-testid="select-item"]')!;
            fireEvent.click(item);

            expect(mockSetSelectedPipelineId).toHaveBeenCalledWith('pipe-2');
        });

        it('should show loading skeleton when pipelines are loading', () => {
            pipelinesOverrides = { isLoading: true };
            renderPanel();

            const pipelineCard = screen.getByText('Audio Pipeline').closest('[data-testid="card"]')!;
            const skeleton = pipelineCard.querySelector('.animate-pulse');
            expect(skeleton).toBeTruthy();
        });

        it('should show error state when pipeline fetch fails', () => {
            pipelinesOverrides = { error: new Error('Network error'), pipelines: [] };
            renderPanel();

            expect(screen.getByText('Failed to load pipelines')).toBeInTheDocument();
        });

        it('should auto-select first pipeline when backend_socket and no selection', () => {
            renderPanel({ processingMethod: 'backend_socket', selectedPipelineId: null });

            expect(mockSetSelectedPipelineId).toHaveBeenCalledWith('pipe-1');
        });

        it('should not auto-select when processingMethod is local_ai', () => {
            renderPanel({ processingMethod: 'local_ai', selectedPipelineId: null });

            expect(mockSetSelectedPipelineId).not.toHaveBeenCalled();
        });

        it('should not auto-select when a valid pipeline is already selected', () => {
            renderPanel({ processingMethod: 'backend_socket', selectedPipelineId: 'pipe-2' });

            expect(mockSetSelectedPipelineId).not.toHaveBeenCalled();
        });

        it('should auto-select first pipeline when selected pipeline no longer exists', () => {
            renderPanel({ processingMethod: 'backend_socket', selectedPipelineId: 'deleted-pipe' });

            expect(mockSetSelectedPipelineId).toHaveBeenCalledWith('pipe-1');
        });

        it('should show pipeline description when available', () => {
            renderPanel();

            expect(screen.getByText('(First pipeline)')).toBeInTheDocument();
        });

        it('should call listPipelines on mount', () => {
            renderPanel();

            expect(mockListPipelines).toHaveBeenCalled();
        });
    });
});
