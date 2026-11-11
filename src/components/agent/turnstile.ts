// Turnstile pre-clearance for the agent (#13 guardrails, #18).
//
// The edge enforces it: a WAF Managed Challenge covers /agent and /agent/*, and a Turnstile widget with
// pre-clearance, solved in the visitor's browser, sets the `cf_clearance` cookie that passes it. The Worker
// never calls Turnstile's verify endpoint and this code never sees a secret: the site key below is public.
//
// Cloudflare's script loads only when it is needed: when a request to /agent/* comes back challenged
// (`403` with `cf-mitigated: challenge`, see contract.ts). A visitor who already holds a clearance cookie,
// and every visitor on a host with no agent, never contacts challenges.cloudflare.com. The widget renders
// with `appearance: interaction-only`, so it is invisible unless Cloudflare needs the visitor to do something.
//
// Nothing here runs on page load. The island starts a check when the visitor sends their first question (the
// page's first paint is the agent, not a verification widget), and may fetch the script, without rendering
// anything, when they first focus the field (`prepareHumanCheck`).

/**
 * The public site key of the agent's Turnstile widget (Cloudflare dashboard → Turnstile). Site keys are public
 * by design, and only work on the hostnames the widget allows. If it is ever emptied, the island skips the
 * widget and an edge challenge shows the "unverified" notice instead. `PUBLIC_TURNSTILE_SITE_KEY` overrides it
 * for local runs and tests; Cloudflare publishes dummy keys for that
 * (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
 */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAF6Q_oxvuFdPjhpi';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_TIMEOUT_MS = 15_000;
// A visitor may need to tick a box, so the whole check is allowed a generous minute.
const SOLVE_TIMEOUT_MS = 60_000;

interface TurnstileOptions {
  sitekey: string;
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  appearance?: 'always' | 'execute' | 'interaction-only';
  size?: 'normal' | 'flexible' | 'compact';
  retry?: 'auto' | 'never';
  callback?: (token: string) => void;
  'error-callback'?: (code?: string) => boolean | void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
  'unsupported-callback'?: () => void;
  'before-interactive-callback'?: () => void;
  'after-interactive-callback'?: () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** `cleared`: the visitor now holds a clearance cookie. `failed`: they do not, and the island says so. */
export type Clearance = 'cleared' | 'failed';

let script: Promise<TurnstileApi | null> | null = null;

function loadScript(): Promise<TurnstileApi | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  script ??= new Promise<TurnstileApi | null>((resolve) => {
    // A script that was slow rather than dead may still arrive after a timeout. Wait on that same element on the
    // next try instead of adding a second one, which Cloudflare warns about.
    const element = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`) ?? document.createElement('script');
    const finish = (api: TurnstileApi | null) => {
      window.clearTimeout(timer);
      // A failed load is not cached: a later question may try again (for instance after the network returns).
      if (!api) script = null;
      resolve(api);
    };
    const timer = window.setTimeout(() => finish(null), SCRIPT_TIMEOUT_MS);
    element.addEventListener('load', () => finish(window.turnstile ?? null), { once: true });
    element.addEventListener(
      'error',
      () => {
        element.remove();
        finish(null);
      },
      { once: true },
    );
    if (!element.isConnected) {
      element.src = SCRIPT_URL;
      element.async = true;
      document.head.append(element);
    }
  });
  return script;
}

/** Loads Cloudflare's script ahead of a check without rendering anything, so no widget appears before it is needed. */
export function prepareHumanCheck() {
  void loadScript();
}

interface Run {
  host: HTMLElement;
  promise: Promise<Clearance>;
  /** Ends the run as `failed` and removes its widget. */
  cancel(): void;
}

let current: Run | null = null;

/**
 * Runs the pre-clearance widget inside `host` and resolves when it finishes. `onInteractive` is told when
 * Cloudflare needs the visitor to act (so the island can make room for the widget) and when that is over.
 * Calls for the same `host` share one run. A call for a different host means the earlier island is gone (the
 * site swaps pages with view transitions), so that run is cancelled rather than joined: its widget would be
 * in a detached node that nobody can see or click.
 */
export function ensureHumanClearance(options: {
  siteKey: string;
  host: HTMLElement;
  onInteractive?: (interactive: boolean) => void;
}): Promise<Clearance> {
  if (current?.host === options.host) return current.promise;
  current?.cancel();
  const run = start(options);
  current = run;
  void run.promise.then(() => {
    if (current === run) current = null;
  });
  return run.promise;
}

/** Stops a run in `host`, if any: for when the island that started it goes away. */
export function cancelHumanClearance(host: HTMLElement | null) {
  if (host && current?.host === host) current.cancel();
}

function start({ siteKey, host, onInteractive }: Parameters<typeof ensureHumanClearance>[0]): Run {
  let finish: (result: Clearance) => void = () => undefined;
  const promise = new Promise<Clearance>((resolve) => {
    let done = false;
    let widget: string | undefined;
    let api: TurnstileApi | null = null;
    const timer = window.setTimeout(() => finish('failed'), SOLVE_TIMEOUT_MS);
    // Safe to call from any callback, in any order, and more than once: only the first call counts.
    finish = (result) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      onInteractive?.(false);
      if (api && widget !== undefined) api.remove(widget);
      host.replaceChildren();
      resolve(result);
    };
    void loadScript().then((loaded) => {
      if (done) return;
      if (!loaded) return finish('failed');
      api = loaded;
      try {
        widget = api.render(host, {
          sitekey: siteKey,
          action: 'agent',
          theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
          appearance: 'interaction-only',
          // The normal widget is 300px wide, more than a 320px phone leaves inside the island.
          size: window.matchMedia('(max-width: 399px)').matches ? 'compact' : 'normal',
          retry: 'never',
          callback: () => finish('cleared'),
          'error-callback': () => {
            finish('failed');
            // Returning true tells Turnstile the error is handled, so it does not log its own.
            return true;
          },
          'timeout-callback': () => finish('failed'),
          'expired-callback': () => finish('failed'),
          'unsupported-callback': () => finish('failed'),
          'before-interactive-callback': () => onInteractive?.(true),
          'after-interactive-callback': () => onInteractive?.(false),
        });
      } catch {
        return finish('failed');
      }
      // render() returns undefined, and fires no callback, for a bad site key or a missing container.
      if (widget === undefined) return finish('failed');
      // A callback that fired inside render() ended the run before the widget id was known.
      if (done) api.remove(widget);
    });
  });
  return { host, promise, cancel: () => finish('failed') };
}
