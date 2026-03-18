import { ToggleGroup, ToggleGroupItem } from '../../../shadcn/toggle-group'

export function SingleToggleGroup({
  defaultValue = 'center',
  variant,
  size,
}: {
  defaultValue?: string
  variant?: 'default' | 'outline'
  size?: 'default' | 'sm' | 'lg'
}) {
  return (
    <ToggleGroup type="single" defaultValue={defaultValue} variant={variant} size={size}>
      <ToggleGroupItem value="left">Left</ToggleGroupItem>
      <ToggleGroupItem value="center">Center</ToggleGroupItem>
      <ToggleGroupItem value="right">Right</ToggleGroupItem>
    </ToggleGroup>
  )
}

export function MultipleToggleGroup({
  defaultValue = ['bold'],
}: {
  defaultValue?: string[]
}) {
  return (
    <ToggleGroup type="multiple" defaultValue={defaultValue}>
      <ToggleGroupItem value="bold">Bold</ToggleGroupItem>
      <ToggleGroupItem value="italic">Italic</ToggleGroupItem>
      <ToggleGroupItem value="underline">Underline</ToggleGroupItem>
    </ToggleGroup>
  )
}
