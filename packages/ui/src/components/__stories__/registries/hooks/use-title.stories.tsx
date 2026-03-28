import type { Meta, StoryObj } from '@storybook/react-vite';
import { useTitle } from '../../../../hooks/registries/use-title';

function UseTitleDemo() {
  const [title, setTitle] = useTitle('Storybook Demo', { observe: true });

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm">
        Current document title: <strong>{title}</strong>
      </p>
      <input className="rounded border px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Set document title..." />
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useTitle',
  component: UseTitleDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseTitleDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
