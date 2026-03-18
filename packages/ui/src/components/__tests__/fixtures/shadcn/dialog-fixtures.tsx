import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '../../../shadcn/dialog'
import { Button } from '../../../shadcn/button'

export function ControlledDialog({
  defaultOpen = false,
  showCloseButton = true,
}: {
  defaultOpen?: boolean
  showCloseButton?: boolean
}) {
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger asChild>
        <Button>Open Dialog</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={showCloseButton}>
        <DialogHeader>
          <DialogTitle>Dialog Title</DialogTitle>
          <DialogDescription>Dialog description text</DialogDescription>
        </DialogHeader>
        <div>Dialog content goes here</div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DialogWithCallbacks({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>Open</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Test Dialog</DialogTitle>
        <DialogDescription>Test description</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

export function DialogWithFooterClose() {
  return (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>Test</DialogTitle>
        <DialogDescription>Description</DialogDescription>
        <DialogFooter showCloseButton>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
