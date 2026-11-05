import { expect, test, type Page, type Route } from '@playwright/test';

// The homepage agent island (#18). Every /agent/* response is mocked with route interception, so
// these tests exercise each state of the HTTP contract (epic-13 plan note) without a Worker.

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Mock = { health?: Reply; session?: Reply; ask?: Reply | Reply[] };

const ONLINE: Reply = { status: 200, body: { state: 'online' } };
const ANSWER: Reply = {
  status: 200,
  body: {
    status: 'answered',
    text: 'Team Brain is a shared repository where research and decisions are written down once.\n\nAny engineer or agent tool can search it.',
    sources: [
      { id: 'project/team-brain#the-problem', title: 'Team Brain: the problem', url: '/work/team-brain/#the-problem' },
      { id: 'project/team-brain', title: 'Team Brain', url: '/work/team-brain/' },
    ],
  },
};
const UNTIL = '2026-11-06T00:00:00.000Z';
// Match the agent API by path. A glob such as `**/agent/**` also matches the island's own modules
// (/src/components/agent/…) on the dev server.
const AGENT_API = (url: URL) => url.pathname.startsWith('/agent/');
const ASK_API = (url: URL) => url.pathname === '/agent/ask';

/** Requests the island made, in order, as `METHOD path`. */
async function mockAgent(page: Page, mock: Mock): Promise<string[]> {
  const calls: string[] = [];
  const asks = Array.isArray(mock.ask) ? [...mock.ask] : mock.ask ? [mock.ask] : [];
  const fulfil = (route: Route, reply: Reply) =>
    route.fulfill({
      status: reply.status,
      headers: { 'content-type': typeof reply.body === 'string' ? 'text/html' : 'application/json', ...reply.headers },
      body: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
    });
  await page.route(AGENT_API, async (route) => {
    const url = new URL(route.request().url());
    calls.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname === '/agent/health') return fulfil(route, mock.health ?? ONLINE);
    if (url.pathname === '/agent/session') return fulfil(route, mock.session ?? { status: 201, body: { state: 'online' } });
    if (url.pathname === '/agent/ask') {
      const reply = asks.length > 1 ? asks.shift()! : asks[0];
      return fulfil(route, reply ?? ANSWER);
    }
    return route.fulfill({ status: 404, body: '' });
  });
  return calls;
}

/**
 * Page errors and console errors, so a hydration mismatch or React warning fails the test. The browser
 * logs every non-2xx response as "Failed to load resource"; those are the mocked refusals themselves.
 */
const pageErrors = new WeakMap<Page, string[]>();
function watchErrors(page: Page) {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`console: ${message.text()}`);
  });
  return errors;
}
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'the island must not log errors').toEqual([]);
});

async function open(page: Page, theme: string, mock: Mock) {
  watchErrors(page);
  await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
  const calls = await mockAgent(page, mock);
  await page.goto('/');
  await page.addStyleTag({ content: 'astro-dev-toolbar { display: none !important; }' });
  return calls;
}

const island = (page: Page) => page.locator('[data-agent-island]');

async function ask(page: Page, question = 'What is Team Brain?') {
  const field = island(page).getByRole('textbox', { name: 'Ask about my work' });
  await field.fill(question);
  await field.press('Enter');
}

/** Geometry the Visual Quality Harness requires of the island at every viewport. */
async function expectSoundLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const root = document.querySelector('[data-agent-island]')!;
    const box = root.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    return {
      overflow: document.documentElement.scrollWidth - viewport,
      escaped: box.left < -1 || box.right > viewport + 1,
      smallTargets: [...root.querySelectorAll<HTMLElement>('button, a, textarea')]
        // Hidden, inert controls (the scroll-to-end button while the thread is at its end) are not targets.
        .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).pointerEvents !== 'none')
        .filter((element) => {
          const target = element.getBoundingClientRect();
          return target.width < 44 || target.height < 44;
        })
        .map((element) => element.getAttribute('aria-label') ?? element.textContent?.trim()),
      undersizedHeadings: [...root.querySelectorAll<HTMLElement>('h2, h3')]
        .filter((heading) => parseFloat(getComputedStyle(heading).fontSize) < 20)
        .map((heading) => heading.textContent),
    };
  });
  expect(layout.overflow, 'page must not scroll horizontally').toBeLessThanOrEqual(0);
  expect(layout.escaped, 'island must stay inside the viewport').toBe(false);
  expect(layout.smallTargets, 'standalone controls need 44px targets').toEqual([]);
  expect(layout.undersizedHeadings, 'island headings must read as headings').toEqual([]);
}

