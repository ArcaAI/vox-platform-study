import { cn } from '../utils';

describe('cn', () => {
  it('should return empty string for no arguments', () => {
    expect(cn()).toBe('');
  });

  it('should merge single class string', () => {
    expect(cn('px-4')).toBe('px-4');
  });

  it('should merge multiple class strings', () => {
    const result = cn('px-4', 'py-2', 'text-sm');
    expect(result).toContain('px-4');
    expect(result).toContain('py-2');
    expect(result).toContain('text-sm');
  });

  it('should handle conditional classes (falsy values ignored)', () => {
    expect(cn('px-4', false && 'hidden', 'py-2')).toBe('px-4 py-2');
    expect(cn('px-4', undefined, 'py-2')).toBe('px-4 py-2');
    expect(cn('px-4', null, 'py-2')).toBe('px-4 py-2');
    expect(cn('px-4', 0 && 'hidden', 'py-2')).toBe('px-4 py-2');
  });

  it('should merge tailwind classes correctly (last wins for conflicting utilities)', () => {
    expect(cn('px-4', 'px-8')).toBe('px-8');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    expect(cn('bg-white', 'bg-black')).toBe('bg-black');
  });

  it('should handle array inputs', () => {
    expect(cn(['px-4', 'py-2'])).toBe('px-4 py-2');
  });

  it('should handle undefined and null inputs', () => {
    expect(cn(undefined)).toBe('');
    expect(cn(null)).toBe('');
    expect(cn(undefined, null)).toBe('');
  });
});
