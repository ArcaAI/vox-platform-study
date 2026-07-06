import { describe, it, expect } from 'vitest';

import { getPaginationRange, getItemRange, resolveContainerBreakpoint, getPagerRadius } from '../pagination-window';

describe('getPaginationRange — numbered window (first/last + ellipsis + current±r)', () => {
  it('radius 2, page 7/20 → 1 … 5 6 [7] 8 9 … 20', () => {
    expect(getPaginationRange({ page: 6, pageCount: 20, radius: 2 })).toEqual([1, 'ellipsis-left', 5, 6, 7, 8, 9, 'ellipsis-right', 20]);
  });

  it('renders a single omitted page instead of an ellipsis when the gap is exactly one page', () => {
    // page 5/20 r2 → window [3,7]; gap between 1 and 3 is a single page → render 2, not …
    expect(getPaginationRange({ page: 4, pageCount: 20, radius: 2 })).toEqual([1, 2, 3, 4, 5, 6, 7, 'ellipsis-right', 20]);
  });

  it('no left ellipsis near the start', () => {
    expect(getPaginationRange({ page: 0, pageCount: 20, radius: 2 })).toEqual([1, 2, 3, 'ellipsis-right', 20]);
  });

  it('no right ellipsis near the end', () => {
    expect(getPaginationRange({ page: 19, pageCount: 20, radius: 2 })).toEqual([1, 'ellipsis-left', 18, 19, 20]);
  });

  it('radius 1 shrinks the neighbourhood', () => {
    expect(getPaginationRange({ page: 6, pageCount: 20, radius: 1 })).toEqual([1, 'ellipsis-left', 6, 7, 8, 'ellipsis-right', 20]);
  });

  it('radius 0 → no numbered window (caller renders Prev/Next + "Page p of N")', () => {
    expect(getPaginationRange({ page: 6, pageCount: 20, radius: 0 })).toEqual([]);
  });

  it('single page → no window', () => {
    expect(getPaginationRange({ page: 0, pageCount: 1, radius: 2 })).toEqual([]);
  });

  it('small page counts render every page without ellipses', () => {
    expect(getPaginationRange({ page: 1, pageCount: 4, radius: 2 })).toEqual([1, 2, 3, 4]);
  });
});

describe('getItemRange — item-range status math', () => {
  it('first page', () => {
    expect(getItemRange({ page: 0, limit: 25, total: 480 })).toEqual({ first: 1, last: 25, total: 480 });
  });
  it('middle page', () => {
    expect(getItemRange({ page: 2, limit: 25, total: 480 })).toEqual({ first: 51, last: 75, total: 480 });
  });
  it('last partial page clamps to total', () => {
    expect(getItemRange({ page: 19, limit: 25, total: 480 })).toEqual({ first: 476, last: 480, total: 480 });
  });
  it('zero results', () => {
    expect(getItemRange({ page: 0, limit: 25, total: 0 })).toEqual({ first: 0, last: 0, total: 0 });
  });
});

describe('resolveContainerBreakpoint / getPagerRadius — container thresholds (viewport numbers)', () => {
  it('maps width to sm/md/lg/xl breakpoints at 640/768/1024/1280', () => {
    expect(resolveContainerBreakpoint(1400)).toBe('xl');
    expect(resolveContainerBreakpoint(1280)).toBe('xl');
    expect(resolveContainerBreakpoint(1100)).toBe('lg');
    expect(resolveContainerBreakpoint(800)).toBe('md');
    expect(resolveContainerBreakpoint(700)).toBe('sm');
    expect(resolveContainerBreakpoint(500)).toBe('base');
  });

  it('drops the pager radius from the ends inward per breakpoint', () => {
    expect(getPagerRadius('xl')).toBe(2);
    expect(getPagerRadius('lg')).toBe(2);
    expect(getPagerRadius('md')).toBe(1);
    expect(getPagerRadius('sm')).toBe(0);
    expect(getPagerRadius('base')).toBe(0);
  });
});