/** Every stopped state points the visitor at the work instead of a dead end. */
async function expectRoutesToWork(page: Page) {
  await expect(island(page).getByRole('link', { name: 'Browse the work' })).toHaveAttribute('href', '/work/');
  await expect(island(page).getByRole('link', { name: 'Read the writing' })).toHaveAttribute('href', '/writing/');
}

for (const theme of ['dark', 'light']) {
  test.describe(`${theme} theme`, () => {
    test('loads, goes online and answers with its sources', async ({ page }) => {
      const calls = await open(page, theme, { health: ONLINE, ask: [{ status: 401, body: { error: 'no_session' } }, ANSWER] });
      await expect(island(page)).toHaveAttribute('data-state', 'online');
      await expect(island(page).getByRole('heading', { name: 'Ask about my work' })).toBeVisible();
      await expectSoundLayout(page);
      const columns = await page.locator('.home-hero').evaluate((hero) => getComputedStyle(hero).gridTemplateColumns.split(' ').length);
      expect(columns, 'from 1024px the intro and the island sit side by side').toBe(page.viewportSize()!.width >= 1024 ? 2 : 1);

      await ask(page);
      await expect(island(page)).toHaveAttribute('data-state', 'online');
      const log = island(page).getByRole('log', { name: 'Conversation' });
      await expect(log.getByText('What is Team Brain?')).toBeVisible();
      await expect(log.getByText('Any engineer or agent tool can search it.')).toBeVisible();
      // A missing session cookie is recovered by starting a session and asking once more.
      expect(calls).toEqual(['GET /agent/health', 'POST /agent/ask', 'POST /agent/session', 'POST /agent/ask']);

      const sources = log.getByRole('button', { name: 'Used 2 sources' });
      await expect(sources).toBeVisible();
      await sources.click();
      await expect(log.getByRole('link', { name: 'Team Brain: the problem' })).toHaveAttribute('href', '/work/team-brain/#the-problem');
      await expect(log.getByRole('link', { name: 'Team Brain', exact: true })).toHaveAttribute('href', '/work/team-brain/');
      await expectSoundLayout(page);
    });

    test('shows that it is answering while the request is in flight', async ({ page }) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await open(page, theme, { health: ONLINE });
      await page.route(ASK_API, async (route) => {
        await held;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANSWER.body) });
      });
      await expect(island(page)).toHaveAttribute('data-state', 'online');
      await ask(page);
      await expect(island(page)).toHaveAttribute('data-state', 'answering');
      await expect(island(page).getByText('Searching the site')).toBeVisible();
      await expect(island(page).getByRole('button', { name: 'Send' })).toBeDisabled();
      await expectSoundLayout(page);
      release();
      await expect(island(page)).toHaveAttribute('data-state', 'online');
    });

    test('shows a refusal and an unanswered reply in its own words', async ({ page }) => {
      await open(page, theme, {
        ask: [
          { status: 200, body: { status: 'refused', refusal: 'personal', text: 'I only answer from published work, not personal details.' } },
          { status: 200, body: { status: 'unanswered', reason: 'model_error' } },
        ],
      });
      await ask(page, 'What is his home address?');
      const log = island(page).getByRole('log', { name: 'Conversation' });
      await expect(log.getByText('I only answer from published work, not personal details.')).toBeVisible();
      await ask(page, 'And another?');
      await expect(log.getByText('The agent couldn’t answer that one.')).toBeVisible();
      await expect(island(page)).toHaveAttribute('data-state', 'online');
      await expectSoundLayout(page);
    });

    const stopped: Array<{ name: string; mock: Mock; state: string; text: RegExp }> = [
      { name: 'offline from the health check', mock: { health: { status: 503, body: { state: 'offline' } } }, state: 'offline', text: /switched off/ },
      { name: 'paused from the health check', mock: { health: { status: 200, body: { state: 'paused' } } }, state: 'paused', text: /budget/ },
      { name: 'paused with a resume time', mock: { ask: { status: 503, body: { state: 'paused', until: UNTIL } } }, state: 'paused', text: /budget[\s\S]*until/ },
      { name: 'offline after asking', mock: { ask: { status: 503, body: { state: 'offline' } } }, state: 'offline', text: /switched off/ },
      { name: 'blocked', mock: { ask: { status: 403, body: { state: 'blocked', until: UNTIL } } }, state: 'blocked', text: /can’t use the agent/ },
      { name: 'session limit', mock: { ask: { status: 429, body: { state: 'limit', reason: 'session_message_limit' } } }, state: 'limit', text: /message limit/ },
      {
        name: 'not verified as human',
        mock: { ask: { status: 403, body: '<!doctype html><title>Just a moment…</title>', headers: { 'cf-mitigated': 'challenge' } } },
        state: 'unverified',
        text: /confirm/,
      },
    ];

    for (const { name, mock, state, text } of stopped) {
      test(`stops cleanly when ${name}`, async ({ page }) => {
        await open(page, theme, mock);
        if (mock.ask) {
          await expect(island(page)).toHaveAttribute('data-state', 'online');
          await ask(page);
        }
        await expect(island(page)).toHaveAttribute('data-state', state);
        await expect(island(page).getByRole('status')).toContainText(text);
        await expect(island(page).getByRole('textbox')).toHaveCount(0);
        await expectRoutesToWork(page);
        await expectSoundLayout(page);
      });
    }

    for (const [name, reply] of [
      ['answers /agent/health with its 404 page', { status: 404, body: '<!doctype html><title>404</title>' }],
      ['answers outside the contract', { status: 200, body: { state: 'something-new' } }],
    ] as const) {
      test(`removes itself when the host ${name}`, async ({ page }) => {
        // GitHub Pages, which hosts the site until the Workers cutover, has no /agent/ routes at all.
        await open(page, theme, { health: reply });
        await expect(island(page)).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Explore my work' })).toBeVisible();
        const columns = await page.locator('.home-hero').evaluate((hero) => getComputedStyle(hero).gridTemplateColumns.split(' ').length);
        expect(columns, 'with no island the hero is one column, not an empty second one').toBe(1);
      });
    }

    test('names the resume time when the budget is spent', async ({ page }) => {
      await open(page, theme, { ask: { status: 503, body: { state: 'paused', until: UNTIL } } });
      await ask(page);
      const time = island(page).getByRole('status').locator('time');
      await expect(time).toHaveAttribute('datetime', UNTIL);
      await expect(time).not.toBeEmpty();
    });

    test('keeps the conversation open after a server error', async ({ page }) => {
      await open(page, theme, { ask: [{ status: 502, body: { state: 'error' } }, ANSWER] });
      await ask(page);
      await expect(island(page)).toHaveAttribute('data-state', 'error');
      await expect(island(page).getByRole('alert')).toContainText('no answer to show');
      await expectRoutesToWork(page);
      await expectSoundLayout(page);
      await ask(page);
      await expect(island(page)).toHaveAttribute('data-state', 'online');
      await expect(island(page).getByRole('alert')).toHaveCount(0);
    });

    test('keeps the draft when the question is too long', async ({ page }) => {
      await open(page, theme, { ask: { status: 413, body: { error: 'question_too_long', maxChars: 1000 } } });
      const question = 'Tell me everything. '.repeat(60);
      await ask(page, question);
      await expect(island(page)).toHaveAttribute('data-state', 'too-long');
      await expect(island(page).getByRole('alert')).toContainText('1,000 characters');
      const field = island(page).getByRole('textbox', { name: 'Ask about my work' });
      await expect(field).toHaveValue(question);
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expectSoundLayout(page);
    });
  });
}

