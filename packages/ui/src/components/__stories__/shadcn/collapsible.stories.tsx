import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconChevronDown } from '@tabler/icons-react'

import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../shadcn/collapsible'
import { Button } from '../../shadcn/button'

const meta = {
  title: 'Components/Collapsible',
  component: Collapsible,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Collapsible>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => {
    const [open, setOpen] = React.useState(false)

    return (
      <Collapsible open={open} onOpenChange={setOpen} className="w-87.5 space-y-2">
        <div className="flex items-center justify-between rounded-md border px-4 py-2">
          <h4 className="text-sm font-semibold">3 items tagged</h4>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <IconChevronDown
                className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
              />
              <span className="sr-only">Toggle</span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <div className="rounded-md border px-4 py-2 text-sm">@radix-ui/primitives</div>
        <CollapsibleContent className="space-y-2">
          <div className="rounded-md border px-4 py-2 text-sm">@radix-ui/colors</div>
          <div className="rounded-md border px-4 py-2 text-sm">@tabler/icons-react</div>
        </CollapsibleContent>
      </Collapsible>
    )
  },
}
