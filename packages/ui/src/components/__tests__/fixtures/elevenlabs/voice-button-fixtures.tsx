import * as React from 'react';
import { MicIcon } from 'lucide-react';

import { VoiceButton, type VoiceButtonState } from '../../../elevenlabs/voice-button';

export function BasicVoiceButton({ state = 'idle' }: { state?: VoiceButtonState }) {
  return <VoiceButton state={state} label="Voice Input" trailing="⌥Space" data-testid="voice-button" />;
}

export function VoiceButtonWithCallbacks() {
  const [lastAction, setLastAction] = React.useState('');
  return (
    <div>
      <VoiceButton label="Voice Input" onPress={() => setLastAction('pressed')} data-testid="voice-button" />
      <span data-testid="last-action">{lastAction}</span>
    </div>
  );
}

export function IconVoiceButton({ state = 'idle' }: { state?: VoiceButtonState }) {
  return <VoiceButton state={state} size="icon" icon={<MicIcon className="h-4 w-4" />} data-testid="voice-button" />;
}

export function DisabledVoiceButton() {
  return <VoiceButton label="Voice Input" disabled data-testid="voice-button" />;
}
