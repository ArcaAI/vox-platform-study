import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ModelSelector, type ModelOption } from '../../custom/model-selector';

const models: ModelOption[] = [
  { id: 'gpt-4o', name: 'GPT-4o', source: 'backend', description: 'Latest multimodal model' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', source: 'backend', description: 'Fast and affordable' },
  { id: 'whisper-large', name: 'Whisper Large v3', source: 'huggingface', description: 'Speech recognition' },
  { id: 'whisper-local', name: 'Whisper Local', source: 'local', description: 'On-device transcription' },
];

const meta = {
  title: 'Custom/ModelSelector',
  component: ModelSelector,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    isLoading: {
      control: 'boolean',
      description: 'Whether models are loading',
    },
    noneOption: {
      control: 'boolean',
      description: 'Show a "None" option',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModelSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    label: 'AI Model',
    models,
    onChange: (id) => console.log('Selected:', id),
  },
};

export const WithSelection: Story = {
  args: {
    label: 'AI Model',
    models,
    selectedModelId: 'gpt-4o',
    onChange: (id) => console.log('Selected:', id),
  },
};

export const Loading: Story = {
  args: {
    label: 'AI Model',
    models: [],
    isLoading: true,
    onChange: () => {},
  },
};

export const WithNoneOption: Story = {
  args: {
    label: 'Speech-to-Text Model',
    models,
    noneOption: true,
    onChange: (id) => console.log('Selected:', id),
  },
};

export const NoneSelected: Story = {
  args: {
    label: 'Speech-to-Text Model',
    models,
    noneOption: true,
    selectedModelId: '',
    onChange: (id) => console.log('Selected:', id),
  },
};

export const SingleModel: Story = {
  args: {
    label: 'Transcription Model',
    models: [models[2]],
    selectedModelId: 'whisper-large',
    onChange: (id) => console.log('Selected:', id),
  },
};

function InteractiveDemo() {
  const [selected, setSelected] = useState<string | undefined>();

  return (
    <div className="space-y-4">
      <ModelSelector label="AI Model" models={models} selectedModelId={selected} onChange={setSelected} noneOption />
      <p className="text-xs text-muted-foreground">Selected: {selected || '(none)'}</p>
    </div>
  );
}

export const Interactive: Story = {
  args: {} as any,
  render: () => <InteractiveDemo />,
};
