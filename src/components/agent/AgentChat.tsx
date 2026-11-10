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
import { TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { askQuestion, checkHealth } from '@/lib/agent/client';
import { linkClass } from '@/lib/site-ui';
import type { StoppedState } from '@/lib/agent/contract';
import { replyToMessage, sourcesOf, textOf, userMessage, type AgentUIMessage } from '@/lib/agent/messages';
import { AgentSources } from './AgentSources';
import { cancelHumanClearance, ensureHumanClearance } from './turnstile';

// The Worker's MAX_PROMPT_CHARS (wrangler.jsonc). If that changes, change this; a 413 from the Worker is the backstop.
const MAX_QUESTION_CHARS = 1000;
// Show the count only when the visitor is getting close, so a short question carries no counter.
const COUNT_FROM = 800;
import './agent-chat.css';

/** What the island shows. `data-state` on the root carries `kind`, for styling and tests. */
type View =
  | { kind: 'loading' }
  | { kind: 'online' }
  | { kind: 'answering' }
  /** The last question got no answer (502 or a malformed reply); the visitor may send it again. */
  | { kind: 'error' }
  | { kind: 'too-long'; maxChars?: number }
  /** Cloudflare's per-IP rate limit answered instead of the agent; the question is back in the field. */
  | { kind: 'throttled'; retryAfterSeconds?: number }
  /** This host has no agent (a static host, or a response outside the contract): render nothing. */
  | { kind: 'absent' }
  | StoppedState;

const SUGGESTIONS = [
  'What is Team Brain, and why did Mitch build it?',
  'Why should the agent harness not live on a laptop?',
  'How were coding agents run in cloud sandboxes, and how were credentials kept out of them?',
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
      <a href="/work/" data-slot="button" data-site="link" className={linkClass}>
        Browse the work →
      </a>
      <a href="/writing/" data-slot="button" data-site="link" className={linkClass}>
        Read the writing →
      </a>
    </p>
  );
}

