# Cutover: GitHub Pages to Cloudflare Workers static assets

Milestone M1 of [#13](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/13), tracked in
[#15](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/15). The site moves from GitHub Pages to
Workers static assets on the same domain. No Worker code runs yet; `wrangler.jsonc` serves `dist/` only.

Checked against the Cloudflare and GitHub docs on 2026-11-05. Re-check the linked pages if this runs much later.

## What stays true throughout

- GitHub Pages keeps building and stays configured for `mitchellknoth.com` until the rollback window closes,
  so rollback is a DNS change, not a rebuild.
- Every deploy, to either host, comes from the same build that passed `npm run quality`.
- The zone's Universal SSL certificate (Let's Encrypt, active for `mitchellknoth.com` and `*.mitchellknoth.com`
  as of 2026-11-05) covers both hostnames, so moving them should not wait on a new certificate. Confirm it is
  still active under **SSL/TLS → Edge Certificates** before step 4. In the 2026-11-06 cutover, the apex Custom
  Domain also brought its own certificate (Google Trust Services, apex and `www`) within a minute or two.

## 1. One-time setup (Mitch)

These steps create credentials or change account settings, so Mitch does them.

1. **Rename the workers.dev subdomain** to `mitchellknoth`: **Workers & Pages → Change** (next to **Your subdomain**).
   This also changes the workers.dev and preview URLs of every other Worker in the account; check nothing
   depends on them first.
2. **Create the deploy token**: **My Profile → API Tokens → Create Token → Custom token**.
   - Permission: **Account → Workers Scripts → Edit**. Nothing else; no zone or DNS permissions.
   - Account resources: this account only.
   - Optional: a TTL, renewed deliberately.

   Workers Scripts permissions apply to every Worker in the account. Least privilege here keeps a leaked token
   away from DNS, Pages, R2, KV and other zones; it can't limit the token to one Worker.
3. **Create the GitHub environment** `cloudflare-workers`: **Settings → Environments → New environment**.
   - Deployment branches: **Selected branches → `main`** only.
   - Environment secret `CLOUDFLARE_API_TOKEN`: the token from step 2.
4. **Add repository variables**: **Settings → Secrets and variables → Actions → Variables**.
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID from the Cloudflare dashboard.
   - `CF_WORKERS_DEPLOY`: `true`. Until this is set, the `deploy-workers` job in `.github/workflows/deploy.yml`
     is skipped.

## 2. First deploy to workers.dev

1. Re-run **Deploy to GitHub Pages** on `main` (workflow_dispatch). The `deploy-workers` job deploys the
   Worker `mitchellknoth-com`, reachable at `https://mitchellknoth-com.mitchellknoth.workers.dev`.
2. Run the parity contract against it, from a checkout of the same commit. Compare against the exact build that
   was deployed: download the run's `site-dist` artifact into `dist/` instead of rebuilding. Run
   `npm run corpus` first; the local `wrangler dev` server Playwright starts imports `generated/corpus.json`
   even when the test targets a remote URL.

   ```bash
   gh run download <run-id> -n site-dist -D dist
   npm run corpus
   WORKERS_BASE_URL=https://mitchellknoth-com.mitchellknoth.workers.dev npx playwright test workers-parity --project desktop
   ```

3. Spot-check in a headed browser: home, one project, one essay, the résumé PDF, a 404, both themes.

Go on only if every parity check passes.

## 3. Rehearse on `www`

`www` carries no canonical URLs (every page's canonical link and the sitemap use the apex), so it's the safe
place to rehearse the DNS change.

1. Delete the `www` CNAME record (`mitchellknoth.github.io`). A Custom Domain can't be created over an
   existing CNAME.
2. **Workers & Pages → mitchellknoth-com → Domains → Add Domain → mitchellknoth.com**, subdomain `www`.
   Cloudflare creates a proxied `AAAA www → 100::` record that it manages for the Worker. Before adding, read
   the subdomain field's value back: a field that looked empty in a screenshot once held a typed value, and the
   domain was created as `wwwwww`. Leaving the field empty attaches the apex.
3. Run the parity contract with `WORKERS_BASE_URL=https://www.mitchellknoth.com`.
4. Rehearse rollback: remove the `www` Custom Domain, recreate the CNAME (step 6), and confirm
   `https://www.mitchellknoth.com` redirects to the apex again through GitHub Pages. Then redo steps 1–3.
   The local resolver may keep the rollback CNAME for up to its TTL (5 minutes); test with
   `curl --noproxy '*'` and wait for `server: cloudflare` before re-running parity.

## 4. Move the apex

The dashboard refuses the apex Custom Domain while the GitHub `A` records exist ("already has externally managed
DNS records"), so delete them first and add the Custom Domain within seconds:

1. Open **Add Domain** for `mitchellknoth.com` on the Worker with the subdomain empty, but don't submit yet.
2. In a second tab, select the four apex `A` records (GitHub Pages IPs, listed in step 6) and bulk-delete them.
3. Submit the Custom Domain. Cloudflare creates a proxied `AAAA @ → 100::` record and issues an edge certificate
   for the apex and `www` within a minute or two. Expect up to the old record TTL (5 minutes) of mixed answers.
4. Run the parity contract with `WORKERS_BASE_URL=https://mitchellknoth.com`, then the headed spot-check.
   A corporate TLS-inspecting proxy may reject the first requests with a certificate error while the new
   certificate propagates; check it directly with `openssl s_client -servername mitchellknoth.com`.

## 5. Point `www` back at the apex

Serve `www` as a redirect, not a second copy of the site:

1. **Rules → Redirect Rules → Create rule** (Single Redirect, wildcard pattern), status 301, **Preserve query
   string** on. Wildcard patterns need an explicit scheme, so add one rule per scheme:
   - `https://www.mitchellknoth.com/*` → `https://mitchellknoth.com/${1}`
   - `http://www.mitchellknoth.com/*` → `https://mitchellknoth.com/${1}`

   Redirect rules run before the Worker, so `www` redirects as soon as they deploy.
2. Prepare **Add record**: `AAAA`, name `www`, `100::` (Cloudflare's reserved originless placeholder), proxied.
3. Remove the `www` Custom Domain from the Worker (this deletes its managed `AAAA` record), then save the
   prepared record straight away.
4. Confirm, with `curl --noproxy '*'`:
   - `https://www.mitchellknoth.com/about/` and `http://www.mitchellknoth.com/about/` return 301 to
     `https://mitchellknoth.com/about/`
   - `https://www.mitchellknoth.com/writing/?a=1` keeps `?a=1`

`http://mitchellknoth.com` is served over plain HTTP until **SSL/TLS → Edge Certificates → Always Use HTTPS** is
on. GitHub Pages enforced HTTPS, so turn it on to match.

## 6. Rollback

GitHub Pages is still built and configured, so rollback is DNS only:

1. Remove the Custom Domain(s) from the Worker. This deletes the `AAAA` records the Worker manages.
2. Delete the `www` placeholder record and both redirect rules from step 5.
3. Recreate the GitHub Pages records, all DNS-only:
   - `A` `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` `www` → `mitchellknoth.github.io`
4. Confirm `https://mitchellknoth.com` returns `server: GitHub.com` and `www` redirects to the apex.

Keep the rollback window short (about two weeks). GitHub Pages can only renew its HTTPS certificate while DNS
points at GitHub.

## 7. After the window

1. Remove the GitHub Pages deploy job from `.github/workflows/deploy.yml`, and unpublish Pages in the repository
   settings.
2. Keep the `_github-pages-challenge-mitchellknoth` TXT record. It's harmless and keeps the domain verified on
   GitHub.
3. Record the cutover date and the parity results on #15.

## Known differences from GitHub Pages

- Trailing-slash redirects are `307` on Workers (`html_handling: auto-trailing-slash`) and `301` on GitHub
  Pages. Canonical links and the sitemap already use the trailing-slash URLs.
- `/about/index.html` redirects to `/about/` on Workers; GitHub Pages serves it directly.
- Default caching differs: Workers sends `Cache-Control: public, max-age=0, must-revalidate` with an ETag;
  GitHub Pages sends `max-age=600`. A `_headers` file can make hashed `/_astro/*` assets immutable later.

## Sources

- [Astro on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/)
- [HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/) and
  [default headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), including
  www-to-apex redirects
- [workers.dev subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
