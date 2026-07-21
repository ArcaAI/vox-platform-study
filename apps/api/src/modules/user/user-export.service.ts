import { Injectable } from '@nestjs/common';
import { buildTableExport, type TableColumn, type TableExportFile, type TableExportFormat } from '../../shared/table-export';

/**
 * Server-side user export (CSV parity + Excel + PDF).
 *
 * The csv/xlsx/pdf rendering lives in the shared, generic
 * `../../shared/table-export` module (reused by the Audit-log export); this
 * service just declares the Users column set + rows and delegates.
 */
export type UserExportFormat = TableExportFormat;
export type UserExportFile = TableExportFile;

export interface UserExportRow {
  id: string;
  username: string;
  /** Human-readable email (batched enrichment; blank when no profile). */
  email: string;
  /** 'Service account' | 'User' */
  type: string;
  status: string;
  /** Comma-joined department NAMES (primary first, blank when none). */
  departments: string;
}

const COLUMNS: TableColumn<UserExportRow>[] = [
  { key: 'username', header: 'Username', width: 24 },
  { key: 'email', header: 'Email', width: 28 },
  { key: 'type', header: 'Type', width: 16 },
  { key: 'status', header: 'Status', width: 14 },
  { key: 'departments', header: 'Departments', width: 30 },
  { key: 'id', header: 'ID', width: 38 },
];

@Injectable()
export class UserExportService {
  build(format: UserExportFormat, rows: UserExportRow[]): Promise<UserExportFile> {
    return buildTableExport(format, { columns: COLUMNS, rows, baseName: 'users', title: 'Users export', sheetName: 'Users' });
  }
}
