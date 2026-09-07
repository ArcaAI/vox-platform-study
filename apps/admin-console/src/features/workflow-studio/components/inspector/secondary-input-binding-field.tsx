'use client';

/**
 * TASK-893 B5 (INTERFACES.md Contract B §4.2) — a secondary DATA input, rendered as an
 * inspector field instead of a canvas wire. One `<SecondaryInputBindingField>` per entry in
 * `secondaryInputsFor()` (Lane D, `lib/canvas-handles.ts`): a labelled picker over
 * `upstreamNodes`, in execution order, with a "None" option that clears the binding.
 *
 * The written shape is the contract other lanes depend on: `config.inputs.<portName> =
 * { fromNodeId }`, cleared by omitting the key entirely (never left as an explicit `null`/
 * `undefined` residue) — `InspectorPanel` owns the read/write glue against `node.config`;
 * this component only renders one binding given its current value.
 */
import { Field, FieldDescription, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui';
import { humanizeKey } from '../../lib/schema-form';

/** Matches the `__none__` sentinel convention already used for a clearable `Select`
 *  (`features/agents/components/instruction-binding-form.tsx`) — Radix `Select` reserves the
 *  empty string, so "no binding" needs its own value rather than `''`. */
const NONE_VALUE = '__none__';

export interface UpstreamNodeOption {
  id: string;
  label: string;
  step: number | null;
}

export interface SecondaryInputBindingFieldProps {
  id: string;
  /** The port this binds — config lives at `inputs.<portName>`. */
  portName: string;
  primitive: string;
  required: boolean;
  upstreamNodes: readonly UpstreamNodeOption[];
  /** The bound node id, or `null` when unbound. */
  value: string | null;
  onChange: (fromNodeId: string | null) => void;
  errors?: string[];
  disabled?: boolean;
}

function optionLabel(node: UpstreamNodeOption): string {
  return node.step != null ? `${node.step}. ${node.label}` : node.label;
}

export function SecondaryInputBindingField({
  id,
  portName,
  primitive,
  required,
  upstreamNodes,
  value,
  onChange,
  errors,
  disabled,
}: SecondaryInputBindingFieldProps) {
  const invalid = (errors?.length ?? 0) > 0 ? 'true' : undefined;

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>
        {humanizeKey(portName)}
        {required ? ' *' : ''}
      </FieldLabel>
      <FieldDescription>
        A {primitive} value from an earlier step in this workflow{required ? '' : ' — optional'}.
      </FieldDescription>
      {/* A binding whose source is no longer UPSTREAM is rendered as its own option rather than
          left to Radix's `placeholder`: `SelectValue` falls back to the placeholder only when the
          value is UNSET, so a value matching no `SelectItem` displays as an empty trigger — the
          binding would silently vanish from the form while the edge still exists on the graph.
          The reachable case is reordering, not deletion (deleting a node takes its edges with it):
          bind `context` to an earlier node, then move that node after this one. Kept selectable so
          it stays the displayed value, and labelled so the admin can see it needs attention. */}
      <Select value={value ?? NONE_VALUE} onValueChange={(next) => onChange(next === NONE_VALUE ? null : next)} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>None</SelectItem>
          {upstreamNodes.map((node) => (
            <SelectItem key={node.id} value={node.id}>
              {optionLabel(node)}
            </SelectItem>
          ))}
          {value !== null && !upstreamNodes.some((node) => node.id === value) ? (
            <SelectItem value={value} className="text-destructive">
              {value} (not upstream anymore)
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {errors && errors.length > 0 ? (
        <p role="alert" className="text-destructive text-sm">
          {errors.join(' ')}
        </p>
      ) : null}
    </Field>
  );
}
