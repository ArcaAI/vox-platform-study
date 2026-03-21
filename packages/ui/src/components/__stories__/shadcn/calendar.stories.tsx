import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { DateRange } from 'react-day-picker'

import { Calendar } from '../../shadcn/calendar'

const meta = {
  title: 'Components/Calendar',
  component: Calendar,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Calendar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => {
    const [date, setDate] = React.useState<Date | undefined>(new Date())

    return (
      <div className="w-fit rounded-md border">
        <Calendar
          mode="single"
          selected={date}
          onSelect={setDate}
        />
      </div>
    )
  },
}

export const Range: Story = {
  render: () => {
    const [range, setRange] = React.useState<DateRange | undefined>({
      from: new Date(),
      to: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    })

    return (
      <div className="w-fit rounded-md border">
        <Calendar
          mode="range"
          selected={range}
          onSelect={setRange}
          numberOfMonths={2}
        />
      </div>
    )
  },
}
