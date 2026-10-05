'use client';

/**
 * The Input shape and Output shape of a workflow (TASK-1036 §3.6), as two small tables derived from
 * its context schema by `deriveRunShapes`. "Input shape" / "Output shape" are the console's words;
 * the wire keeps `kinds` and `outputs`.
 *
 * A shape the schema does not declare is stated as "not declared" — never an empty table, which
 * would read as "this workflow takes nothing".
 */
import { Badge, Skeleton } from '@arcaai/ui';
import type { ShapeField } from '@/shared/docs/run-shapes';

function ShapeTable({ title, fields, emptyText }: { title: string; fields: readonly ShapeField[]; emptyText: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {fields.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyText}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Field
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Type
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Required
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Data class
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.path} className="border-t align-top">
                  <td className="px-2 py-1.5 font-mono break-all">{field.path}</td>
                  <td className="px-2 py-1.5">
                    <span className="font-mono">{field.type}</span>
                    {field.delivery ? <span className="text-muted-foreground"> · {field.delivery}</span> : null}
                  </td>
                  <td className="px-2 py-1.5">{field.required ? <Badge variant="default">Required</Badge> : <span className="text-muted-foreground">Optional</span>}</td>
                  <td className="px-2 py-1.5">{field.phi === 'PHI' ? <Badge variant="destructive">PHI</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export interface ShapeTablesProps {
  input: readonly ShapeField[];
  output: readonly ShapeField[];
  /** The context schema is still being fetched. */
  loading?: boolean;
}

export function ShapeTables({ input, output, loading = false }: ShapeTablesProps) {
  if (loading) {
    return (
      <div className="grid gap-4 @2xl:grid-cols-2" aria-hidden>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  return (
    <div className="grid gap-4 @2xl:grid-cols-2">
      <ShapeTable title="Input shape" fields={input} emptyText="Input shape: not declared. This workflow’s context schema does not say what a run takes." />
      <ShapeTable title="Output shape" fields={output} emptyText="Output shape: not declared. The result is whatever the End step produces." />
    </div>
  );
}
