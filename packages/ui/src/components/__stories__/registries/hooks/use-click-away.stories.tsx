import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { useClickAway } from '../../../../hooks/registries/use-click-away';

function UseClickAwayDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);

  useClickAway(() => {
    setCount((c) => c + 1);
  }, ref);

  return (
    <div className="flex flex-col items-center gap-4">
      <div ref={ref} className="rounded-lg border-2 border-blue-400 bg-blue-50 p-8 dark:bg-blue-950">
        <p className="font-semibold">Click outside this box</p>
      </div>
      <p className="text-sm">Outside clicks: {count}</p>
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useClickAway',
  component: UseClickAwayDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseClickAwayDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
