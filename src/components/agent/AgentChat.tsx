// The homepage agent island (#18). Built from shadcn/ui AI Elements patterns — Chat, Message,
// Prompt Input and Sources — over unmodified components in src/components/ui; the theme layer in
// src/styles/agent-theme.css maps them to DESIGN.md. The page around it is pre-rendered and works
// without it: every state that stops the conversation points visitors to the work instead.
import * as React from 'react';
import { ArrowUpIcon, LoaderCircleIcon } from 'lucide-react';

import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { Message, MessageContent } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { askQuestion, checkHealth } from '@/lib/agent/client';
import type { StoppedState } from '@/lib/agent/contract';
import { replyToMessage, sourcesOf, textOf, userMessage, type AgentUIMessage } from '@/lib/agent/messages';
import { AgentSources } from './AgentSources';
import { ensureHumanClearance } from './turnstile';
import './agent-chat.css';

/** What the island shows. `data-state` on the root carries `kind`, for styling and tests. */
type View =
  | { kind: 'loading' }
  | { kind: 'online' }
  | { kind: 'answering' }
  /** The last question got no answer (502 or a malformed reply); the visitor may send it again. */
  | { kind: 'error' }
  | { kind: 'too-long'; maxChars?: number }
  /** This host has no agent (a static host, or a response outside the contract): render nothing. */
  | { kind: 'absent' }
  | StoppedState;

const SUGGESTIONS = [
  'What is Team Brain, and why did Mitch build it?',
  'Why should the agent harness not live on a laptop?',
  'What has Mitch worked on in cloud networking?',
];

const isStopped = (view: View): view is StoppedState =>
  view.kind === 'offline' || view.kind === 'paused' || view.kind === 'blocked' || view.kind === 'limit' || view.kind === 'unverified';

