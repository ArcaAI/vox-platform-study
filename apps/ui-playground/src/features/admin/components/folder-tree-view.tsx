import { useMemo } from 'react';
import { FolderIcon, FolderOpenIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tree, Folder, File, type TreeViewElement } from '@arcaai/ui';
import type { TenantBucketTreeNode } from '../api/tenant-storage';

interface FolderTreeViewProps {
  nodes: TenantBucketTreeNode[];
  selectedPath?: string;
  onSelect: (node: TenantBucketTreeNode) => void;
  className?: string;
}

function toTreeElements(nodes: TenantBucketTreeNode[]): TreeViewElement[] {
  return nodes
    .filter((node) => node.type === 'folder')
    .map((node) => ({
      id: node.path || 'root',
      name: node.name || 'Root',
      children: toTreeElements(node.children ?? []),
    }));
}

function renderTreeNode(
  node: TreeViewElement,
  selectedPath: string | undefined,
  onSelect: (path: string) => void,
) {
  const isSelected = selectedPath === node.id;
  const hasChildren = (node.children?.length ?? 0) > 0;
  if (!hasChildren) {
    return (
      <File
        key={node.id}
        value={node.id}
        className={cn('px-2 py-1', isSelected && 'bg-muted')}
        onClick={() => onSelect(node.id)}
      >
        {node.name}
      </File>
    );
  }

  return (
    <Folder
      key={node.id}
      value={node.id}
      element={node.name}
      isSelect={isSelected}
      className="px-2 py-1"
    >
      {node.children?.map((child) => renderTreeNode(child, selectedPath, onSelect))}
    </Folder>
  );
}

export function FolderTreeView({
  nodes,
  selectedPath,
  onSelect,
  className,
}: FolderTreeViewProps) {
  const elements = useMemo(() => toTreeElements(nodes), [nodes]);

  if (elements.length === 0) {
    return (
      <div
        className={cn(
          'text-muted-foreground flex h-full items-center justify-center text-sm',
          className,
        )}
      >
        No folders found in this bucket.
      </div>
    );
  }

  return (
    <Tree
      className={cn('h-full', className)}
      elements={elements}
      initialSelectedId={selectedPath || 'root'}
      openIcon={<FolderOpenIcon className="size-4" />}
      closeIcon={<FolderIcon className="size-4" />}
    >
      <File
        value="root"
        className={cn('px-2 py-1', selectedPath === '' && 'bg-muted')}
        onClick={() =>
          onSelect({
            id: 'root',
            type: 'folder',
            name: 'Root',
            path: '',
          })
        }
      >
        Root
      </File>
      {elements.map((element) =>
        renderTreeNode(element, selectedPath, (path) =>
          onSelect({
            id: `folder:${path}`,
            type: 'folder',
            name: path.split('/').filter(Boolean).at(-1) || 'Root',
            path: path === 'root' ? '' : path,
          }),
        ),
      )}
    </Tree>
  );
}
