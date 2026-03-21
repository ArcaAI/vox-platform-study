import { AudioPipeline } from '@/features/admin/api/audio-pipelines';
import { cn } from '@/lib/utils';
import { useAudioStore, type ProcessingMethod } from '@/store/audio-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { Slider } from '@arcaai/ui/slider';
import { Switch } from '@arcaai/ui/switch';
import { useArcaConfig, usePipelines } from '@arcaai/vox';
import { AlertCircle, Brain, Languages, Lock, Repeat, Server, Settings, Volume2 } from 'lucide-react';
import type React from 'react';
import { useEffect } from 'react';

const SUPPORTED_LANGUAGES = [
    { value: 'en', label: 'English' },
    { value: 'hi', label: 'Hindi' },
    { value: 'ta', label: 'Tamil' },
    { value: 'ml', label: 'Malayalam' },
    { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'th', label: 'Thai' },
] as const;

const FALLBACK_ASR_MODELS = [
    { id: 'whisper-tiny', name: 'Whisper Tiny', size: '~75 MB' },
    { id: 'whisper-base', name: 'Whisper Base', size: '~150 MB' },
    { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
] as const;

const PROCESSING_METHODS: { value: ProcessingMethod; label: string; icon: typeof Brain; description: string; color: string }[] = [
    {
        value: 'local_ai',
        label: 'Local AI',
        icon: Brain,
        description: 'On-device Whisper with VAD & noise cancellation',
        color: 'text-purple-500',
    },
    {
        value: 'backend_socket',
        label: 'Backend (WebSocket)',
        icon: Server,
        description: 'Stream audio to backend via WebSocket',
        color: 'text-blue-500',
    },
];

const CONFIG_PATHS = {
    language: 'stt.language',
    noiseSuppression: 'audio.noiseSuppression',
    noiseFilterLevel: 'audio.noiseFilterLevel',
    vadEnabled: 'audio.vadEnabled',
    vadThreshold: 'audio.vadThreshold',
    diarization: 'audio.diarization',
    codeSwitching: 'audio.codeSwitching',
    defaultModel: 'stt.defaultModel',
} as const;

function LockedIndicator() {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Lock className="text-muted-foreground size-3.5 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>
                <p className="text-xs">Locked by tenant</p>
            </TooltipContent>
        </Tooltip>
    );
}

