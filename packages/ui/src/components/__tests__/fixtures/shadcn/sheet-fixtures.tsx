import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription, SheetClose } from '../../../shadcn/sheet';
import { Button } from '../../../shadcn/button';

export function BasicSheet({
  defaultOpen = false,
  side = 'right' as 'top' | 'right' | 'bottom' | 'left',
  showCloseButton = true,
}: {
  defaultOpen?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  return (
    <Sheet defaultOpen={defaultOpen}>
      <SheetTrigger asChild>
        <Button>Open Sheet</Button>
      </SheetTrigger>
      <SheetContent side={side} showCloseButton={showCloseButton}>
        <SheetHeader>
          <SheetTitle>Sheet Title</SheetTitle>
          <SheetDescription>Sheet description text</SheetDescription>
        </SheetHeader>
        <div>Sheet body content</div>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="outline">Cancel</Button>
          </SheetClose>
          <Button>Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function SheetWithCustomClass({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Sheet defaultOpen={defaultOpen}>
      <SheetTrigger asChild>
        <Button>Open Sheet</Button>
      </SheetTrigger>
      <SheetContent className="custom-sheet-class">
        <SheetTitle>Custom Sheet</SheetTitle>
        <SheetDescription>Custom description</SheetDescription>
      </SheetContent>
    </Sheet>
  );
}
