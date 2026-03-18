import type { Meta, StoryObj } from '@storybook/react-vite'

import { DateTimePicker } from '../../../registries/manifest/date-time-picker'

const meta = {
  title: 'Registries/Manifest/DateTimePicker',
  component: DateTimePicker,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof DateTimePicker>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <DateTimePicker />,
}
