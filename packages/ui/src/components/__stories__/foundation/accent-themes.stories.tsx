import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { Badge } from '../../shadcn/badge';
import { Button } from '../../shadcn/button';

/**
 * Accent themes. Teal is the default with no attribute; setting
 * `data-accent="indigo" | "green" | "amber"` on `<html>` remaps the
 * accent-derived semantic tokens (primary / accent / ring / sidebar / chart-1)
 * with no component restyle.
 *
 * Contrast spot-check — primary text on its background clears WCAG AA in both
 * themes for every accent:
 * - Light: teal-600, indigo-600, green-600 carry white text (>=4.5:1); the amber
 *   (saffron) primary carries dark saffron-950 text.
 * - Dark: the -400 steps carry dark foregrounds (indigo-950 / #04231a / saffron-950).
 *
 * Use the `accent` control below; toggle the Storybook theme (light/dark) to
 * verify both. The preview writes `data-accent` to the document root because the
 * token blocks are `:root`-scoped.
 */
const ACCENTS = ['teal', 'indigo', 'green', 'amber'] as const;
type Accent = (typeof ACCENTS)[number];

function AccentPreview({ accent }: { accent: Accent }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.accent;
    if (accent === 'teal') delete root.dataset.accent;
    else root.dataset.accent = accent;
    return () => {
      if (previous) root.dataset.accent = previous;
      else delete root.dataset.accent;
    };
  }, [accent]);

  return (
    <div className="bg-background text-foreground flex w-[440px] flex-col gap-4 rounded-lg border p-6">
      <div className="flex flex-wrap gap-2">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
      </div>
      <div className="bg-accent text-accent-foreground rounded-md p-3 text-sm">Accent surface — accent-foreground text on the accent tint</div>
      <div className="flex flex-wrap gap-2">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
      </div>
      <input
        className="border-input focus-visible:ring-ring rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        placeholder="Focus me — the ring uses the accent"
      />
    </div>
  );
}

const meta = {
  title: 'Foundation/Accent Themes',
  component: AccentPreview,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    accent: { control: 'inline-radio', options: ACCENTS },
  },
  args: { accent: 'teal' },
} satisfies Meta<typeof AccentPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Indigo: Story = { args: { accent: 'indigo' } };
export const Green: Story = { args: { accent: 'green' } };
export const Amber: Story = { args: { accent: 'amber' } };
