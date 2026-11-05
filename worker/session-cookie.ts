// The cookie that carries a visitor's server-chosen session name. It lives outside worker/index.ts because the
// Workers runtime only accepts handlers and Durable Object classes as named exports of the main module.
export const SESSION_COOKIE = '__Host-agent_session';
