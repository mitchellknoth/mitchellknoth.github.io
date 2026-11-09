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
    const element = document.createElement('script');
    const finish = (api: TurnstileApi | null) => {
      window.clearTimeout(timer);
      // A failed load is not cached: a later question may try again (for instance after the network returns).
      if (!api) {
        element.remove();
        script = null;
      }
      resolve(api);
    };
    const timer = window.setTimeout(() => finish(null), SCRIPT_TIMEOUT_MS);
    element.src = SCRIPT_URL;
    element.async = true;
    element.onload = () => finish(window.turnstile ?? null);
    element.onerror = () => finish(null);
    document.head.append(element);
  });
  return script;
}

let solving: Promise<Clearance> | null = null;

/**
 * Runs the pre-clearance widget inside `host` and resolves when it finishes. `onInteractive` is told when
 * Cloudflare needs the visitor to act (so the island can make room for the widget) and when that is over.
 * Concurrent calls share one run.
 */
export function ensureHumanClearance(options: {
  siteKey: string;
  host: HTMLElement;
  onInteractive?: (interactive: boolean) => void;
}): Promise<Clearance> {
  solving ??= run(options).finally(() => {
    solving = null;
  });
  return solving;
}

async function run({ siteKey, host, onInteractive }: Parameters<typeof ensureHumanClearance>[0]): Promise<Clearance> {
  const api = await loadScript();
  if (!api) return 'failed';
  return new Promise<Clearance>((resolve) => {
    let widget: string | undefined;
    const finish = (result: Clearance) => {
      window.clearTimeout(timer);
      onInteractive?.(false);
      if (widget !== undefined) api.remove(widget);
      host.replaceChildren();
      resolve(result);
    };
    const timer = window.setTimeout(() => finish('failed'), SOLVE_TIMEOUT_MS);
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
      finish('failed');
    }
  });
}
