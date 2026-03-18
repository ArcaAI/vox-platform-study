import type { Meta, StoryObj } from '@storybook/react-vite'
import { toast } from 'sonner'

import { Toaster } from '../../shadcn/sonner'
import { Button } from '../../shadcn/button'

const meta = {
  title: 'Components/Toast',
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
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() =>
        toast('Scheduled: Catch up', {
          description: 'Friday, February 10, 2023 at 5:57 PM',
        })
      }
    >
      Add to calendar
    </Button>
  ),
}

export const Destructive: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() =>
        toast.error('Uh oh! Something went wrong.', {
          description: 'There was a problem with your request.',
        })
      }
    >
      Show Error
    </Button>
  ),
}

export const WithAction: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() =>
        toast('File deleted', {
          action: {
            label: 'Undo',
            onClick: () => toast.success('File restored'),
          },
        })
      }
    >
      Delete File
    </Button>
  ),
}

export const Promise: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() => {
        toast.promise(
          new window.Promise((resolve) => setTimeout(resolve, 2000)),
          {
            loading: 'Loading...',
            success: 'Data loaded successfully!',
            error: 'Failed to load data.',
          }
        )
      }}
    >
      Load Data
    </Button>
  ),
}
