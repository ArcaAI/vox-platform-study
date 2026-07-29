import { HoverCard, HoverCardTrigger, HoverCardContent } from '../../../shadcn/hover-card';

export function BasicHoverCard() {
  return (
    <HoverCard openDelay={0} closeDelay={0}>
      <HoverCardTrigger asChild>
        <button>Hover me</button>
      </HoverCardTrigger>
      <HoverCardContent>
        <div>Hover card content</div>
        <p>Additional details here</p>
      </HoverCardContent>
    </HoverCard>
  );
}

export function DefaultOpenHoverCard() {
  return (
    <HoverCard defaultOpen>
      <HoverCardTrigger asChild>
        <button>Trigger</button>
      </HoverCardTrigger>
      <HoverCardContent>
        <div>Visible content</div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function HoverCardWithCustomClass() {
  return (
    <HoverCard defaultOpen>
      <HoverCardTrigger asChild>
        <button>Trigger</button>
      </HoverCardTrigger>
      <HoverCardContent className="custom-hover-class">
        <div>Styled content</div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function HoverCardWithAlign({ align = 'center' }: { align?: 'start' | 'center' | 'end' }) {
  return (
    <HoverCard defaultOpen>
      <HoverCardTrigger asChild>
        <button>Trigger</button>
      </HoverCardTrigger>
      <HoverCardContent align={align}>
        <div>Aligned content</div>
      </HoverCardContent>
    </HoverCard>
  );
}
