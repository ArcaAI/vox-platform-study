import type { Meta, StoryObj } from '@storybook/react-vite';
import { useScrollLock } from '../../../../hooks/registries/use-scroll-lock';

function UseScrollLockDemo() {
  const { isLocked, lock, unlock } = useScrollLock({ autoLock: false });

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm">
        Scroll locked: <strong>{String(isLocked)}</strong>
      </p>
      <div className="flex gap-2">
        <button className="rounded border px-3 py-1" onClick={lock}>
          Lock Scroll
        </button>
        <button className="rounded border px-3 py-1" onClick={unlock}>
          Unlock Scroll
        </button>
      </div>
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useScrollLock',
  component: UseScrollLockDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseScrollLockDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
