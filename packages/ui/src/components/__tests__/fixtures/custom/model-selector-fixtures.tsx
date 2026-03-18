import { useState } from 'react'
import { ModelSelector, type ModelOption } from '../../../custom/model-selector'

const models: ModelOption[] = [
  { id: 'gpt-4o', name: 'GPT-4o', source: 'backend', description: 'Latest multimodal model' },
  { id: 'whisper-large', name: 'Whisper Large v3', source: 'huggingface', description: 'Speech recognition' },
  { id: 'whisper-local', name: 'Whisper Local', source: 'local' },
]

export function DefaultModelSelector() {
  return (
    <ModelSelector
      label="AI Model"
      models={models}
      onChange={() => {}}
    />
  )
}

export function SelectedModelSelector() {
  return (
    <ModelSelector
      label="AI Model"
      models={models}
      selectedModelId="gpt-4o"
      onChange={() => {}}
    />
  )
}

export function LoadingModelSelector() {
  return (
    <ModelSelector
      label="AI Model"
      models={[]}
      isLoading
      onChange={() => {}}
    />
  )
}

export function NoneOptionModelSelector() {
  return (
    <ModelSelector
      label="STT Model"
      models={models}
      noneOption
      onChange={() => {}}
    />
  )
}

export function InteractiveModelSelector({
  onChange,
}: {
  onChange?: (id: string) => void
}) {
  const [selected, setSelected] = useState<string | undefined>()

  return (
    <div>
      <ModelSelector
        label="AI Model"
        models={models}
        selectedModelId={selected}
        onChange={(id) => {
          setSelected(id)
          onChange?.(id)
        }}
      />
      <span data-testid="selected-model">{selected ?? ''}</span>
    </div>
  )
}
