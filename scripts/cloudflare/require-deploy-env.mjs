// Refuses to deploy unless the target account is set explicitly. Without CLOUDFLARE_ACCOUNT_ID and a
// scoped CLOUDFLARE_API_TOKEN, Wrangler falls back to whatever account the local login can reach, which
// may not be this site's account. CI sets both from the cloudflare-workers environment (#15).
const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Refusing to deploy: set ${missing.join(' and ')} (see docs/runbooks/workers-cutover.md).`);
  process.exit(1);
}
