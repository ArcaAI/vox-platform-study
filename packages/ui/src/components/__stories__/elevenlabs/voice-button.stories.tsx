import type { Meta, StoryObj } from '@storybook/react-vite';
import { MicIcon } from 'lucide-react';

import { VoiceButton } from '../../elevenlabs/voice-button';

const meta: Meta<typeof VoiceButton> = {
  title: 'ElevenLabs/VoiceButton',
  component: VoiceButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    state: {
      control: 'select',
      options: ['idle', 'recording', 'processing', 'success', 'error'],
      description: 'Current state of the voice button',
    },
    variant: {
      control: 'select',
      options: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'],
      description: 'Button variant',
    },
    size: {
      control: 'select',
      options: ['default', 'sm', 'lg', 'icon'],
      description: 'Button size',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the button is disabled',
    },
  },
};

export default meta;
type Story = StoryObj<typeof VoiceButton>;

export const Idle: Story = {
  args: {
    state: 'idle',
    label: 'Voice Input',
    trailing: '⌥Space',
  },
};

export const Recording: Story = {
  args: {
    state: 'recording',
    label: 'Recording',
  },
};

export const Processing: Story = {
  args: {
    state: 'processing',
    label: 'Processing',
  },
};

export const Success: Story = {
  args: {
    state: 'success',
    label: 'Done',
  },
};

export const Error: Story = {
  args: {
    state: 'error',
    label: 'Error',
  },
};

export const IconSize: Story = {
  args: {
    state: 'idle',
    size: 'icon',
    icon: <MicIcon className="h-4 w-4" />,
  },
};

export const IconRecording: Story = {
  args: {
    state: 'recording',
    size: 'icon',
    icon: <MicIcon className="h-4 w-4" />,
  },
};

export const Disabled: Story = {
  args: {
    state: 'idle',
    label: 'Voice Input',
    disabled: true,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['default', 'outline', 'secondary', 'ghost'] as const).map((variant) => (
        <VoiceButton key={variant} variant={variant} label={`${variant} variant`} trailing="⌥Space" />
      ))}
    </div>
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['idle', 'recording', 'processing', 'success', 'error'] as const).map((state) => (
        <VoiceButton key={state} state={state} label={state} />
      ))}
    </div>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <VoiceButton size="sm" label="Small" />
      <VoiceButton size="default" label="Default" />
      <VoiceButton size="lg" label="Large" />
      <VoiceButton size="icon" icon={<MicIcon className="h-4 w-4" />} />
    </div>
  ),
};
