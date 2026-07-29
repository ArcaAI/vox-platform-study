import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription } from '../../../shadcn/popover';
import { Button } from '../../../shadcn/button';

export function BasicPopover({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <Button>Open Popover</Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Popover Title</PopoverTitle>
          <PopoverDescription>Popover description text</PopoverDescription>
        </PopoverHeader>
        <div>Popover body content</div>
      </PopoverContent>
    </Popover>
  );
}

export function PopoverWithCustomClass({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <Button>Open Popover</Button>
      </PopoverTrigger>
      <PopoverContent className="custom-popover-class w-96">
        <PopoverTitle>Custom Popover</PopoverTitle>
      </PopoverContent>
    </Popover>
  );
}
