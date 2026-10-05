/**
 * TASK-1036 live check — the footprint a pane reserves for the canvas's fit-to-view.
 *
 * A docked pane (or one the author left against a side) reserves that side, so a fitted graph is
 * never drawn underneath it. A pane the author dragged into the MIDDLE of the canvas reserves
 * nothing: it floats above the graph by choice, and squeezing the fit into whatever is left of it
 * pushed half of the graph off-screen.
 */
import { describe, expect, it } from 'vitest';
import { paneFootprint } from '../floating-pane';

const STAGE = { width: 1200, height: 800 };

describe('paneFootprint', () => {
  it('a pane docked left or right reserves its side', () => {
    expect(paneFootprint({ dock: 'left', x: 0, width: 260 }, STAGE).left).toBeGreaterThan(260);
    expect(paneFootprint({ dock: 'right', x: 0, width: 360 }, STAGE).right).toBeGreaterThan(360);
  });

  it('an undocked pane left against a side still reserves that side', () => {
    expect(paneFootprint({ dock: null, x: 8, width: 260 }, STAGE)).toEqual({ left: 268, right: 0 });
    expect(paneFootprint({ dock: null, x: 1200 - 360 - 8, width: 360 }, STAGE)).toEqual({ left: 0, right: 368 });
  });

  it('a pane floating in the middle of the canvas reserves nothing', () => {
    expect(paneFootprint({ dock: null, x: 574, width: 260 }, STAGE)).toEqual({ left: 0, right: 0 });
    expect(paneFootprint({ dock: null, x: 300, width: 260 }, STAGE)).toEqual({ left: 0, right: 0 });
  });
});
