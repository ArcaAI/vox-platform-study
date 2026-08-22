/**
 * Standard "human-readable first" cell: the display name is the
 * primary label; the id is demoted to muted mono metadata underneath. When no
 * name is available the id stands alone (still mono) so nothing breaks while
 * a catalog loads or when the caller cannot resolve the name.
 */
export function NameWithId({ name, id, showId = true }: { name?: string | null; id: string; showId?: boolean }) {
  if (!name || name === id) {
    return <span className="font-mono text-xs break-all">{id}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">{name}</span>
      {showId ? <span className="text-muted-foreground font-mono text-xs leading-tight break-all">{id}</span> : null}
    </span>
  );
}
