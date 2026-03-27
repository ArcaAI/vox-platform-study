import type { Meta, StoryObj } from '@storybook/react-vite';

import { DirectionProvider, useDirection, type Direction } from '../../shadcn/direction';

function DirectionDisplay() {
  const direction = useDirection();
  return (
    <div className="rounded-md border p-4">
      <p className="text-sm text-muted-foreground">
        Current direction: <span className="font-semibold text-foreground">{direction}</span>
      </p>
    </div>
  );
}

function DirectionDemo({ direction }: { direction: Direction }) {
  return (
    <DirectionProvider direction={direction}>
      <div className="flex flex-col gap-4" dir={direction}>
        <DirectionDisplay />
        <div className="rounded-md border p-4">
          <h3 className="mb-2 font-medium">Sample Content</h3>
          <p className="text-sm text-muted-foreground">
            This content respects the <code className="text-foreground">{direction}</code> direction setting.
          </p>
        </div>
      </div>
    </DirectionProvider>
  );
}

const meta = {
  title: 'Components/Direction',
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof DirectionProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <DirectionDemo direction="ltr" />,
};

export const RTL: Story = {
  render: () => (
    <DirectionProvider direction="rtl">
      <div className="flex flex-col gap-4" dir="rtl">
        <DirectionDisplay />
        <div className="rounded-md border p-4">
          <h3 className="mb-2 font-medium">محتوى نموذجي</h3>
          <p className="text-sm text-muted-foreground">هذا المحتوى يحترم إعداد الاتجاه من اليمين إلى اليسار.</p>
        </div>
      </div>
    </DirectionProvider>
  ),
};
