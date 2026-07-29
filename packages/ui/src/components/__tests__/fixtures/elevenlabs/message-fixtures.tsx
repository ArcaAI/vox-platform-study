import { Message, MessageContent, MessageAvatar } from '../../../elevenlabs/message';

export function UserMessage() {
  return (
    <Message from="user">
      <MessageContent>Hello from user</MessageContent>
    </Message>
  );
}

export function AssistantMessage() {
  return (
    <Message from="assistant">
      <MessageContent>Hello from assistant</MessageContent>
    </Message>
  );
}

export function MessageWithAvatar() {
  return (
    <Message from="user">
      <MessageAvatar src="https://github.com/shadcn.png" name="User" />
      <MessageContent>Message with avatar</MessageContent>
    </Message>
  );
}

export function FlatMessage() {
  return (
    <Message from="user">
      <MessageContent variant="flat">Flat variant message</MessageContent>
    </Message>
  );
}

export function ContainedMessage() {
  return (
    <Message from="assistant">
      <MessageContent variant="contained">Contained variant message</MessageContent>
    </Message>
  );
}
