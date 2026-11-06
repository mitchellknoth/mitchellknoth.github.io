// Adapter from the agent HTTP contract to the AI SDK's UIMessage, the message shape shadcn/ui's
// AI Elements patterns (Message, Sources) are written against. The agent does not stream yet, so
// a reply becomes one finished assistant message: a text part, then one source-url part per
// distinct citation. When streaming arrives, the same parts can be built incrementally.
import type { SourceUrlUIPart, UIMessage } from 'ai';
import type { AskReply, Refusal } from './contract';

export type AgentMessageMetadata =
  | { status: 'answered' }
  | { status: 'refused'; refusal: Refusal }
  | { status: 'unanswered' };

export type AgentUIMessage = UIMessage<AgentMessageMetadata>;

export function userMessage(id: string, text: string): AgentUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

export function replyToMessage(id: string, reply: AskReply): AgentUIMessage {
  switch (reply.status) {
    case 'answered': {
      const seen = new Set<string>();
      const sources: SourceUrlUIPart[] = [];
      for (const source of reply.sources) {
        if (seen.has(source.url)) continue;
        seen.add(source.url);
        sources.push({ type: 'source-url', sourceId: source.id, url: source.url, title: source.title });
      }
      return { id, role: 'assistant', metadata: { status: 'answered' }, parts: [{ type: 'text', text: reply.text }, ...sources] };
    }
    case 'refused':
      return {
        id,
        role: 'assistant',
        metadata: { status: 'refused', refusal: reply.refusal },
        parts: [{ type: 'text', text: reply.text }],
      };
    case 'unanswered':
      // `reason` is for operators; the visitor gets the island's own wording.
      return { id, role: 'assistant', metadata: { status: 'unanswered' }, parts: [] };
  }
}

export function textOf(message: AgentUIMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
}

export function sourcesOf(message: AgentUIMessage): SourceUrlUIPart[] {
  return message.parts.filter((part): part is SourceUrlUIPart => part.type === 'source-url');
}
