import type { Meta, StoryObj } from '@storybook/react-vite';

import { SpeechInput } from '../../../registries/ai-elements/speech-input';

const meta = {
  title: 'Registries/AiElements/SpeechInput',
  component: SpeechInput,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SpeechInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    onTranscriptionChange: (text: string) => console.log('Transcription:', text),
  },
};
