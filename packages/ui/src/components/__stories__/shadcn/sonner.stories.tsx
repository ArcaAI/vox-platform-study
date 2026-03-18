import type { Meta, StoryObj } from '@storybook/react-vite'
import { toast } from 'sonner'

import { Toaster } from '../../shadcn/sonner'
import { Button } from '../../shadcn/button'

const meta: Meta<typeof Toaster> = {
  title: 'Components/Sonner',
  component: Toaster,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
} satisfies Meta<typeof Toaster>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() => toast('Event has been created.')}
    >
      Show Toast
    </Button>
  ),
}

export const Types: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => toast('Default toast')}>
        Default
      </Button>
      <Button variant="outline" onClick={() => toast.success('Success!')}>
        Success
      </Button>
      <Button variant="outline" onClick={() => toast.error('Error occurred')}>
        Error
      </Button>
      <Button variant="outline" onClick={() => toast.warning('Warning!')}>
        Warning
      </Button>
      <Button variant="outline" onClick={() => toast.info('Information')}>
        Info
      </Button>
    </div>
  ),
}

export const WithDescription: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() =>
        toast('Event created', {
          description: 'Sunday, December 03, 2023 at 9:00 AM',
        })
      }
    >
      With Description
    </Button>
  ),
}

export const WithAction: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() =>
        toast('Event deleted', {
          action: {
            label: 'Undo',
            onClick: () => toast('Undo successful'),
          },
        })
      }
    >
      With Action
    </Button>
  ),
}
