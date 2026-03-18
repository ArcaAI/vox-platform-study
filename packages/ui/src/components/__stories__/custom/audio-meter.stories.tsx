import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState, useEffect } from 'react'

import { AudioMeter } from '../../custom/audio-meter'

const meta = {
  title: 'Custom/AudioMeter',
  component: AudioMeter,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    level: {
      control: { type: 'range', min: 0, max: 100, step: 1 },
      description: 'Audio level (0–100)',
    },
    isCapturing: {
      control: 'boolean',
      description: 'Whether audio is being captured',
    },
    isSpeaking: {
      control: 'boolean',
      description: 'Whether speech is detected',
    },
    isMuted: {
      control: 'boolean',
      description: 'Whether the microphone is muted',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AudioMeter>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    level: 35,
    isCapturing: true,
    isSpeaking: false,
    isMuted: false,
  },
}

export const Silent: Story = {
  args: {
    level: 0,
    isCapturing: true,
    isSpeaking: false,
    isMuted: false,
  },
}

export const LowLevel: Story = {
  args: {
    level: 25,
    isCapturing: true,
    isSpeaking: false,
    isMuted: false,
  },
}

export const MediumLevel: Story = {
  args: {
    level: 55,
    isCapturing: true,
    isSpeaking: true,
    isMuted: false,
  },
}

export const HighLevel: Story = {
  args: {
    level: 85,
    isCapturing: true,
    isSpeaking: true,
    isMuted: false,
  },
}

export const Muted: Story = {
  args: {
    level: 0,
    isCapturing: false,
    isSpeaking: false,
    isMuted: true,
  },
}

export const NotCapturing: Story = {
  args: {
    level: 0,
    isCapturing: false,
    isSpeaking: false,
    isMuted: false,
  },
}

function AnimatedMeter() {
  const [level, setLevel] = useState(0)
  const [isSpeaking, setIsSpeaking] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => {
      const next = Math.random() * 100
      setLevel(next)
      setIsSpeaking(next > 30)
    }, 150)
    return () => clearInterval(interval)
  }, [])

  return (
    <AudioMeter
      level={level}
      isCapturing={true}
      isSpeaking={isSpeaking}
      isMuted={false}
    />
  )
}

export const Animated: Story = {
  args: {} as any,
  render: () => <AnimatedMeter />,
}
