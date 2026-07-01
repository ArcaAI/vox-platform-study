import { Injectable } from '@nestjs/common';
import { buildTableExport, type TableColumn, type TableExportFile, type TableExportFormat } from '../../shared/table-export';

/**
 * TASK-388 #10 — server-side user export (CSV parity + Excel + PDF).
 *
 * TASK-390 #25 — the csv/xlsx/pdf rendering now lives in the shared, generic
 * `../../shared/table-export` module (reused by the Audit-log export); this
 * service just declares the Users column set + rows and delegates. The public
 * API (`build`) and the CSV bytes are unchanged.
 */
export type UserExportFormat = TableExportFormat;
export type UserExportFile = TableExportFile;

export interface UserExportRow {
  id: string;
  username: string;
  email: string;
  /** 'Service account' | 'User' */
  type: string;
  status: string;
  /** Comma-joined department identifiers (name enrichment is a flagged follow-up). */
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
