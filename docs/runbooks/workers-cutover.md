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
  still active under **SSL/TLS → Edge Certificates** before step 4.

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
2. Run the parity contract against it, from a checkout of the same commit after `npm run build`:

   ```bash
   WORKERS_BASE_URL=https://mitchellknoth-com.mitchellknoth.workers.dev npx playwright test workers-parity --project desktop
   ```

3. Spot-check in a headed browser: home, one project, one essay, the résumé PDF, a 404, both themes.

Go on only if every parity check passes.

## 3. Rehearse on `www`

`www` carries no canonical URLs (every page's canonical link and the sitemap use the apex), so it's the safe
place to rehearse the DNS change.

1. Delete the `www` CNAME record (`mitchellknoth.github.io`). A Custom Domain can't be created over an
   existing CNAME.
2. **Workers & Pages → mitchellknoth-com → Settings → Domains & Routes → Add → Custom Domain**:
   `www.mitchellknoth.com`. Cloudflare creates the DNS record.
3. Run the parity contract with `WORKERS_BASE_URL=https://www.mitchellknoth.com`.
4. Rehearse rollback: remove the `www` Custom Domain, recreate the CNAME (step 6), and confirm
   `https://www.mitchellknoth.com` redirects to the apex again through GitHub Pages. Then redo steps 1–3.

## 4. Move the apex

1. Delete the four apex `A` records (GitHub Pages IPs, listed in step 6). The Cloudflare docs don't say
   whether existing `A` records block a Custom Domain; if the dashboard accepts the Custom Domain with them
   in place, it replaces them. Either way, expect up to the record TTL (5 minutes) of mixed answers.
2. Add Custom Domain `mitchellknoth.com` to the Worker.
3. Run the parity contract with `WORKERS_BASE_URL=https://mitchellknoth.com`, then the headed spot-check.

## 5. Point `www` back at the apex

Serve `www` as a redirect, not a second copy of the site:

1. Remove the `www` Custom Domain from the Worker.
2. Add a proxied `AAAA` record `www` → `100::` (Cloudflare's reserved originless placeholder).
3. **Rules → Redirect Rules**: hostname equals `www.mitchellknoth.com` → `https://mitchellknoth.com` with the
   path and query string preserved, status 301.
4. Confirm `https://www.mitchellknoth.com/about/` returns 301 to `https://mitchellknoth.com/about/`.

## 6. Rollback

GitHub Pages is still built and configured, so rollback is DNS only:

1. Remove the Custom Domain(s) from the Worker.
2. Delete any `www` placeholder record and redirect rule from step 5.
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
