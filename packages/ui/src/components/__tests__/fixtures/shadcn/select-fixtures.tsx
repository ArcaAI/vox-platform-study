import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator } from '../../../shadcn/select';

export function BasicSelect({
  defaultValue,
  disabled = false,
  placeholder = 'Select an option',
}: {
  defaultValue?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Select defaultValue={defaultValue} disabled={disabled}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="apple">Apple</SelectItem>
        <SelectItem value="banana">Banana</SelectItem>
        <SelectItem value="cherry">Cherry</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function GroupedSelect() {
  return (
    <Select>
      <SelectTrigger>
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Fruits</SelectLabel>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Vegetables</SelectLabel>
          <SelectItem value="carrot">Carrot</SelectItem>
          <SelectItem value="potato">Potato</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function SelectWithDisabledItems() {
  return (
    <Select>
      <SelectTrigger>
        <SelectValue placeholder="Select" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="enabled">Enabled</SelectItem>
        <SelectItem value="disabled" disabled>
          Disabled
        </SelectItem>
        <SelectItem value="another">Another</SelectItem>
      </SelectContent>
    </Select>
  );
}