export function ProcessingConfigPanel() {
    const {
        processingMethod,
        setProcessingMethod,
        noiseFilterEnabled,
        noiseFilterLevel,
        vadEnabled,
        vadThreshold,
        diarizationEnabled,
        codeSwitchingEnabled,
        whisperModel,
        availableAsrModels,
        language,
        isCapturing,
        configReady,
        selectedPipelineId,
        toggleNoiseFilter,
        setNoiseFilterLevel,
        toggleVAD,
        setVADThreshold,
        toggleDiarization,
        toggleCodeSwitching,
        setWhisperModel,
        setLanguage,
        setSelectedPipelineId,
    } = useAudioStore();
    const { isLocked, setUserPreference } = useArcaConfig();
    const { pipelines, isLoading: pipelinesLoading, error: pipelinesError, list: listPipelines } = usePipelines();
    const controlsDisabled = isCapturing || !configReady;

    useEffect(() => {
        listPipelines();
    }, [listPipelines]);

    useEffect(() => {
        if (processingMethod !== 'backend_socket' || pipelinesLoading || pipelines.length === 0) return;
        const currentValid = pipelines.some((p) => p.id === selectedPipelineId);
        if (!selectedPipelineId || !currentValid) {
            setSelectedPipelineId(pipelines[0].id);
        }
    }, [processingMethod, pipelinesLoading, pipelines, selectedPipelineId, setSelectedPipelineId]);

    const locked = {
        language: isLocked(CONFIG_PATHS.language),
        noiseSuppression: isLocked(CONFIG_PATHS.noiseSuppression),
        noiseFilterLevel: isLocked(CONFIG_PATHS.noiseFilterLevel),
        vadEnabled: isLocked(CONFIG_PATHS.vadEnabled),
        vadThreshold: isLocked(CONFIG_PATHS.vadThreshold),
        diarization: isLocked(CONFIG_PATHS.diarization),
        codeSwitching: isLocked(CONFIG_PATHS.codeSwitching),
        defaultModel: isLocked(CONFIG_PATHS.defaultModel),
    };

    const handleLanguageChange = (value: string) => {
        if (setUserPreference(CONFIG_PATHS.language, value)) {
            setLanguage(value);
        }
    };
    const handleNoiseFilterToggle = () => {
        const next = !noiseFilterEnabled;
        if (setUserPreference(CONFIG_PATHS.noiseSuppression, next)) {
            toggleNoiseFilter();
        }
    };
    const handleNoiseFilterLevelChange = (level: 'low' | 'medium' | 'high') => {
        if (setUserPreference(CONFIG_PATHS.noiseFilterLevel, level)) {
            setNoiseFilterLevel(level);
        }
    };
    const handleVADToggle = () => {
        const next = !vadEnabled;
        if (setUserPreference(CONFIG_PATHS.vadEnabled, next)) {
            toggleVAD();
        }
    };
    const handleVADThresholdChange = (value: number) => {
        if (setUserPreference(CONFIG_PATHS.vadThreshold, value)) {
            setVADThreshold(value);
        }
    };
    const handleDiarizationToggle = () => {
        const next = !diarizationEnabled;
        if (setUserPreference(CONFIG_PATHS.diarization, next)) {
            toggleDiarization();
        }
    };
    const handleCodeSwitchingToggle = () => {
        const next = !codeSwitchingEnabled;
        if (setUserPreference(CONFIG_PATHS.codeSwitching, next)) {
            toggleCodeSwitching();
        }
    };
    const asrModelOptions = availableAsrModels.length > 0 ? availableAsrModels : FALLBACK_ASR_MODELS;
    const selectedAsrModel = asrModelOptions.find((model) => model.id === whisperModel);

    return (
        <TooltipProvider>
            <div className="space-y-4">
                <Card data-doc="processing-methods">
                    <CardHeader className="pb-3">
                        <div className="flex items-center gap-2">
                            <Settings className="size-4" />
                            <CardTitle className="text-sm">Processing Method</CardTitle>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {PROCESSING_METHODS.map((method) => {
                            const Icon = method.icon;
                            return (
                                <button
                                    key={method.value}
                                    data-doc={method.value === 'local_ai' ? 'local-ai' : 'backend-socket'}
                                    type="button"
                                    onClick={() => setProcessingMethod(method.value)}
                                    disabled={isCapturing}
                                    className={cn(
                                        'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-all',
                                        processingMethod === method.value
                                            ? 'border-primary bg-primary/5 shadow-sm'
                                            : 'hover:bg-accent disabled:opacity-50',
                                    )}
                                >
                                    <Icon className={cn('size-4 shrink-0', method.color)} />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs font-medium">{method.label}</p>
                                        <p className="text-muted-foreground truncate text-[10px]">{method.description}</p>
                                    </div>
                                    {processingMethod === method.value && <div className="bg-primary size-2 shrink-0 rounded-full" />}
                                </button>
                            );
                        })}
                    </CardContent>
                </Card>

                {processingMethod === 'backend_socket' && (
                    <Card data-doc="audio-pipeline">
                        <CardHeader className="pb-3">
                            <div className="flex items-center gap-2">
                                <Server className="size-4 text-blue-500" />
                                <CardTitle className="text-sm">Audio Pipeline</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {pipelinesLoading ? (
                                <div className="bg-muted h-8 animate-pulse rounded-md" />
                            ) : pipelinesError ? (
                                <div className="bg-destructive/10 flex items-center gap-2 rounded-md p-2">
                                    <AlertCircle className="text-destructive size-4 shrink-0" />
                                    <span className="text-destructive text-[10px]">Failed to load pipelines</span>
                                </div>
                            ) : (
                                <Select value={selectedPipelineId ?? undefined} onValueChange={setSelectedPipelineId} disabled={controlsDisabled}>
                                    <SelectTrigger className="h-8 w-full min-w-0 text-xs">
                                        <SelectValue placeholder="Select a pipeline..." className="truncate" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {pipelines.map((pipeline: AudioPipeline) => (
                                            <SelectItem key={pipeline.id} value={pipeline.id} className="text-xs">
                                                <span className="block w-full truncate">{pipeline.name}</span>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </CardContent>
                    </Card>
                )}

                {processingMethod === 'local_ai' && (
                    <Card data-doc="local-ai-model">
                        <CardHeader className="pb-3">
                            <div className="flex items-center gap-2">
                                <Brain className="size-4 text-purple-500" />
                                <CardTitle className="text-sm">Local AI Model</CardTitle>
                                {locked.defaultModel && <LockedIndicator />}
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <Select value={whisperModel} onValueChange={setWhisperModel} disabled={controlsDisabled || locked.defaultModel}>
                                <SelectTrigger className="h-8 w-full min-w-0 text-xs">
                                    <SelectValue className="truncate" />
                                </SelectTrigger>
                                <SelectContent>
                                    {asrModelOptions.map((model) => (
                                        <SelectItem key={model.id} value={model.id} className="text-xs">
                                            <span className="block w-full truncate">{model.name}</span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-muted-foreground truncate text-[10px]">{selectedAsrModel?.name ?? 'Select model'}</p>
                        </CardContent>
                    </Card>
                )}

                {processingMethod === 'local_ai' && (
                    <>
                        <Card data-doc="language">
                            <CardHeader className="pb-3">
                                <div className="flex items-center gap-2">
                                    <Languages className="size-4" />
                                    <CardTitle className="text-sm">Language</CardTitle>
                                    {locked.language && <LockedIndicator />}
                                </div>
                            </CardHeader>
                            <CardContent>
                                <Select value={language} onValueChange={handleLanguageChange} disabled={controlsDisabled || locked.language}>
                                    <SelectTrigger className="h-8 w-full min-w-0 text-xs">
                                        <SelectValue className="truncate" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {SUPPORTED_LANGUAGES.map((lang) => (
                                            <SelectItem key={lang.value} value={lang.value}>
                                                {lang.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-3">
                                <div data-doc="audio-processing" className="flex items-center gap-2">
                                    <Volume2 className="size-4" />
                                    <CardTitle className="text-sm">Audio Processing</CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex items-center justify-between" data-doc="noise-cancellation">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <Label className="truncate text-xs">Noise Cancellation</Label>
                                        {locked.noiseSuppression && <LockedIndicator />}
                                    </div>
                                    <Switch
                                        checked={noiseFilterEnabled}
                                        onCheckedChange={handleNoiseFilterToggle}
                                        disabled={controlsDisabled || locked.noiseSuppression}
                                    />
                                </div>
                                {noiseFilterEnabled && (
                                    <div className="flex gap-1.5">
                                        {(['low', 'medium', 'high'] as const).map((level) => (
                                            <Badge
                                                key={level}
                                                variant={noiseFilterLevel === level ? 'default' : 'outline'}
                                                className="cursor-pointer text-[10px] capitalize"
                                                onClick={() => !controlsDisabled && !locked.noiseFilterLevel && handleNoiseFilterLevelChange(level)}
                                                role="button"
                                                tabIndex={0}
                                                onKeyDown={(e: React.KeyboardEvent) => {
                                                    if ((e.key === 'Enter' || e.key === ' ') && !controlsDisabled && !locked.noiseFilterLevel) {
                                                        e.preventDefault();
                                                        handleNoiseFilterLevelChange(level);
                                                    }
                                                }}
                                            >
                                                {level}
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                                <Separator />
                                <div className="flex items-center justify-between" data-doc="vad">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <Label className="truncate text-xs">Voice Activity Detection</Label>
                                        {locked.vadEnabled && <LockedIndicator />}
                                    </div>
                                    <Switch checked={vadEnabled} onCheckedChange={handleVADToggle} disabled={controlsDisabled || locked.vadEnabled} />
                                </div>
                                {vadEnabled && (
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-1.5">
                                            <Label className="text-[10px]">VAD Sensitivity</Label>
                                            {locked.vadThreshold && <LockedIndicator />}
                                        </div>
                                        <Slider
                                            value={[vadThreshold * 100]}
                                            onValueChange={([val]) => handleVADThresholdChange(val / 100)}
                                            min={10}
                                            max={95}
                                            step={5}
                                            disabled={controlsDisabled || locked.vadThreshold}
                                        />
                                        <span className="text-muted-foreground text-[10px]">{(vadThreshold * 100).toFixed(0)}%</span>
                                    </div>
                                )}
                                <Separator />
                                <div className="flex items-center justify-between" data-doc="speaker-diarization">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <Label className="truncate text-xs">Speaker Diarization</Label>
                                        {locked.diarization && <LockedIndicator />}
                                    </div>
                                    <Switch
                                        checked={diarizationEnabled}
                                        onCheckedChange={handleDiarizationToggle}
                                        disabled={controlsDisabled || locked.diarization}
                                    />
                                </div>
                                <Separator />
                                <div className="flex items-center justify-between" data-doc="code-switching">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <Repeat className="text-muted-foreground size-3" />
                                        <Label className="truncate text-xs">Code-Switching</Label>
                                        {locked.codeSwitching && <LockedIndicator />}
                                    </div>
                                    <Switch
                                        checked={codeSwitchingEnabled}
                                        onCheckedChange={handleCodeSwitchingToggle}
                                        disabled={controlsDisabled || locked.codeSwitching}
                                    />
                                </div>
                                {codeSwitchingEnabled && (
                                    <p className="text-muted-foreground text-[10px]">
                                        Enables multi-language detection within a single audio stream.
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </TooltipProvider>
    );
}
