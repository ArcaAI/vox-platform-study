import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorPagination, TablePagination } from '../table-pagination';

afterEach(cleanup);

describe('TablePagination (offset)', () => {
    it('shows the visible range and disables prev on the first page', () => {
        render(<TablePagination page={0} limit={25} total={312} onPageChange={vi.fn()} />);
        expect(screen.getByText(/showing 1[\u2013-]25 of 312/i)).toBeDefined();
        expect((screen.getByRole('button', { name: /previous page/i }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: /next page/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('advances pages and disables next on the last page', () => {
        const onPageChange = vi.fn();
        render(<TablePagination page={12} limit={25} total={312} onPageChange={onPageChange} />);
        expect((screen.getByRole('button', { name: /next page/i }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
        expect(onPageChange).toHaveBeenCalledWith(11);
    });

    it('emits limit changes through the rows-per-page select', () => {
        const onLimitChange = vi.fn();
        render(<TablePagination page={0} limit={25} total={100} onPageChange={vi.fn()} onLimitChange={onLimitChange} />);
        fireEvent.change(screen.getByLabelText(/rows per page/i), { target: { value: '50' } });
        expect(onLimitChange).toHaveBeenCalledWith(50);
    });
});

describe('CursorPagination', () => {
    it('wires prev/next to the cursor stack handlers', () => {
        const onNext = vi.fn();
        const onPrev = vi.fn();
        render(<CursorPagination hasPrev hasNext onPrev={onPrev} onNext={onNext} shownCount={25} />);
        fireEvent.click(screen.getByRole('button', { name: /next page/i }));
        expect(onNext).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
        expect(onPrev).toHaveBeenCalled();
    });

    it('disables the edges', () => {
        render(<CursorPagination hasPrev={false} hasNext={false} onPrev={vi.fn()} onNext={vi.fn()} />);
        expect((screen.getByRole('button', { name: /previous page/i }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: /next page/i }) as HTMLButtonElement).disabled).toBe(true);
    });
});
