import { generateId } from './generateId';
import { uuidv7 } from 'uuidv7';
import { describe, it, expect, vi, Mock } from 'vitest';

vi.mock('uuidv7');

describe('generateId', () => {
  it('should call uuidv7 to generate a unique identifier', () => {
    const mockUuid = '123e4567-e89b-12d3-a456-426614174000';
    (uuidv7 as Mock).mockReturnValue(mockUuid);

    const result = generateId();

    expect(uuidv7).toHaveBeenCalledTimes(1);
    expect(result).toBe(mockUuid);
  });

  it('should generate different IDs on subsequent calls', () => {
    const mockUuid1 = '123e4567-e89b-12d3-a456-426614174001';
    const mockUuid2 = '123e4567-e89b-12d3-a456-426614174002';
    (uuidv7 as Mock).mockReturnValueOnce(mockUuid1).mockReturnValueOnce(mockUuid2);

    const result1 = generateId();
    const result2 = generateId();

    expect(result1).not.toBe(result2);
    expect(result1).toBe(mockUuid1);
    expect(result2).toBe(mockUuid2);
  });
});
