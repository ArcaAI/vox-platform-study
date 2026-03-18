import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Matrix,
  digits,
  loader,
  pulse,
  wave,
  snake,
  chevronLeft,
  chevronRight,
} from '../../elevenlabs/matrix'

const meta: Meta<typeof Matrix> = {
  title: 'ElevenLabs/Matrix',
  component: Matrix,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    rows: {
      control: { type: 'number', min: 1, max: 20, step: 1 },
      description: 'Number of rows',
    },
    cols: {
      control: { type: 'number', min: 1, max: 20, step: 1 },
      description: 'Number of columns',
    },
    fps: {
      control: { type: 'number', min: 1, max: 60, step: 1 },
      description: 'Frames per second',
    },
    size: {
      control: { type: 'number', min: 4, max: 24, step: 2 },
      description: 'Pixel size',
    },
    gap: {
      control: { type: 'number', min: 0, max: 8, step: 1 },
      description: 'Gap between pixels',
    },
    brightness: {
      control: { type: 'number', min: 0, max: 2, step: 0.1 },
      description: 'Brightness multiplier',
    },
  },
}

export default meta
type Story = StoryObj<typeof Matrix>

export const StaticDigit: Story = {
  args: {
    rows: 7,
    cols: 5,
    pattern: digits[0],
    ariaLabel: 'Digit zero',
  },
}

export const AllDigits: Story = {
  render: () => (
    <div className="flex gap-4">
      {digits.map((digit, i) => (
        <Matrix
          key={i}
          rows={7}
          cols={5}
          pattern={digit}
          ariaLabel={`Digit ${i}`}
        />
      ))}
    </div>
  ),
}

export const LoaderAnimation: Story = {
  args: {
    rows: 7,
    cols: 7,
    frames: loader,
    fps: 12,
    ariaLabel: 'Loading animation',
  },
}

export const PulseAnimation: Story = {
  args: {
    rows: 7,
    cols: 7,
    frames: pulse,
    fps: 12,
    ariaLabel: 'Pulse animation',
  },
}

export const WaveAnimation: Story = {
  args: {
    rows: 7,
    cols: 7,
    frames: wave,
    fps: 16,
    ariaLabel: 'Wave animation',
  },
}

export const SnakeAnimation: Story = {
  args: {
    rows: 7,
    cols: 7,
    frames: snake,
    fps: 8,
    ariaLabel: 'Snake animation',
  },
}

export const Chevrons: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Matrix rows={5} cols={5} pattern={chevronLeft} ariaLabel="Left" />
      <Matrix rows={5} cols={5} pattern={chevronRight} ariaLabel="Right" />
    </div>
  ),
}

export const VUMeter: Story = {
  args: {
    rows: 7,
    cols: 10,
    mode: 'vu',
    levels: [0.2, 0.5, 0.8, 1.0, 0.9, 0.7, 0.4, 0.3, 0.6, 0.5],
    ariaLabel: 'VU meter',
  },
}

export const LargePixels: Story = {
  args: {
    rows: 7,
    cols: 7,
    frames: pulse,
    size: 20,
    gap: 4,
    ariaLabel: 'Large pixel display',
  },
}

export const SmallPixels: Story = {
  args: {
    rows: 7,
    cols: 7,
    frames: wave,
    size: 6,
    gap: 1,
    ariaLabel: 'Small pixel display',
  },
}