/** The site focus treatment (DESIGN.md): a solid 2px outline in the accent colour, offset 3px. */
async function expectSiteFocus(locator: ReturnType<Page['locator']>) {
  const style = await locator.evaluate((element) => {
    const css = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    element.closest('[data-agent-island]')!.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { style: css.outlineStyle, width: css.outlineWidth, offset: css.outlineOffset, color: css.outlineColor, accent };
  });
  expect(style.style).toBe('solid');
  expect(style.width).toBe('2px');
  expect(style.offset).toBe('3px');
  expect(style.color).toBe(style.accent);
}

for (const theme of ['dark', 'light']) {
  test(`${theme} keyboard: suggestions, the field and send are reachable with visible focus`, async ({ page }) => {
    await open(page, theme, {});
    await expect(island(page)).toHaveAttribute('data-state', 'online');
    // From the island's "How it works" link, Tab reaches each suggestion, then the field.
    await island(page).getByRole('link', { name: 'How it works' }).focus();
    const suggestions = island(page).getByRole('list', { name: 'Suggested questions' }).getByRole('button');
    for (let index = 0; index < (await suggestions.count()); index += 1) {
      await page.keyboard.press('Tab');
      await expect(suggestions.nth(index)).toBeFocused();
      await expectSiteFocus(suggestions.nth(index));
    }
    await page.keyboard.press('Tab');
    const field = island(page).getByRole('textbox', { name: 'Ask about my work' });
    await expect(field).toBeFocused();
    await expectSiteFocus(island(page).locator('[data-slot="input-group"]'));
    await page.keyboard.type('What did Mitch build?');
    // Shift+Enter is a new line, not a send.
    await page.keyboard.press('Shift+Enter');
    await expect(field).toHaveValue('What did Mitch build?\n');
    await page.keyboard.press('Tab');
    const send = island(page).getByRole('button', { name: 'Send' });
    await expect(send).toBeFocused();
    await expectSiteFocus(send);
    await page.keyboard.press('Enter');
    await expect(island(page).getByRole('log', { name: 'Conversation' }).getByText('Any engineer or agent tool can search it.')).toBeVisible();
    // Focus returns to the field for the next question.
    await expect(field).toBeFocused();
  });
}

