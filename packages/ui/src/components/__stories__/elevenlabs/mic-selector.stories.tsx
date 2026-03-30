import type { Meta, StoryObj } from '@storybook/react-vite';

import { MicSelector } from '../../elevenlabs/mic-selector';

const meta: Meta<typeof MicSelector> = {
  title: 'ElevenLabs/MicSelector',
  component: MicSelector,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    muted: {
      control: 'boolean',
      description: 'Whether the microphone is muted',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the selector is disabled',
    },
  },
};

export default meta;
type Story = StoryObj<typeof MicSelector>;

export const Default: Story = {
  args: {},
};

export const Muted: Story = {
  args: {
    muted: true,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const WithCallbacks: Story = {
  args: {
    onValueChange: (deviceId: string) => console.log('Device changed:', deviceId),
    onMutedChange: (muted: boolean) => console.log('Muted:', muted),
  },
};
