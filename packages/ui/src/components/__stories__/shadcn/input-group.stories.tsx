import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconSearch } from '@tabler/icons-react'

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
} from '../../shadcn/input-group'

const meta = {
  title: 'Components/InputGroup',
  component: InputGroup,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof InputGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <InputGroup className="w-80">
      <InputGroupInput placeholder="Search..." />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="xs">
          <IconSearch />
          Search
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
}

export const WithPrefix: Story = {
  render: () => (
    <InputGroup className="w-80">
      <InputGroupAddon align="inline-start">
        <InputGroupText>https://</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput placeholder="example.com" />
    </InputGroup>
  ),
}
