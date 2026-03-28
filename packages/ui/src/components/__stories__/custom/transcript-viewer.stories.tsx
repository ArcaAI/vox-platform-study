import type { Meta, StoryObj } from '@storybook/react-vite';

import { TranscriptViewer, type TranscriptEntry } from '../../custom/transcript-viewer';

const entries: TranscriptEntry[] = [
  { id: '1', text: 'Good morning, how are you feeling today?', timestamp: '09:00:12', speaker: 'Doctor', isFinal: true },
  { id: '2', text: 'I have been having headaches for the past week.', timestamp: '09:00:18', speaker: 'Patient', isFinal: true },
  { id: '3', text: 'Can you describe the location and intensity of the pain?', timestamp: '09:00:25', speaker: 'Doctor', isFinal: true },
  { id: '4', text: 'It is mostly behind my eyes, and it gets worse in the afternoon.', timestamp: '09:00:34', speaker: 'Patient', isFinal: true },
  { id: '5', text: 'Have you noticed any visual disturbances or nausea?', timestamp: '09:00:42', speaker: 'Doctor', isFinal: true },
];

const partialEntries: TranscriptEntry[] = [
  ...entries.slice(0, 3),
  { id: '4-partial', text: 'It is mostly behind my...', speaker: 'Patient', isFinal: false },
];

const meta = {
  title: 'Custom/TranscriptViewer',
  component: TranscriptViewer,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    maxHeight: {
      control: 'text',
      description: 'Maximum height of the scroll area',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TranscriptViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    entries,
  },
};

export const WithLiveTranscript: Story = {
  args: {
    entries,
    currentTranscript: 'No, but sometimes I feel a bit dizzy when...',
  },
};

export const PartialEntries: Story = {
  args: {
    entries: partialEntries,
    currentTranscript: 'It is mostly behind my eyes and it gets...',
  },
};

export const Empty: Story = {
  args: {
    entries: [],
  },
};

export const SingleEntry: Story = {
  args: {
    entries: [entries[0]],
  },
};

export const WithoutTimestamps: Story = {
  args: {
    entries: entries.map(({ timestamp: _, ...rest }) => rest),
  },
};

export const WithoutSpeakers: Story = {
  args: {
    entries: entries.map(({ speaker: _, ...rest }) => rest),
  },
};

export const LongConversation: Story = {
  args: {
    entries: Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      text: `This is message number ${i + 1} in a long conversation to demonstrate scrolling behavior.`,
      timestamp: `09:${String(Math.floor(i / 2)).padStart(2, '0')}:${String((i % 2) * 30).padStart(2, '0')}`,
      speaker: i % 2 === 0 ? 'Doctor' : 'Patient',
      isFinal: true,
    })),
    maxHeight: '300px',
  },
};

export const CustomHeight: Story = {
  args: {
    entries,
    maxHeight: '200px',
  },
};
