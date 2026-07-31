import { useState } from 'react';
import { SttLanguageModePicker, type SttLanguageModeOption } from '../../../custom/stt-language-mode-picker';

const modes: SttLanguageModeOption[] = [
  { id: 'en', label: 'English', kind: 'single' },
  { id: 'ml', label: 'Malayalam', kind: 'single' },
  { id: 'ml-en', label: 'Malayalam + English', kind: 'code_switch' },
  { id: 'auto', label: 'Auto-detect', kind: 'auto' },
];

export function DefaultLanguageModePicker() {
  return <SttLanguageModePicker modes={modes} onValueChange={() => {}} />;
}

export function SelectedLanguageModePicker() {
  return <SttLanguageModePicker modes={modes} value="ml-en" onValueChange={() => {}} />;
}

export function LoadingLanguageModePicker() {
  return <SttLanguageModePicker modes={[]} isLoading onValueChange={() => {}} />;
}

export function InteractiveLanguageModePicker({ onValueChange }: { onValueChange?: (id: string) => void }) {
  const [value, setValue] = useState<string | undefined>();
  return (
    <div>
      <SttLanguageModePicker
        modes={modes}
        value={value}
        onValueChange={(id) => {
          setValue(id);
          onValueChange?.(id);
        }}
      />
      <span data-testid="selected-mode">{value ?? ''}</span>
    </div>
  );
}
