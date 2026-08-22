'use client';

import { cn } from '../../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select';
import { Label } from '../shadcn/label';
import { IconBuilding, IconMessage } from '@tabler/icons-react';

export interface DepartmentOption {
  id: string;
  name: string;
}

export interface PromptOption {
  id: string;
  name: string;
  category?: string;
}

interface DeptPromptSelectorProps {
  departments: DepartmentOption[];
  prompts: PromptOption[];
  selectedDepartmentId?: string;
  selectedPromptId?: string;
  onDepartmentChange: (departmentId: string) => void;
  onPromptChange: (promptId: string) => void;
  isLoading?: boolean;
  className?: string;
}

export function DeptPromptSelector({
  departments,
  prompts,
  selectedDepartmentId,
  selectedPromptId,
  onDepartmentChange,
  onPromptChange,
  isLoading = false,
  className,
}: DeptPromptSelectorProps) {
  const isDepartmentSelected = !!selectedDepartmentId;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-col gap-2">
        <Label className="text-sm">
          <IconBuilding className="size-4 text-muted-foreground" />
          Department
        </Label>
        <Select value={selectedDepartmentId} onValueChange={onDepartmentChange} disabled={isLoading}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={isLoading ? 'Loading...' : 'Select a department'} />
          </SelectTrigger>
          <SelectContent>
            {departments.map((dept) => (
              <SelectItem key={dept.id} value={dept.id}>
                {dept.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-sm">
          <IconMessage className="size-4 text-muted-foreground" />
          Prompt Template
        </Label>
        <Select value={selectedPromptId} onValueChange={onPromptChange} disabled={isLoading || !isDepartmentSelected}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={isLoading ? 'Loading...' : isDepartmentSelected ? 'Select a prompt template' : 'Select a department first'} />
          </SelectTrigger>
          <SelectContent>
            {prompts.map((prompt) => (
              <SelectItem key={prompt.id} value={prompt.id}>
                <span className="flex items-center gap-2">
                  {prompt.name}
                  {prompt.category && <span className="text-xs text-muted-foreground">{prompt.category}</span>}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
