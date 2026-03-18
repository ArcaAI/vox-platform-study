import type { Meta, StoryObj } from '@storybook/react-vite'

import { ProgressSteps } from '../../../registries/manifest/progress-steps'

const meta = {
  title: 'Registries/Manifest/ProgressSteps',
  component: ProgressSteps,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProgressSteps>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <ProgressSteps />,
}
