import type { Meta, StoryObj } from '@storybook/react-vite';

import { Kbd, KbdGroup } from '../../shadcn/kbd';

const meta = {
  title: 'Components/Kbd',
  component: Kbd,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'K',
  },
};

export const Modifiers: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Kbd>⌘</Kbd>
      <Kbd>⇧</Kbd>
      <Kbd>⌥</Kbd>
      <Kbd>⌃</Kbd>
      <Kbd>Enter</Kbd>
      <Kbd>Esc</Kbd>
    </div>
  ),
};

export const KeyCombination: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        <span className="text-muted-foreground ml-2 text-sm">Command palette</span>
      </div>
      <div className="flex items-center gap-1">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>P</Kbd>
        </KbdGroup>
        <span className="text-muted-foreground ml-2 text-sm">Quick open</span>
      </div>
      <div className="flex items-center gap-1">
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>C</Kbd>
        </KbdGroup>
        <span className="text-muted-foreground ml-2 text-sm">Copy</span>
      </div>
    </div>
  ),
};
