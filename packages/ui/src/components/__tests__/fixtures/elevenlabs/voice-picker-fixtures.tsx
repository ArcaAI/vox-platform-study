import * as React from 'react';
import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';
import { Check, ChevronsUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/shadcn/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/shadcn/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';

const mockVoices: ElevenLabs.Voice[] = [
  {
    voiceId: 'voice-1',
    name: 'Rachel',
    labels: { accent: 'American', gender: 'female', age: 'young' },
  } as ElevenLabs.Voice,
  {
    voiceId: 'voice-2',
    name: 'Drew',
    labels: { accent: 'American', gender: 'male', age: 'middle aged' },
  } as ElevenLabs.Voice,
  {
    voiceId: 'voice-3',
    name: 'Clyde',
    labels: { accent: 'British', gender: 'male', age: 'young' },
  } as ElevenLabs.Voice,
];

/**
 * Test-only VoicePicker that mirrors the real component's DOM structure
 * but avoids Three.js (Orb) and AudioPlayerProvider dependencies that
 * cause WebGL memory issues in Playwright CT.
 */
function TestVoicePicker({
  voices,
  value,
  onValueChange,
  placeholder = 'Select a voice...',
  className,
}: {
  voices: ElevenLabs.Voice[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selectedVoice = voices.find((v) => v.voiceId === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className={cn('w-full justify-between', className)}>
          {selectedVoice ? (
            <div className="flex items-center gap-2 overflow-hidden">
              <div className="relative size-6 shrink-0 overflow-visible">
                <div className="bg-muted size-full rounded-full" />
              </div>
              <span className="truncate">{selectedVoice.name}</span>
            </div>
          ) : (
            placeholder
          )}
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder="Search voices..." />
          <CommandList>
            <CommandEmpty>No voice found.</CommandEmpty>
            <CommandGroup>
              {voices.map((voice) => (
                <CommandItem
                  key={voice.voiceId}
                  value={voice.voiceId!}
                  keywords={[voice.name, voice.labels?.accent, voice.labels?.gender, voice.labels?.age].filter((k): k is string => Boolean(k))}
                  onSelect={() => onValueChange?.(voice.voiceId!)}
                  className="flex items-center gap-3"
                >
                  <div className="bg-muted size-8 shrink-0 rounded-full" />
                  <div className="flex flex-1 flex-col gap-0.5">
                    <span className="font-medium">{voice.name}</span>
                    {voice.labels && (
                      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        {voice.labels.accent && <span>{voice.labels.accent}</span>}
                        {voice.labels.gender && <span>•</span>}
                        {voice.labels.gender && <span className="capitalize">{voice.labels.gender}</span>}
                        {voice.labels.age && <span>•</span>}
                        {voice.labels.age && <span className="capitalize">{voice.labels.age}</span>}
                      </div>
                    )}
                  </div>
                  <Check className={cn('ml-auto size-4 shrink-0', value === voice.voiceId ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function VoicePickerFixture({ value = '', placeholder }: { value?: string; placeholder?: string }) {
  return <TestVoicePicker voices={mockVoices} value={value} placeholder={placeholder} />;
}

export function EmptyVoicePickerFixture() {
  return <TestVoicePicker voices={[]} />;
}
