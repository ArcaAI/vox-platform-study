import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconInbox, IconFileOff } from '@tabler/icons-react'

import { Button } from '../../shadcn/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../shadcn/empty'

const meta = {
  title: 'Components/Empty',
  component: Empty,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Empty>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Empty className="w-[450px]">
      <EmptyHeader>
        <EmptyMedia>
          <IconInbox className="size-10 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No items found</EmptyTitle>
        <EmptyDescription>
          You don't have any items yet. Create your first item to get started.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button>Create Item</Button>
      </EmptyContent>
    </Empty>
  ),
}

export const WithIcon: Story = {
  render: () => (
    <Empty className="w-[450px]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconFileOff />
        </EmptyMedia>
        <EmptyTitle>No files uploaded</EmptyTitle>
        <EmptyDescription>
          Upload a file to get started. Supported formats include PDF, DOCX, and TXT.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline">Upload File</Button>
      </EmptyContent>
    </Empty>
  ),
}
