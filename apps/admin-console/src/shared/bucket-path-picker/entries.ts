/**
 * Pure helpers over the flat object listing the gateway returns for
 * `GET storage/buckets/:name/files` (keys, not delimiter-based CommonPrefixes).
 * Shared by the storage browser and the bucket path picker — moved here from the
 * storage-browser feature (TASK-1023) because features never import each other.
 */

/** The shape of one listed object (structurally identical to the storage feature's `StorageObject`). */
export interface ListedObject {
  key: string;
  size: number;
  lastModified?: string;
}

export interface FolderEntry {
  kind: 'folder';
  name: string;
  /** Prefix to navigate into (current prefix + name + '/'). */
  prefix: string;
  count: number;
}

export interface FileEntry {
  kind: 'file';
  /** Display name relative to the current prefix. */
  name: string;
  /** Full object key as the gateway lists it. */
  key: string;
  size: number;
  lastModified?: string;
}

export type BrowserEntry = FolderEntry | FileEntry;

/** Groups the flat key listing under the current prefix into folder rows + file rows. */
export function deriveEntries(objects: ListedObject[], prefix: string): BrowserEntry[] {
  const folders = new Map<string, number>();
  const files: FileEntry[] = [];
  for (const object of objects) {
    const rest = object.key.startsWith(prefix) ? object.key.slice(prefix.length) : object.key;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      if (rest) files.push({ kind: 'file', name: rest, key: object.key, size: object.size, lastModified: object.lastModified });
    } else {
      const folder = rest.slice(0, slash);
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
  }
  const folderEntries: FolderEntry[] = [...folders.entries()].map(([name, count]) => ({
    kind: 'folder',
    name,
    prefix: `${prefix}${name}/`,
    count,
  }));
  return [...folderEntries, ...files];
}

/** Client-side sort ("field:asc|desc"): folders always group before files. */
export function sortEntries(entries: BrowserEntry[], sort: string): BrowserEntry[] {
  const [field, direction] = sort.split(':');
  const sign = direction === 'desc' ? -1 : 1;
  const folders = entries.filter((entry): entry is FolderEntry => entry.kind === 'folder');
  const files = entries.filter((entry): entry is FileEntry => entry.kind === 'file');
  folders.sort((a, b) => sign * a.name.localeCompare(b.name));
  files.sort((a, b) => {
    if (field === 'size') return sign * (a.size - b.size);
    if (field === 'modified') {
      const aTime = a.lastModified ? Date.parse(a.lastModified) : 0;
      const bTime = b.lastModified ? Date.parse(b.lastModified) : 0;
      return sign * (aTime - bTime);
    }
    return sign * a.name.localeCompare(b.name);
  });
  return [...folders, ...files];
}
