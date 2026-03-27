import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useThrottle } from '../../../../hooks/registries/use-throttle';

function UseThrottleDemo() {
  const [input, setInput] = useState('');
  const throttledValue = useThrottle(input, 500);

  return (
    <div className="flex flex-col items-center gap-4">
      <input className="rounded border px-3 py-2" placeholder="Type something..." value={input} onChange={(e) => setInput(e.target.value)} />
      <div className="text-sm">
        <p>
          Input: <code>{input}</code>
        </p>
        <p>
          Throttled (500ms): <code>{throttledValue}</code>
        </p>
      </div>
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useThrottle',
  component: UseThrottleDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseThrottleDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
