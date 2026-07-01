import { describe, it, expect } from 'vitest';
import { UserExportService, type UserExportRow } from '../user-export.service';

const rows: UserExportRow[] = [
    { id: 'u-1', username: 'john', email: 'john@x.com', type: 'User', status: 'ENABLED', departments: 'd-1, d-2' },
    { id: 'u-2', username: 'jane', email: '', type: 'Service account', status: 'DISABLED', departments: '' },
];

describe('UserExportService (TASK-388 #10)', () => {
    const svc = new UserExportService();

    it('csv: header + one line per row, quoting values that contain commas', async () => {
        const file = await svc.build('csv', rows);
        const text = file.buffer.toString('utf-8');

        expect(file.contentType).toContain('text/csv');
        expect(file.filename).toBe('users.csv');
        const lines = text.split('\n');
        expect(lines[0]).toBe('Username,Email,Type,Status,Departments,ID');
        expect(lines[1]).toBe('john,john@x.com,User,ENABLED,"d-1, d-2",u-1');
        expect(lines[2]).toBe('jane,,Service account,DISABLED,,u-2');
    });

    it('xlsx: non-empty buffer with the spreadsheet content-type + PK (zip) signature', async () => {
        const file = await svc.build('xlsx', rows);

        expect(file.contentType).toContain('spreadsheetml');
        expect(file.filename).toBe('users.xlsx');
        expect(file.buffer.length).toBeGreaterThan(0);
        expect(file.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    });

    it('pdf: non-empty buffer with the pdf content-type + %PDF header', async () => {
        const file = await svc.build('pdf', rows);

        expect(file.contentType).toBe('application/pdf');
        expect(file.filename).toBe('users.pdf');
        expect(file.buffer.length).toBeGreaterThan(0);
        expect(file.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
    });

    it('empty result set still produces a valid CSV (header only)', async () => {
        const file = await svc.build('csv', []);
        expect(file.buffer.toString('utf-8')).toBe('Username,Email,Type,Status,Departments,ID');
    });
});
