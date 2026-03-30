import type { Meta, StoryObj } from '@storybook/react-vite';
import { TourProvider, useTour } from '../../../registries/tour';
import type { Tour } from '../../../registries/tour';

const sampleTours: Tour[] = [
  {
    id: 'welcome',
    steps: [
      {
        id: 'step-1',
        title: 'Welcome',
        content: 'This is the first step of the tour. Click Next to continue.',
      },
      {
        id: 'step-2',
        title: 'Features',
        content: 'Here you can explore the main features of the application.',
      },
      {
        id: 'step-3',
        title: 'All Done!',
        content: 'You have completed the tour. Click Finish to close.',
      },
    ],
  },
];

function TourTrigger() {
  const { start } = useTour();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Click the button below to start the tour. Each step highlights an element with a matching <code>data-tour-step-id</code> attribute.
      </p>
      <div className="flex gap-4">
        <button data-tour-step-id="step-1" className="rounded-md border px-4 py-2" onClick={() => start('welcome')}>
          Start Tour
        </button>
        <div data-tour-step-id="step-2" className="rounded-md border px-4 py-2">
          Feature Panel
        </div>
        <div data-tour-step-id="step-3" className="rounded-md border px-4 py-2">
          Completion Area
        </div>
      </div>
    </div>
  );
}

function TourDemo() {
  return (
    <TourProvider tours={sampleTours}>
      <TourTrigger />
    </TourProvider>
  );
}

const meta = {
  title: 'Registries/Tour/Tour',
  component: TourDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TourDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
