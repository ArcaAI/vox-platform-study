import { RadioGroup, RadioGroupItem } from '../../../shadcn/radio-group';
import { Label } from '../../../shadcn/label';

export function BasicRadioGroup({ defaultValue = 'option1', disabled = false }: { defaultValue?: string; disabled?: boolean }) {
  return (
    <RadioGroup defaultValue={defaultValue} disabled={disabled}>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option1" id="option1" />
        <Label htmlFor="option1">Option 1</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option2" id="option2" />
        <Label htmlFor="option2">Option 2</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option3" id="option3" />
        <Label htmlFor="option3">Option 3</Label>
      </div>
    </RadioGroup>
  );
}
