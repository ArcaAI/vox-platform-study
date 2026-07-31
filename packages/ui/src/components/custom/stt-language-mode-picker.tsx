import { cn } from '../../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select';
import { Label } from '../shadcn/label';
import { Badge } from '../shadcn/badge';
import { Skeleton } from '../shadcn/skeleton';
import { IconLanguage } from '@tabler/icons-react';

/**
 * A selectable STT language mode (TASK-587). Structurally matches an entry of
 * `@arcaai/vox`'s `LanguageMode`, but the field set is intentionally minimal so
 * this presentational picker stays decoupled from the SDK. The consuming app
 * feeds it from `useArcaSttLanguageModes()` and passes the chosen `id` to
 * `audio.start({ languageMode })`.
 */
export interface SttLanguageModeOption {
  /** Stable mode id, e.g. 'en', 'ml', 'ml-en', 'auto'. */
  id: string;
  /** Human-readable label, e.g. 'Malayalam + English'. */
  label: string;
  /** Single language, bilingual code-switch, or auto-detect. */
  kind?: 'single' | 'code_switch' | 'auto';
}

interface SttLanguageModePickerProps {
  /** Field label. */
  label?: string;
  /** Modes to offer (from the backend catalog). */
  modes: SttLanguageModeOption[];
  /** Currently selected mode id. */
  value?: string;
  /** Fired with the newly selected mode id. */
  onValueChange: (modeId: string) => void;
  /** Render a loading skeleton in place of the control. */
  isLoading?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Presentational language-mode picker for the STT pipeline. Decoupled from the
 * SDK — wire it to `useArcaSttLanguageModes()` in the app. A `code_switch` mode
 * (e.g. "Malayalam + English") is flagged so the user knows it is bilingual;
 * the backend guarantees the selected mode fits the session's engines (a mode
 * no configured engine can serve is rejected at session-create).
 */
export function SttLanguageModePicker({
  label = 'Language',
  modes,
  value,
  onValueChange,
  isLoading,
  disabled,
  className,
}: SttLanguageModePickerProps) {
  const selected = modes.find((m) => m.id === value);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor="stt-language-mode">
        <IconLanguage className="size-4 text-muted-foreground" aria-hidden />
        {label}
      </Label>

      {isLoading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <Select value={value} onValueChange={onValueChange} disabled={disabled}>
          <SelectTrigger id="stt-language-mode" aria-label={label} className="w-full">
            <SelectValue placeholder="Select a language">
              {selected && (
                <span className="flex items-center gap-2">
                  {selected.label}
                  {selected.kind === 'code_switch' && (
                    <Badge variant="secondary" className="text-[10px] leading-tight">
                      Bilingual
                    </Badge>
                  )}
                </span>
              )}
            </SelectValue>
          </SelectTrigger>

          <SelectContent>
            {modes.map((mode) => (
              <SelectItem key={mode.id} value={mode.id}>
                <span className="flex items-center gap-2">
                  {mode.label}
                  {mode.kind === 'code_switch' && (
                    <Badge variant="secondary" className="text-[10px] leading-tight">
                      Bilingual
                    </Badge>
                  )}
                  {mode.kind === 'auto' && (
                    <Badge variant="outline" className="text-[10px] leading-tight">
                      Auto
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