function formatUntil(until: string) {
  return new Intl.DateTimeFormat(undefined, {
    // dateStyle/timeStyle can't be combined with timeZoneName, so spell the fields out.
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(until));
}

function Until({ until }: { until?: string }) {
  if (!until) return null;
  return (
    <>
      {' '}
      until <time dateTime={until}>{formatUntil(until)}</time>
    </>
  );
}

/** The routes every stopped or failed state offers, so no state is a dead end. */
function WorkRoutes() {
  return (
    <p className="agent-routes">
      <a href="/work/" className="standalone-link">
        Browse the work →
      </a>
      <a href="/writing/" className="standalone-link">
        Read the writing →
      </a>
    </p>
  );
}

function StoppedNotice({ view, noticeRef }: { view: StoppedState; noticeRef: React.Ref<HTMLDivElement> }) {
  let message: React.ReactNode;
  switch (view.kind) {
    case 'offline':
      message = 'The agent is switched off right now. Everything it would draw on is published here.';
      break;
    case 'paused':
      message = (
        <>
          The agent has used its daily budget and is paused
          {view.until ? <Until until={view.until} /> : ' until the budget resets'}. Everything it would draw on is
          published here.
        </>
      );
      break;
    case 'blocked':
      message = (
        <>
          This connection can’t use the agent right now
          <Until until={view.until} />. The rest of the site is open as usual.
        </>
      );
      break;
    case 'limit':
      message = 'This conversation has reached its message limit. The pages the agent draws on are all here.';
      break;
    case 'unverified':
      message = 'Cloudflare couldn’t confirm this browser is operated by a person, so the agent is unavailable. Reloading the page may help; the rest of the site is open as usual.';
      break;
  }
  return (
    <div className="agent-notice" role="status" ref={noticeRef} tabIndex={-1}>
      <p>{message}</p>
      <WorkRoutes />
    </div>
  );
}

function Reply({ message }: { message: AgentUIMessage }) {
  const text = textOf(message);
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '');
  return (
    <Message className="text-[17px]">
      <MessageContent className="agent-reply gap-3">
        {message.metadata?.status === 'unanswered' ? (
          <>
            <p>The agent couldn’t answer that one. Try asking another way, or go straight to the pages.</p>
            <WorkRoutes />
          </>
        ) : (
          paragraphs.map((paragraph, index) => (
            <p key={index} className="whitespace-pre-line">
              {paragraph}
            </p>
          ))
        )}
        <AgentSources sources={sourcesOf(message)} />
      </MessageContent>
    </Message>
  );
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduce(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduce;
}

export default function AgentChat() {
  const [view, setView] = React.useState<View>({ kind: 'loading' });
  const [messages, setMessages] = React.useState<AgentUIMessage[]>([]);
  const [draft, setDraft] = React.useState('');
  const nextId = React.useRef(0);
  const formRef = React.useRef<HTMLFormElement>(null);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const noticeRef = React.useRef<HTMLDivElement>(null);
  const focusAfterUpdate = React.useRef<'field' | 'notice' | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    let cancelled = false;
    checkHealth().then((health) => {
      if (cancelled) return;
      setView(health.kind === 'online' ? { kind: 'online' } : health);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const target = focusAfterUpdate.current;
    focusAfterUpdate.current = null;
    if (target === 'field') fieldRef.current?.focus();
    if (target === 'notice') noticeRef.current?.focus();
  }, [view]);

  const busy = view.kind === 'answering';
  const stopped = isStopped(view);
  const canSend = !busy && !stopped && view.kind !== 'loading' && draft.trim() !== '';
  const id = (prefix: string) => `${prefix}-${(nextId.current += 1)}`;

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy || stopped || view.kind === 'loading') return;
    const asked = userMessage(id('q'), question);
    setMessages((current) => [...current, asked]);
    setDraft('');
    setView({ kind: 'answering' });

    // Turnstile integration point: a no-op until the widget is wired (see ./turnstile.ts).
    await ensureHumanClearance();
    const outcome = await askQuestion(question);

    // Move focus only if the visitor left it in the form (or the disabled send button dropped it to
    // the body). An answer can take a while; if they have moved on, leave their focus alone.
    const active = document.activeElement;
    const focusIsOurs = !active || active === document.body || Boolean(formRef.current?.contains(active));
    const withdraw = () => {
      // The question was not answered: take it out of the log and put it back in the field, unless the
      // visitor has started typing something else meanwhile.
      setMessages((current) => current.filter((message) => message.id !== asked.id));
      setDraft((current) => (current.trim() === '' ? text : current));
    };
    switch (outcome.type) {
      case 'reply':
        setMessages((current) => [...current, replyToMessage(id('a'), outcome.body)]);
        if (focusIsOurs) focusAfterUpdate.current = 'field';
        setView({ kind: 'online' });
        break;
      case 'state':
        if (focusIsOurs) focusAfterUpdate.current = 'notice';
        setView(outcome.state);
        break;
      case 'too-long':
        withdraw();
        if (focusIsOurs) focusAfterUpdate.current = 'field';
        setView({ kind: 'too-long', maxChars: outcome.maxChars });
        break;
      default:
        withdraw();
        if (focusIsOurs) focusAfterUpdate.current = 'field';
        setView({ kind: 'error' });
    }
  }

  function onSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft);
  }

  if (view.kind === 'absent') return null;

  const alertId = 'agent-alert';
  const alert =
    view.kind === 'error' ? (
      <div className="agent-notice" role="alert" id={alertId}>
        <p>Something went wrong on the agent’s side, and there’s no answer to show. Your question is back in the field if you’d like to send it again.</p>
        <WorkRoutes />
      </div>
    ) : view.kind === 'too-long' ? (
      <div className="agent-notice" role="alert" id={alertId}>
        <p>
          That question is longer than the agent accepts
          {view.maxChars ? ` (${view.maxChars.toLocaleString('en-US')} characters)` : ''}. Shorten it and send it again.
        </p>
      </div>
    ) : null;

  return (
    <section className="agent-ui agent-island" data-agent-island data-state={view.kind} aria-labelledby="agent-title">
      <header className="agent-header">
        <div className="agent-header-row">
          <h2 id="agent-title">Ask about my work</h2>
          <a href="/how-this-works/" className="standalone-link agent-how">
            How it works →
          </a>
        </div>
        <p className="agent-lede">An agent that answers only from what’s published on this site, and cites the pages it used.</p>
      </header>

      {messages.length > 0 && (
        <MessageScrollerProvider autoScroll>
          <div className="agent-thread">
            {/* Grows with the conversation up to a cap, then scrolls; no empty box under a short answer. */}
            <MessageScroller className="h-auto w-full">
              <MessageScrollerViewport className="h-auto max-h-[min(30rem,62vh)] w-full">
                <MessageScrollerContent role="log" aria-label="Conversation" aria-busy={busy} className="gap-6 py-2">
                  {messages.map((message) =>
                    message.role === 'user' ? (
                      <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor>
                        <Message align="end" className="text-base">
                          <MessageContent>
                            <Bubble align="end" variant="muted">
                              <BubbleContent className="text-base">{textOf(message)}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ) : (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
                        <Reply message={message} />
                      </MessageScrollerItem>
                    ),
                  )}
                  {busy && (
                    <MessageScrollerItem messageId="answering">
                      <Trace>
                        <TraceLine status="running">
                          <TraceIcon>
                            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                          </TraceIcon>
                          <TraceTitle>Searching the site…</TraceTitle>
                        </TraceLine>
                      </Trace>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton className="size-11" behavior={reduceMotion ? 'auto' : 'smooth'} />
            </MessageScroller>
          </div>
        </MessageScrollerProvider>
      )}

      {stopped ? (
        <StoppedNotice view={view} noticeRef={noticeRef} />
      ) : (
        <>
          {view.kind === 'loading' && (
            <p className="agent-status" role="status">
              Checking whether the agent is available…
            </p>
          )}
          {/* Rendered (disabled) while loading too, so the server-rendered shell reserves their space. */}
          {messages.length === 0 && (
            <ul className="agent-suggestions" aria-label="Suggested questions">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button type="button" className="agent-suggestion" disabled={busy || view.kind === 'loading'} onClick={() => void send(suggestion)}>
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {alert}
          <form ref={formRef} onSubmit={onSubmit} className="agent-form">
            {/* Turnstile integration point: the pre-clearance widget renders here (./turnstile.ts). */}
            <div data-turnstile-slot hidden />
            <InputGroup className="agent-field">
              <InputGroupTextarea
                ref={fieldRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (view.kind === 'too-long' || view.kind === 'error') setView({ kind: 'online' });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
                placeholder="Ask about a project, an essay or my experience"
                aria-label="Ask about my work"
                aria-invalid={view.kind === 'too-long' || undefined}
                aria-describedby={alert ? alertId : undefined}
                disabled={view.kind === 'loading'}
                rows={2}
                className="max-h-48 min-h-14 overflow-y-auto px-3 text-base md:text-base"
              />
              <InputGroupAddon align="block-end">
                <span className="agent-hint">Enter to send · Shift+Enter for a new line</span>
                <InputGroupButton type="submit" variant="default" size="icon-sm" disabled={!canSend} aria-label="Send" className="ml-auto size-11">
                  <ArrowUpIcon />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </>
      )}
    </section>
  );
}
