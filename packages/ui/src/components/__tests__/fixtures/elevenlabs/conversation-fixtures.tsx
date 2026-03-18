import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from '../../../elevenlabs/conversation'
import { Message, MessageContent } from '../../../elevenlabs/message'

export function EmptyConversation() {
  return (
    <div style={{ height: '400px' }}>
      <Conversation data-testid="conversation">
        <ConversationContent>
          <ConversationEmptyState />
        </ConversationContent>
      </Conversation>
    </div>
  )
}

export function CustomEmptyConversation() {
  return (
    <div style={{ height: '400px' }}>
      <Conversation data-testid="conversation">
        <ConversationContent>
          <ConversationEmptyState
            title="Custom Title"
            description="Custom description text"
          />
        </ConversationContent>
      </Conversation>
    </div>
  )
}

export function ConversationWithMessages() {
  return (
    <div style={{ height: '400px' }}>
      <Conversation data-testid="conversation">
        <ConversationContent>
          <Message from="user">
            <MessageContent>User message</MessageContent>
          </Message>
          <Message from="assistant">
            <MessageContent>Assistant response</MessageContent>
          </Message>
        </ConversationContent>
      </Conversation>
    </div>
  )
}