test('focus stays where the visitor put it while an answer is pending', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await open(page, 'dark', {});
  await page.route(ASK_API, async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANSWER.body) });
  });
  await ask(page);
  await expect(island(page)).toHaveAttribute('data-state', 'answering');
  const elsewhere = page.getByRole('link', { name: 'Explore my work' });
  await elsewhere.focus();
  release();
  await expect(island(page).getByText('Any engineer or agent tool can search it.')).toBeVisible();
  await expect(elsewhere).toBeFocused();
});

test('reduced motion: the answering indicator does not animate', async ({ browser, page: projectPage }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4321', viewport: projectPage.viewportSize(), reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const errors = watchErrors(page);
    await open(page, 'dark', {});
    await page.route(ASK_API, async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANSWER.body) });
    });
    await expect(island(page)).toHaveAttribute('data-state', 'online');
    await ask(page);
    const indicator = island(page).getByText('Searching the site');
    await expect(indicator).toBeVisible();
    expect(await indicator.evaluate((node) => getComputedStyle(node).animationName), 'shimmer').toBe('none');
    const spinner = island(page).locator('.animate-spin');
    await expect(spinner).toHaveCount(1);
    expect(await spinner.evaluate((node) => getComputedStyle(node).animationName), 'spinner').toBe('none');
    release();
    await expect(island(page)).toHaveAttribute('data-state', 'online');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('suggested questions send on activation', async ({ page }) => {
  await open(page, 'light', {});
  const suggestions = island(page).getByRole('list', { name: 'Suggested questions' }).getByRole('button');
  await expect(suggestions).not.toHaveCount(0);
  await suggestions.first().click();
  await expect(island(page).getByRole('log', { name: 'Conversation' }).getByText('Any engineer or agent tool can search it.')).toBeVisible();
});

test('without JavaScript the homepage is the static intro alone', async ({ browser, page: projectPage }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4321', viewport: projectPage.viewportSize(), javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Explore my work' })).toBeVisible();
    await expect(page.locator('[data-agent-island]')).toBeHidden();
    const columns = await page.locator('.home-hero').evaluate((hero) => getComputedStyle(hero).gridTemplateColumns.split(' ').length);
    expect(columns, 'the hidden island leaves no empty column').toBe(1);
  } finally {
    await context.close();
  }
});

test('the island is the only homepage script that talks to the agent, and only on the homepage', async ({ page }) => {
  const calls = await mockAgent(page, {});
  await page.goto('/about/');
  await page.waitForLoadState('networkidle');
  expect(calls, 'other pages never call the agent').toEqual([]);
  await page.goto('/');
  await expect(island(page)).toHaveAttribute('data-state', 'online');
  expect(calls).toEqual(['GET /agent/health']);
});

test('the production bundle hydrates and answers', async ({ page }) => {
  // The other island tests run against the dev server; this one runs the built site (astro preview),
  // so the minified bundle and client:idle hydration are exercised too.
  test.skip(test.info().project.name !== 'desktop', 'One viewport is enough to prove the production bundle.');
  const errors = watchErrors(page);
  await mockAgent(page, {});
  await page.goto('http://127.0.0.1:4322/');
  await expect(island(page)).toHaveAttribute('data-state', 'online');
  await ask(page);
  await expect(island(page).getByRole('log', { name: 'Conversation' }).getByText('Any engineer or agent tool can search it.')).toBeVisible();
  expect(errors).toEqual([]);
});
