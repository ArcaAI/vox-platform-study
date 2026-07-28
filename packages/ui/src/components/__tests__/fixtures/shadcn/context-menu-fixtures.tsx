import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuShortcut,
} from '../../../shadcn/context-menu';

export function BasicContextMenu() {
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          style={{
            width: 300,
            height: 200,
            border: '1px dashed gray',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          Right click here
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>Actions</ContextMenuLabel>
        <ContextMenuItem>Copy</ContextMenuItem>
        <ContextMenuItem>Paste</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked>Show Toolbar</ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive">
          Delete
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
