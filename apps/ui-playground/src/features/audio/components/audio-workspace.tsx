import { AudioSourcePanel } from './audio-source-panel';
import { AudioMixerPanel } from './audio-mixer-panel';
import { BrowserCompatibilityBanner } from './browser-compatibility-banner';
import { ProcessingConfigPanel } from './processing-config-panel';
import { TranscriptPanel } from './transcript-panel';
import { useAudioStore, type MicrophoneSource } from '@/store/audio-store';

export function AudioWorkspace() {
    const { sources } = useAudioStore();
    const hasMicSources = sources.some((s): s is MicrophoneSource => s.type === 'microphone');

    return (
        <div className="space-y-4">
            <BrowserCompatibilityBanner />
            <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
                <div className="space-y-4">
                    <AudioSourcePanel />
                    {hasMicSources && <ProcessingConfigPanel />}
                </div>

                <div className="space-y-4">
                    {hasMicSources && <AudioMixerPanel />}
                    <TranscriptPanel />
                </div>
            </div>
        </div>
    );
}
