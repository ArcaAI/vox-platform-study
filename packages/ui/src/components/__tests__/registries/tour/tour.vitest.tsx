import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TourProvider, useTour } from '../../../../components/registries/tour';
import type { Tour } from '../../../../components/registries/tour';

const testTours: Tour[] = [
  {
    id: 'test-tour',
    steps: [
      { id: 'step-1', title: 'Step One', content: 'First step content' },
      { id: 'step-2', title: 'Step Two', content: 'Second step content' },
    ],
  },
];

function TourTrigger() {
  const { start } = useTour();
  return (
    <div>
      <button data-tour-step-id="step-1" onClick={() => start('test-tour')}>
        Start
      </button>
      <div data-tour-step-id="step-2">Target</div>
    </div>
  );
}

describe('TourProvider', () => {
  it('renders children without crashing', () => {
    render(
      <TourProvider tours={testTours}>
        <div>Hello</div>
      </TourProvider>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('provides useTour context to children', () => {
    render(
      <TourProvider tours={testTours}>
        <TourTrigger />
      </TourProvider>,
    );
    expect(screen.getByText('Start')).toBeInTheDocument();
  });
});

describe('useTour', () => {
  it('throws when used outside TourProvider', () => {
    function BadComponent() {
      useTour();
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow('useTour must be used within a TourProvider');
  });
});
