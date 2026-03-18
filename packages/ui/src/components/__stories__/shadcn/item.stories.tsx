import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconFile, IconFolder, IconSettings, IconTrash } from '@tabler/icons-react'

import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
  ItemSeparator,
} from '../../shadcn/item'
import { Button } from '../../shadcn/button'

const meta = {
  title: 'Components/Item',
  component: Item,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'outline', 'muted'],
    },
    size: {
      control: 'select',
      options: ['default', 'sm'],
    },
  },
} satisfies Meta<typeof Item>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Item className="w-80">
      <ItemMedia variant="icon">
        <IconFile className="size-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Document.pdf</ItemTitle>
        <ItemDescription>Last modified 2 hours ago</ItemDescription>
      </ItemContent>
    </Item>
  ),
}

export const Variants: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <Item variant="default">
        <ItemContent>
          <ItemTitle>Default variant</ItemTitle>
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Outline variant</ItemTitle>
        </ItemContent>
      </Item>
      <Item variant="muted">
        <ItemContent>
          <ItemTitle>Muted variant</ItemTitle>
        </ItemContent>
      </Item>
    </div>
  ),
}

export const WithActions: Story = {
  render: () => (
    <Item className="w-96">
      <ItemMedia variant="icon">
        <IconFolder className="size-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Project Files</ItemTitle>
        <ItemDescription>12 items</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="ghost" size="icon-xs">
          <IconSettings className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs">
          <IconTrash className="size-3.5" />
        </Button>
      </ItemActions>
    </Item>
  ),
}

export const Group: Story = {
  render: () => (
    <ItemGroup className="w-80">
      <Item>
        <ItemMedia variant="icon">
          <IconFile className="size-4" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>README.md</ItemTitle>
        </ItemContent>
      </Item>
      <ItemSeparator />
      <Item>
        <ItemMedia variant="icon">
          <IconFile className="size-4" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>package.json</ItemTitle>
        </ItemContent>
      </Item>
      <ItemSeparator />
      <Item>
        <ItemMedia variant="icon">
          <IconFolder className="size-4" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>src/</ItemTitle>
        </ItemContent>
      </Item>
    </ItemGroup>
  ),
}

export const Small: Story = {
  render: () => (
    <Item size="sm" className="w-80">
      <ItemMedia variant="icon">
        <IconFile className="size-3.5" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Compact item</ItemTitle>
      </ItemContent>
    </Item>
  ),
}
