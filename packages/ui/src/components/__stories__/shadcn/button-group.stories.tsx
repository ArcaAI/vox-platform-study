import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconBold, IconItalic, IconUnderline } from '@tabler/icons-react'

import { Button } from '../../shadcn/button'
import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from '../../shadcn/button-group'

const meta = {
  title: 'Components/ButtonGroup',
  component: ButtonGroup,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
      description: 'The orientation of the button group',
    },
  },
} satisfies Meta<typeof ButtonGroup>

export default meta
type Story = StoryObj<typeof meta>

// Default horizontal button group
export const Default: Story = {
  render: () => (
    <ButtonGroup>
      <Button variant="outline">
        <IconBold />
      </Button>
      <Button variant="outline">
        <IconItalic />
      </Button>
      <Button variant="outline">
        <IconUnderline />
      </Button>
    </ButtonGroup>
  ),
}

// Vertical orientation
export const Vertical: Story = {
  render: () => (
    <ButtonGroup orientation="vertical">
      <Button variant="outline">Top</Button>
      <Button variant="outline">Middle</Button>
      <Button variant="outline">Bottom</Button>
    </ButtonGroup>
  ),
}

// Group with separators between buttons
export const WithSeparator: Story = {
  render: () => (
    <ButtonGroup>
      <Button variant="outline">Cut</Button>
      <ButtonGroupSeparator />
      <Button variant="outline">Copy</Button>
      <ButtonGroupSeparator />
      <Button variant="outline">Paste</Button>
    </ButtonGroup>
  ),
}

// Group with text element
export const WithText: Story = {
  render: () => (
    <ButtonGroup>
      <ButtonGroupText>Page</ButtonGroupText>
      <Button variant="outline">Previous</Button>
      <Button variant="outline">Next</Button>
    </ButtonGroup>
  ),
}
