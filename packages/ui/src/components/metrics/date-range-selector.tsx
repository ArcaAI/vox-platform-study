'use client';

import * as React from 'react';
import { endOfMonth, endOfWeek, endOfYear, format, startOfMonth, startOfWeek, startOfYear } from 'date-fns';
import { CalendarDays } from 'lucide-react';

import { Calendar } from '@/components/shadcn/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/shadcn/toggle-group';
import { cn } from '@/lib/utils';

export type RangePreset = 'week' | 'month' | 'year' | 'custom';

export interface DateRange {
  from: Date;
  to: Date;
  preset: RangePreset;
}

export interface DateRangeSelectorProps {
  value: DateRange;
  onChange: (next: DateRange) => void;
  presets?: RangePreset[];
  align?: 'start' | 'end';
  className?: string;
}

const PRESET_LABEL: Record<RangePreset, string> = {
  week: 'Week',
  month: 'Month',
  year: 'Year',
  custom: 'Custom',
};

/** Compute the absolute range for a calendar preset off `now` via date-fns. */
function rangeForPreset(preset: Exclude<RangePreset, 'custom'>, now: Date): { from: Date; to: Date } {
  switch (preset) {
    case 'week':
      return { from: startOfWeek(now), to: endOfWeek(now) };
    case 'month':
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case 'year':
      return { from: startOfYear(now), to: endOfYear(now) };
  }
}

/**
 * Date-range toolbar control (PHASE-2-PLAN A radio-style `ToggleGroup` of
 * presets (week/month/year resolved via date-fns) plus a `custom` option that opens a
 * range `Calendar` in a `Popover`. Emits `{ from, to, preset }` on every change.
 */
export function DateRangeSelector({
  value,
  onChange,
  presets = ['week', 'month', 'year', 'custom'],
  align = 'start',
  className,
}: DateRangeSelectorProps) {
  const handlePreset = (next: string) => {
    if (!next) return; // ignore deselect (Radix emits '' when toggling the active item off)
    const preset = next as RangePreset;
    if (preset === 'custom') {
      onChange({ ...value, preset: 'custom' });
      return;
    }
    const { from, to } = rangeForPreset(preset, new Date());
    onChange({ from, to, preset });
  };

  const handleRangeSelect = (range: { from?: Date; to?: Date } | undefined) => {
    if (!range?.from) return;
    onChange({ from: range.from, to: range.to ?? range.from, preset: 'custom' });
  };

  const customRangeText = value.preset === 'custom' ? `${format(value.from, 'PP')} – ${format(value.to, 'PP')}` : null;

  return (
    <div data-slot="date-range-selector" className={cn('inline-flex items-center gap-2', className)}>
      <Popover>
        <ToggleGroup type="single" variant="outline" value={value.preset} onValueChange={handlePreset} aria-label="Date range preset">
          {presets.map((preset) =>
            preset === 'custom' ? (
              <PopoverTrigger asChild key={preset}>
                <ToggleGroupItem value="custom" aria-label="Custom date range" className="gap-1.5">
                  <CalendarDays className="size-4" />
                  {customRangeText ?? PRESET_LABEL.custom}
                </ToggleGroupItem>
              </PopoverTrigger>
            ) : (
              <ToggleGroupItem key={preset} value={preset} aria-label={PRESET_LABEL[preset]}>
                {PRESET_LABEL[preset]}
              </ToggleGroupItem>
            ),
          )}
        </ToggleGroup>
        <PopoverContent align={align} className="w-auto p-0">
          <Calendar
            mode="range"
            defaultMonth={value.from}
            selected={{ from: value.from, to: value.to }}
            onSelect={handleRangeSelect}
            numberOfMonths={2}
            autoFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
