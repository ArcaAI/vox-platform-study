import { useState } from 'react'
import { DnaStyleSelector, type DnaStyleOption } from '../../../custom/dna-style-selector'

const styles: DnaStyleOption[] = [
  { id: 'concise', name: 'Concise Clinical', preview: 'Short, direct sentences.' },
  { id: 'narrative', name: 'Narrative Medical', preview: 'Flowing prose style.' },
  { id: 'structured', name: 'Structured Report', preview: 'Section-based format.' },
]

export function DefaultDnaSelector() {
  return (
    <DnaStyleSelector
      styles={styles}
      onChange={() => {}}
    />
  )
}

export function SelectedDnaSelector() {
  return (
    <DnaStyleSelector
      styles={styles}
      selectedStyleId="narrative"
      onChange={() => {}}
    />
  )
}

export function LoadingDnaSelector() {
  return (
    <DnaStyleSelector
      styles={[]}
      isLoading
      onChange={() => {}}
    />
  )
}

export function EmptyDnaSelector({ onGenerate }: { onGenerate?: () => void }) {
  return (
    <DnaStyleSelector
      styles={[]}
      onChange={() => {}}
      onGenerate={onGenerate}
    />
  )
}

export function InteractiveDnaSelector({
  onChange,
}: {
  onChange?: (id: string) => void
}) {
  const [selected, setSelected] = useState<string | undefined>()

  return (
    <div>
      <DnaStyleSelector
        styles={styles}
        selectedStyleId={selected}
        onChange={(id) => {
          setSelected(id)
          onChange?.(id)
        }}
      />
      <span data-testid="selected-style">{selected ?? ''}</span>
    </div>
  )
}