function StoppedNotice({ view, noticeRef }: { view: StoppedState; noticeRef: React.Ref<HTMLDivElement> }) {
  let message: React.ReactNode;
  switch (view.kind) {
    case 'offline':
      message = 'The agent is switched off right now. Everything it answers from is published on this site.';
      break;
    case 'paused':
      message = (
        <>
          The agent has used its daily budget and is paused
          {view.until ? <Until until={view.until} /> : ' until the budget resets'}. Everything it answers from is
          published on this site.
        </>
      );
      break;
    case 'blocked':
      message = (
        <>
          The agent is unavailable from this connection
          <Until until={view.until} />. The rest of the site works as usual.
        </>
      );
      break;
    case 'limit':
      message = 'This conversation has reached its message limit. The pages the agent answers from are all here.';
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

/** The visitor-facing wording for an unanswered reply; `reason` is the Worker's, for operators. */
function unansweredText(reason: string | undefined) {
  return reason === 'turn_limit'
    ? 'That question needed more steps than the agent takes for one answer. Try a narrower question, or go straight to the pages.'
    : 'The agent couldn’t answer that one. Try asking another way, or go straight to the pages.';
}

function Reply({ message }: { message: AgentUIMessage }) {
  const text = textOf(message);
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '');
  const metadata = message.metadata;
  return (
    <Message className="text-[17px]">
      <MessageContent className="agent-reply gap-3">
        {metadata?.status === 'unanswered' ? (
          <div className="agent-notice" data-reply="unanswered">
            <p>{unansweredText(metadata.reason)}</p>
            <WorkRoutes />
          </div>
        ) : metadata?.status === 'refused' ? (
          // The Worker's fixed wording, shown as a notice rather than as an answer: it has no sources and
          // is not the agent's reading of the pages.
          <div className="agent-notice" data-reply="refused" data-refusal={metadata.refusal}>
            <p>{text}</p>
            <WorkRoutes />
          </div>
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

/** What the wait says as it gets longer. Answers are not streamed, so there is no progress to report. */
const WAIT_NOTES = [
  { from: 0, title: 'Searching the site and reading what it finds', note: 'Answers usually take 10 to 30 seconds.' },
  { from: 35, title: 'Still working', note: 'Longer questions can take a minute or more.' },
  { from: 80, title: 'Still working, and slower than usual', note: 'If there is no answer after two minutes, your question comes back to the field.' },
] as const;

function waitPhrase(seconds: number | undefined) {
  if (!seconds) return 'a few seconds';
  if (seconds < 60) return `about ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The indicator for an answer in flight. The words change only at the thresholds above and sit in a polite
 * live region, so a screen reader hears each phase once; the running seconds are for sighted visitors.
 */
function Waiting({ confirming }: { confirming: boolean }) {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const phase = WAIT_NOTES.reduce((current, candidate) => (seconds >= candidate.from ? candidate : current), WAIT_NOTES[0]);
  return (
    <div className="agent-waiting">
      <div role="status" className="agent-waiting-text">
        <TraceLine status="running">
          <TraceIcon>
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
          </TraceIcon>
          <TraceTitle>{confirming ? 'Confirming you’re a person' : phase.title}…</TraceTitle>
        </TraceLine>
        {!confirming && <p className="agent-wait-note">{phase.note}</p>}
      </div>
      <span className="agent-elapsed" aria-hidden="true">
        {formatElapsed(seconds)}
      </span>
    </div>
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

/** `idle`, `running` (Cloudflare is checking quietly) or `interactive` (it needs the visitor to act). */
type Challenge = 'idle' | 'running' | 'interactive';

/**
 * `enabled` says whether the Worker's agent is switched on (src/lib/agent/enabled.ts, read at build time).
 * When it isn't, the island starts in the switched-off state and makes no request and runs no human check, so
 * a visitor sees the notice at once instead of the edge's challenge for a feature that is off.
 */
export default function AgentChat({ enabled = true, turnstileSiteKey = '' }: { enabled?: boolean; turnstileSiteKey?: string }) {
  const [view, setView] = React.useState<View>(enabled ? { kind: 'loading' } : { kind: 'offline' });
  const [challenge, setChallenge] = React.useState<Challenge>('idle');
  const turnstileHost = React.useRef<HTMLDivElement>(null);
  const verifyRef = React.useRef<HTMLDivElement>(null);
  const focusWasInVerify = React.useRef(false);
  /** Which ask is in flight, so the wait indicator starts again for the retry after a clearance. */
  const [attempt, setAttempt] = React.useState(0);
  const [messages, setMessages] = React.useState<AgentUIMessage[]>([]);
  const [draft, setDraft] = React.useState('');
  const nextId = React.useRef(0);
  const formRef = React.useRef<HTMLFormElement>(null);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const noticeRef = React.useRef<HTMLDivElement>(null);
  const focusAfterUpdate = React.useRef<'field' | 'notice' | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  /**
   * Runs Turnstile pre-clearance and says whether the visitor now holds a clearance cookie. With no site key
   * configured there is nothing to run, and the edge challenge shows as the "unverified" notice.
   */
  const clearHumanCheck = React.useCallback(async () => {
    const host = turnstileHost.current;
    if (!turnstileSiteKey || !host) return false;
    setChallenge('running');
    const result = await ensureHumanClearance({
      siteKey: turnstileSiteKey,
      host,
      onInteractive: (interactive) => setChallenge(interactive ? 'interactive' : 'running'),
    });
    setChallenge('idle');
    // The check's own frame is gone, so a visitor who was in it would otherwise be left on the page body.
    if (focusWasInVerify.current) {
      focusWasInVerify.current = false;
      focusAfterUpdate.current = 'field';
    }
    return result === 'cleared';
  }, [turnstileSiteKey]);

  React.useEffect(() => {
    // Switched off at build time: nothing to ask and nobody to verify.
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      let health = await checkHealth();
      // /agent/* sits behind a Managed Challenge, so a first visit is challenged before it is answered.
      if (health.kind === 'unverified' && !cancelled && (await clearHumanCheck())) health = await checkHealth();
      if (!cancelled) setView(health.kind === 'online' ? { kind: 'online' } : health);
    })();
    const host = turnstileHost.current;
    return () => {
      cancelled = true;
      // The island is going away (a page change, or a development re-run): end its check so the next island's
      // starts clean instead of joining one whose widget nobody can see.
      cancelHumanClearance(host);
    };
  }, [clearHumanCheck, enabled]);

  // When Cloudflare needs the visitor, bring the check to them: a keyboard or screen reader user is otherwise
  // left on a disabled form with no sign that a control has appeared.
  React.useEffect(() => {
    if (challenge === 'interactive') verifyRef.current?.focus();
  }, [challenge]);

  React.useEffect(() => {
    const target = focusAfterUpdate.current;
    focusAfterUpdate.current = null;
    if (target === 'field') fieldRef.current?.focus();
    if (target === 'notice') noticeRef.current?.focus();
  }, [view]);

  const busy = view.kind === 'answering';
  const stopped = isStopped(view);
  const tooLong = draft.length > MAX_QUESTION_CHARS;
  const canSend = !busy && !stopped && view.kind !== 'loading' && draft.trim() !== '' && !tooLong;
  const id = (prefix: string) => `${prefix}-${(nextId.current += 1)}`;

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy || stopped || view.kind === 'loading') return;
    const asked = userMessage(id('q'), question);
    const focusWasOurs = Boolean(formRef.current?.contains(document.activeElement));
    setMessages((current) => [...current, asked]);
    setDraft('');
    setView({ kind: 'answering' });

    let outcome = await askQuestion(question);
    // Clearance lasts a while, not forever: if the edge challenges this question, clear the check and ask once
    // more, with the wait indicator starting over. Only once: a second challenge is shown as it is.
    if (outcome.type === 'state' && outcome.state.kind === 'unverified' && (await clearHumanCheck())) {
      setAttempt((current) => current + 1);
      outcome = await askQuestion(question);
    }

    // Move focus only if the visitor left it in the form, or it was in the form when they sent and the
    // send button, disabled while answering, dropped it to the body. An answer can take a while; if
    // they have moved on (or clicked elsewhere on the page), leave their focus alone.
    const active = document.activeElement;
    const focusIsOurs =
      Boolean(formRef.current?.contains(active)) || (focusWasOurs && (!active || active === document.body));
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
      case 'throttled':
        withdraw();
        if (focusIsOurs) focusAfterUpdate.current = 'field';
        setView({ kind: 'throttled', retryAfterSeconds: outcome.retryAfterSeconds });
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

  // The hero is two columns for the island; when the island removes itself the intro goes back to one.
  React.useEffect(() => {
    if (view.kind === 'absent') document.querySelector('.home-hero')?.setAttribute('data-island', 'absent');
  }, [view.kind]);

  if (view.kind === 'absent') return null;

  const alertId = 'agent-alert';
  const alert =
    view.kind === 'error' ? (
      <div className="agent-notice" role="alert" id={alertId}>
        <p>The agent hit an error and has no answer to show. Your question is back in the field if you want to send it again.</p>
        <WorkRoutes />
      </div>
    ) : view.kind === 'throttled' ? (
      <div className="agent-notice" role="alert" id={alertId}>
        <p>
          That was too many questions too quickly, so none was sent. Wait {waitPhrase(view.retryAfterSeconds)}, then send it
          again; it’s back in the field.
        </p>
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
          <a href="/how-this-works/" data-slot="button" data-site="link" className={`${linkClass} agent-how`}>
            How it works →
          </a>
        </div>
        <p className="agent-lede">Answers from the case studies, essays and résumé published on this site, and links the pages it used. If they don’t say, it tells you.</p>
      </header>

      {messages.length > 0 && (
        <MessageScrollerProvider autoScroll>
          <div className="agent-thread">
            {/* Grows with the conversation up to a cap, then scrolls; no empty box under a short answer. */}
            <MessageScroller className="h-auto w-full">
              <MessageScrollerViewport className="h-auto max-h-[min(30rem,62vh)] w-full">
                <MessageScrollerContent role="log" aria-label="Conversation" className="gap-6 py-2">
                  {messages.map((message) =>
                    message.role === 'user' ? (
                      <MessageScrollerItem key={message.id} messageId={message.id} className="agent-enter">
                        <Message align="end" className="text-base">
                          <MessageContent>
                            <Bubble align="end" variant="muted">
                              <BubbleContent className="text-base">{textOf(message)}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ) : (
                      <MessageScrollerItem key={message.id} messageId={message.id} className="agent-enter">
                        <Reply message={message} />
                      </MessageScrollerItem>
                    ),
                  )}
                  {busy && (
                    <MessageScrollerItem messageId="answering">
                      <Waiting key={attempt} confirming={challenge !== 'idle'} />
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
          {/* The loading message lives in the field's placeholder, so nothing shifts when it clears. */}
          <p className="sr-only" role="status" data-agent-announce>
            {view.kind === 'loading' ? 'Checking whether the agent is available…' : busy ? 'Waiting for the agent’s answer.' : ''}
          </p>
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
            {/* The Turnstile widget renders here (./turnstile.ts); it is invisible unless Cloudflare needs the visitor. */}
            <div
              ref={verifyRef}
              className="agent-verify"
              role="group"
              aria-label="Confirm you are a person"
              tabIndex={-1}
              data-active={challenge === 'interactive' || undefined}
              // Laid out but out of sight and out of the tab order until Cloudflare asks for the visitor (a
              // display:none container can stop the widget from running at all).
              inert={challenge !== 'interactive'}
              onFocus={() => (focusWasInVerify.current = true)}
              onBlur={() => (focusWasInVerify.current = false)}
            >
              <p>Cloudflare needs to confirm a person is asking before the agent answers.</p>
              <div data-turnstile-slot ref={turnstileHost} />
            </div>
            <InputGroup className="agent-field">
              <InputGroupTextarea
                ref={fieldRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (view.kind === 'too-long' || view.kind === 'error' || view.kind === 'throttled') setView({ kind: 'online' });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
                placeholder={view.kind === 'loading' ? (challenge === 'idle' ? 'Checking whether the agent is available…' : 'Confirming you’re a person…') : 'Ask about a project, an essay or my experience'}
                aria-label="Ask about my work"
                aria-invalid={view.kind === 'too-long' || tooLong || undefined}
                aria-describedby={[alert ? alertId : '', draft.length >= COUNT_FROM ? 'agent-count' : ''].filter(Boolean).join(' ') || undefined}
                disabled={view.kind === 'loading'}
                rows={2}
                className="max-h-48 min-h-14 overflow-y-auto px-3 text-base md:text-base"
              />
              <InputGroupAddon align="block-end">
                <span className="agent-hint">Enter to send · Shift+Enter for a new line</span>
                {draft.length >= COUNT_FROM && (
                  <span id="agent-count" className="agent-count" data-over={tooLong || undefined}>
                    {draft.length.toLocaleString('en-US')} / {MAX_QUESTION_CHARS.toLocaleString('en-US')}
                    {tooLong && <span className="sr-only"> Too long to send.</span>}
                  </span>
                )}
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
