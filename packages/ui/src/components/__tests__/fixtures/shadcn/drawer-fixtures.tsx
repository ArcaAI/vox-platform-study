import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from '../../../shadcn/drawer'
import { Button } from '../../../shadcn/button'

export function ControlledDrawer({
  defaultOpen = false,
}: {
  defaultOpen?: boolean
}) {
  return (
    <Drawer defaultOpen={defaultOpen}>
      <DrawerTrigger asChild>
        <Button>Open Drawer</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Drawer Title</DrawerTitle>
          <DrawerDescription>Drawer description text</DrawerDescription>
        </DrawerHeader>
        <div className="p-4">Drawer content goes here</div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
