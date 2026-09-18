'use client';

import { useState } from 'react';
import { IconChevronDown, IconChevronRight, IconDots, IconPencil, IconRefresh, IconTrash } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { cx } from '@/shared/cx';
import { useDepartmentChildren } from '../api/hooks';
import type { Department } from '../api/types';

function displayName(department: Department): string {
  return department.name || department.code || department.id;
}

/**
 * Per-row Edit/Delete menu. Before this existed, the ONLY way to reach either
 * action was the "Edit" button inside the Prompt config pane — a control whose
 * label and placement read as "edit the prompt config", so a user looking to
 * delete a department had no reason to click it and concluded deletion was
 * unavailable. The gateway always allowed it; only the affordance was missing.
 */
function RowActions({ department, onEdit, onDelete }: { department: Department; onEdit: (id: string) => void; onDelete: (id: string) => void }) {
  const name = displayName(department);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`Open actions for ${name}`} onClick={(event) => event.stopPropagation()}>
          <IconDots aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onEdit(department.id)}>
          <IconPencil aria-hidden />
          Edit department
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(department.id)}>
          <IconTrash aria-hidden />
          Delete department
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SelectDepartmentButton({ department, selected, onSelect }: { department: Department; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(department.id)}
      aria-current={selected ? 'true' : undefined}
      className={cx(
        'focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm outline-none focus-visible:ring-2',
        selected ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50',
      )}
    >
      <span className="truncate">{displayName(department)}</span>
      {department.code ? <span className="text-muted-foreground shrink-0 font-mono text-xs">{department.code}</span> : null}
    </button>
  );
}

function TreeNode({
  department,
  selectedId,
  onSelect,
  onEdit,
  onDelete,
}: {
  department: Department;
  selectedId: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = displayName(department);
  return (
    <li>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <IconChevronDown aria-hidden /> : <IconChevronRight aria-hidden />}
        </Button>
        <SelectDepartmentButton department={department} selected={department.id === selectedId} onSelect={onSelect} />
        <RowActions department={department} onEdit={onEdit} onDelete={onDelete} />
      </div>
      {expanded ? <TreeChildren parentId={department.id} selectedId={selectedId} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} /> : null}
    </li>
  );
}

/** Lazy per-node children read: mounted (and fetched) only once expanded. */
function TreeChildren({
  parentId,
  selectedId,
  onSelect,
  onEdit,
  onDelete,
}: {
  parentId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const children = useDepartmentChildren(parentId);
  const rows = children.data ?? [];

  if (children.isPending) {
    return (
      <div className="flex flex-col gap-1 py-1 pl-9" aria-hidden>
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  }
  if (children.error) {
    return (
      <div role="alert" className="flex items-center gap-2 py-1 pl-9">
        <span className="text-destructive text-xs">Couldn{'\u2019'}t load sub-departments.</span>
        <Button variant="ghost" size="xs" onClick={() => void children.refetch()}>
          <IconRefresh aria-hidden />
          Retry
        </Button>
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-1 pl-9 text-xs">No sub-departments</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 pl-4">
      {rows.map((child) => (
        <TreeNode key={child.id} department={child} selectedId={selectedId} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </ul>
  );
}

/**
 * Frame 30 hierarchy card: roots expand lazily into GET :id/children and a
 * click selects the department for the members/edit panels. An active search
 * flattens the card into matches over the full GET /admin/departments list
 * (children included), since the tree cannot represent partial matches.
 */
export function DepartmentHierarchyPanel({
  roots,
  rootsPending,
  rootsError,
  onRetryRoots,
  searchResults,
  searching,
  selectedId,
  onSelect,
  onEdit,
  onDelete,
}: {
  roots: Department[];
  rootsPending: boolean;
  rootsError: unknown;
  onRetryRoots: () => void;
  /** Matches over the flat list; rendered instead of the tree when searching. */
  searchResults: Department[];
  searching: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">Hierarchy</h2>
        <p aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /roots + :id/children
        </p>
      </div>
      {searching ? (
        searchResults.length === 0 ? (
          <p className="text-muted-foreground py-2 text-sm">No departments match your search.</p>
        ) : (
          <ul aria-label="Department hierarchy" className="flex flex-col gap-0.5">
            {searchResults.map((department) => (
              <li key={department.id} className="flex items-center gap-1">
                <SelectDepartmentButton department={department} selected={department.id === selectedId} onSelect={onSelect} />
                <RowActions department={department} onEdit={onEdit} onDelete={onDelete} />
              </li>
            ))}
          </ul>
        )
      ) : rootsPending ? (
        <div className="flex flex-col gap-2 py-1" aria-hidden>
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </div>
      ) : rootsError ? (
        <div role="alert" className="flex flex-col items-start gap-2 py-2">
          <p className="text-destructive text-sm">Couldn{'\u2019'}t load the hierarchy.</p>
          <Button variant="outline" size="sm" onClick={onRetryRoots}>
            <IconRefresh aria-hidden />
            Retry
          </Button>
        </div>
      ) : (
        <ul aria-label="Department hierarchy" className="flex flex-col gap-0.5">
          {roots.map((department) => (
            <TreeNode key={department.id} department={department} selectedId={selectedId} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </Card>
  );
}
