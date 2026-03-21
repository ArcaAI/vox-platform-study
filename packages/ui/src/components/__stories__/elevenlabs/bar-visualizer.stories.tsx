import type { Meta, StoryObj } from '@storybook/react-vite'

import { BarVisualizer } from '../../elevenlabs/bar-visualizer'

const meta: Meta<typeof BarVisualizer> = {
  title: 'ElevenLabs/BarVisualizer',
  component: BarVisualizer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    state: {
      control: 'select',
      options: ['connecting', 'initializing', 'listening', 'speaking', 'thinking'],
      description: 'Voice assistant state',
    },
    barCount: {
      control: { type: 'number', min: 3, max: 30, step: 1 },
      description: 'Number of bars to display',
    },
    minHeight: {
      control: { type: 'number', min: 0, max: 100, step: 5 },
      description: 'Minimum bar height percentage',
    },
    maxHeight: {
      control: { type: 'number', min: 0, max: 100, step: 5 },
      description: 'Maximum bar height percentage',
    },
    demo: {
      control: 'boolean',
      description: 'Enable demo mode with fake audio data',
    },
    centerAlign: {
      control: 'boolean',
      description: 'Align bars from center instead of bottom',
    },
  },
}

export default meta
type Story = StoryObj<typeof BarVisualizer>

export const Connecting: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="connecting" demo />
    </div>
  ),
}

export const Listening: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="listening" demo />
    </div>
  ),
}

export const Speaking: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="speaking" demo />
    </div>
  ),
}

export const Thinking: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="thinking" demo />
    </div>
  ),
}

export const Initializing: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="initializing" demo />
    </div>
  ),
}

export const CenterAligned: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="speaking" demo centerAlign />
    </div>
  ),
}

export const FewBars: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="speaking" demo barCount={5} />
    </div>
  ),
}

export const ManyBars: Story = {
  render: () => (
    <div className="w-[400px]">
      <BarVisualizer state="speaking" demo barCount={25} />
    </div>
  ),
}

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['connecting', 'initializing', 'listening', 'speaking', 'thinking'] as const).map(
        (state) => (
          <div key={state} className="w-[400px]">
            <p className="mb-1 text-sm font-medium capitalize">{state}</p>
            <BarVisualizer state={state} demo className="h-24" />
          </div>
        )
      )}
    </div>
  ),
}
