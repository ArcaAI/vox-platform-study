import type { Meta, StoryObj } from '@storybook/react-vite';

import { Orb } from '../../elevenlabs/orb';

const meta: Meta<typeof Orb> = {
  title: 'ElevenLabs/Orb',
  component: Orb,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    agentState: {
      control: 'select',
      options: [null, 'thinking', 'listening', 'talking'],
      description: 'Current agent state',
    },
    volumeMode: {
      control: 'select',
      options: ['auto', 'manual'],
      description: 'Volume control mode',
    },
    manualInput: {
      control: { type: 'number', min: 0, max: 1, step: 0.1 },
      description: 'Manual input volume (0-1)',
    },
    manualOutput: {
      control: { type: 'number', min: 0, max: 1, step: 0.1 },
      description: 'Manual output volume (0-1)',
    },
  },
};

export default meta;
type Story = StoryObj<typeof Orb>;

export const Default: Story = {
  render: () => (
    <div className="h-[300px] w-[300px]">
      <Orb />
    </div>
  ),
};

export const Thinking: Story = {
  render: () => (
    <div className="h-[300px] w-[300px]">
      <Orb agentState="thinking" />
    </div>
  ),
};

export const Listening: Story = {
  render: () => (
    <div className="h-[300px] w-[300px]">
      <Orb agentState="listening" />
    </div>
  ),
};

export const Talking: Story = {
  render: () => (
    <div className="h-[300px] w-[300px]">
      <Orb agentState="talking" />
    </div>
  ),
};

export const CustomColors: Story = {
  render: () => (
    <div className="h-[300px] w-[300px]">
      <Orb agentState="talking" colors={['#FF6B6B', '#4ECDC4']} />
    </div>
  ),
};

export const ManualVolume: Story = {
  render: () => (
    <div className="h-[300px] w-[300px]">
      <Orb agentState="talking" volumeMode="manual" manualInput={0.5} manualOutput={0.8} />
    </div>
  ),
};

export const SmallOrb: Story = {
  render: () => (
    <div className="h-[100px] w-[100px]">
      <Orb agentState="thinking" />
    </div>
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex gap-8">
      {([null, 'thinking', 'listening', 'talking'] as const).map((state) => (
        <div key={String(state)} className="text-center">
          <div className="h-[150px] w-[150px]">
            <Orb agentState={state} />
          </div>
          <p className="mt-2 text-sm">{state ?? 'idle'}</p>
        </div>
      ))}
    </div>
  ),
};
