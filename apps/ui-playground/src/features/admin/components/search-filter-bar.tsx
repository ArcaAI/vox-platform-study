import { useEffect, useRef, useState } from 'react';
import { Input } from '@arcaai/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Filter, Search, X } from 'lucide-react';
import { Button } from '@arcaai/ui/button';

interface SearchFilterBarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  statusFilter?: string;
  onStatusFilterChange?: (value: string) => void;
  statusOptions?: { value: string; label: string }[];
  children?: React.ReactNode;
}

export function SearchFilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search…',
  statusFilter,
  onStatusFilterChange,
  statusOptions,
  children,
}: SearchFilterBarProps) {
  const [localValue, setLocalValue] = useState(searchValue);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setLocalValue(searchValue);
  }, [searchValue]);

  const handleChange = (value: string) => {
    setLocalValue(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchChange(value), 250);
  };

  const handleClear = () => {
    setLocalValue('');
    clearTimeout(debounceRef.current);
    onSearchChange('');
  };

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-48 flex-1">
        <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
        <Input
          placeholder={searchPlaceholder}
          value={localValue}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange(e.target.value)}
          className="pl-9 pr-8"
        />
        {localValue && (
          <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 size-6 -translate-y-1/2" onClick={handleClear} tabIndex={-1}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {statusOptions && statusFilter !== undefined && onStatusFilterChange && (
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
          <SelectTrigger className="w-40">
            <Filter className="mr-1.5 size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {children}
    </div>
  );
}
