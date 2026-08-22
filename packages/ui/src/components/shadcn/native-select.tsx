import * as React from 'react';

import { cn } from '@/lib/utils';

function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex h-9 w-full appearance-none rounded-surface border px-3 py-1 text-sm transition-[color,box-shadow] outline-hidden focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

function NativeSelectOption({ ...props }: React.ComponentProps<'option'>) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup({ ...props }: React.ComponentProps<'optgroup'>) {
  return <optgroup data-slot="native-select-optgroup" {...props} />;
}

export { NativeSelect, NativeSelectOption, NativeSelectOptGroup };
