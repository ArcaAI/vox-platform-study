import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';

import { VoicePicker } from '../../elevenlabs/voice-picker';

const mockVoices: ElevenLabs.Voice[] = [
  {
    voiceId: 'voice-1',
    name: 'Rachel',
    previewUrl: 'https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/00.mp3',
    labels: { accent: 'American', gender: 'female', age: 'young' },
  } as ElevenLabs.Voice,
  {
    voiceId: 'voice-2',
    name: 'Drew',
    previewUrl: 'https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/01.mp3',
    labels: { accent: 'American', gender: 'male', age: 'middle aged' },
  } as ElevenLabs.Voice,
  {
    voiceId: 'voice-3',
    name: 'Clyde',
    previewUrl: 'https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/02.mp3',
    labels: { accent: 'American', gender: 'male', age: 'middle aged' },
  } as ElevenLabs.Voice,
  {
    voiceId: 'voice-4',
    name: 'Bella',
    labels: { accent: 'British', gender: 'female', age: 'young' },
  } as ElevenLabs.Voice,
  {
    voiceId: 'voice-5',
    name: 'Antoni',
    labels: { accent: 'American', gender: 'male', age: 'young' },
  } as ElevenLabs.Voice,
];

function VoicePickerDemo() {
  const [value, setValue] = useState<string>('');
  return (
    <div className="w-[300px]">
      <VoicePicker voices={mockVoices} value={value} onValueChange={setValue} />
    </div>
  );
}

function VoicePickerPreselected() {
  const [value, setValue] = useState<string>('voice-1');
  return (
    <div className="w-[300px]">
      <VoicePicker voices={mockVoices} value={value} onValueChange={setValue} />
    </div>
  );
}

const meta: Meta<typeof VoicePicker> = {
  title: 'ElevenLabs/VoicePicker',
  component: VoicePicker,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof VoicePicker>;

export const Default: Story = {
  render: () => <VoicePickerDemo />,
};

export const WithPreselectedVoice: Story = {
  render: () => <VoicePickerPreselected />,
};

export const CustomPlaceholder: Story = {
  render: () => {
    const [value, setValue] = useState<string>('');
    return (
      <div className="w-[300px]">
        <VoicePicker voices={mockVoices} value={value} onValueChange={setValue} placeholder="Choose your AI voice..." />
      </div>
    );
  },
};

export const EmptyVoiceList: Story = {
  render: () => {
    const [value, setValue] = useState<string>('');
    return (
      <div className="w-[300px]">
        <VoicePicker voices={[]} value={value} onValueChange={setValue} />
      </div>
    );
  },
};
