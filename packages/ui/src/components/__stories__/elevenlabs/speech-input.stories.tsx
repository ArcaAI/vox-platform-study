import type { Meta, StoryObj } from '@storybook/react-vite';

import { SpeechInput, SpeechInputRecordButton, SpeechInputPreview, SpeechInputCancelButton } from '../../elevenlabs/speech-input';

const mockGetToken = async () => 'mock-token';

const meta: Meta<typeof SpeechInput> = {
  title: 'ElevenLabs/SpeechInput',
  component: SpeechInput,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof SpeechInput>;

export const Default: Story = {
  render: () => (
    <SpeechInput getToken={mockGetToken}>
      <SpeechInputRecordButton />
      <SpeechInputPreview />
      <SpeechInputCancelButton />
    </SpeechInput>
  ),
};

export const SmallSize: Story = {
  render: () => (
    <SpeechInput getToken={mockGetToken} size="sm">
      <SpeechInputRecordButton />
      <SpeechInputPreview />
      <SpeechInputCancelButton />
    </SpeechInput>
  ),
};

export const LargeSize: Story = {
  render: () => (
    <SpeechInput getToken={mockGetToken} size="lg">
      <SpeechInputRecordButton />
      <SpeechInputPreview />
      <SpeechInputCancelButton />
    </SpeechInput>
  ),
};

export const RecordOnly: Story = {
  render: () => (
    <SpeechInput getToken={mockGetToken}>
      <SpeechInputRecordButton />
    </SpeechInput>
  ),
};

export const WithCustomPlaceholder: Story = {
  render: () => (
    <SpeechInput getToken={mockGetToken}>
      <SpeechInputRecordButton />
      <SpeechInputPreview placeholder="Speak now..." />
      <SpeechInputCancelButton />
    </SpeechInput>
  ),
};

export const WithCallbacks: Story = {
  render: () => (
    <SpeechInput
      getToken={mockGetToken}
      onChange={(e) => console.log('Change:', e.transcript)}
      onStart={() => console.log('Started')}
      onStop={(e) => console.log('Stopped:', e.transcript)}
      onCancel={() => console.log('Cancelled')}
    >
      <SpeechInputRecordButton />
      <SpeechInputPreview />
      <SpeechInputCancelButton />
    </SpeechInput>
  ),
};
