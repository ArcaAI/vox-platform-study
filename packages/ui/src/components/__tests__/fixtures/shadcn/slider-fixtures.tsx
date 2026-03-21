import * as React from 'react'
import { Slider } from '../../../shadcn/slider'

export function BasicSlider({
  defaultValue = [50],
  min = 0,
  max = 100,
  disabled = false,
}: {
  defaultValue?: number[]
  min?: number
  max?: number
  disabled?: boolean
}) {
  return (
    <Slider
      defaultValue={defaultValue}
      min={min}
      max={max}
      disabled={disabled}
    />
  )
}

export function RangeSlider({
  defaultValue = [25, 75],
}: {
  defaultValue?: number[]
}) {
  return <Slider defaultValue={defaultValue} min={0} max={100} />
}
