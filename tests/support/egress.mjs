// Browser egress contract (#13): the site loads resources only from its own origin.
import { parse } from 'parse5';

/** Public origin of the site; relative URLs in the build resolve against it. */
export const SITE_ORIGIN = 'https://mitchellknoth.com';

/**
 * Third-party hosts the browser may request. Starts empty. Each addition needs a reason and the
 * milestone that approved it; the only one planned is Turnstile (`challenges.cloudflare.com`) in M4.
 * @type {ReadonlyArray<{ host: string, reason: string }>}
 */
export const THIRD_PARTY_ALLOWLIST = [];

/**
 * Whether a request URL is allowed from a page served at `pageOrigin`.
 * @param {string} url
 * @param {string} pageOrigin
 */
export function isAllowedRequest(url, pageOrigin) {
  const parsed = new URL(url, pageOrigin);
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') return true;
  if (parsed.origin === new URL(pageOrigin).origin) return true;
  return THIRD_PARTY_ALLOWLIST.some(({ host }) => parsed.hostname === host);
}

// Link relations that make the browser fetch or connect to the target.
const FETCHING_RELS = new Set([
  'stylesheet', 'preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch', 'prerender',
  'icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon', 'manifest',
]);
// Attributes that make the browser fetch the target as soon as the element exists.
const FETCHING_ATTRS = /** @type {Record<string, string[]>} */ ({
  script: ['src'],
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  object: ['data'],
  input: ['src'],
  form: ['action'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
  feimage: ['href', 'xlink:href'],
  base: ['href'],
});
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/g;
// Absolute or protocol-relative URLs inside executable script. Any such URL fails the check, even
// if the script never requests it; review and allowlist it explicitly if that ever happens.
const SCRIPT_URL = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?[^\s'"`)]*/gi;

/** @param {string} value */
const srcsetUrls = (value) => value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean);

/** @param {string} css */
export function cssUrls(css) {
  return [...css.matchAll(CSS_URL)].map((m) => m[2] ?? m[4]).filter(Boolean);
}

/** @param {string} script */
export function scriptUrls(script) {
  return [...script.matchAll(SCRIPT_URL)].map((m) => m[0]);
}

/** @typedef {{ nodeName: string, tagName?: string, value?: string, attrs?: Array<{ name: string, value: string }>, childNodes?: Node[], content?: Node }} Node */

const isExecutableScript = (/** @type {string | undefined} */ type) =>
  !type || /^(module|text\/javascript|application\/javascript)$/i.test(type);

/**
 * Lists every URL in an HTML document that the browser would request without user action.
 * Navigation links (`<a href>`) and metadata such as `og:image` are not requests.
 * @param {string} html
 * @returns {Array<{ url: string, where: string }>}
 */
export function htmlRequestUrls(html) {
  /** @type {Array<{ url: string, where: string }>} */
  const found = [];
  /** @param {Node} node */
  const walk = (node) => {
    const tag = node.tagName;
    const attrs = new Map((node.attrs ?? []).map((a) => [a.name.toLowerCase(), a.value]));
    if (tag) {
      if (tag === 'link') {
        const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
        if (rels.some((rel) => FETCHING_RELS.has(rel)) && attrs.get('href')) {
          found.push({ url: /** @type {string} */ (attrs.get('href')), where: `<link rel="${attrs.get('rel')}">` });
        }
        for (const url of srcsetUrls(attrs.get('imagesrcset') ?? '')) found.push({ url, where: '<link imagesrcset>' });
      }
      for (const name of FETCHING_ATTRS[tag.toLowerCase()] ?? []) {
        const value = attrs.get(name);
        if (!value) continue;
        const urls = name === 'srcset' ? srcsetUrls(value) : [value];
        for (const url of urls) found.push({ url, where: `<${tag} ${name}>` });
      }
      if (tag === 'meta' && (attrs.get('http-equiv') ?? '').toLowerCase() === 'refresh') {
        const match = /url\s*=\s*(.+)$/i.exec(attrs.get('content') ?? '');
        if (match) found.push({ url: match[1].trim().replace(/^['"]|['"]$/g, ''), where: '<meta http-equiv="refresh">' });
      }
      const style = attrs.get('style');
      if (style) for (const url of cssUrls(style)) found.push({ url, where: `<${tag} style>` });
      const text = (node.childNodes ?? []).filter((c) => c.nodeName === '#text').map((c) => c.value).join('');
      if (tag === 'style') for (const url of cssUrls(text)) found.push({ url, where: '<style>' });
      if (tag === 'script' && isExecutableScript(attrs.get('type'))) {
        for (const url of scriptUrls(text)) found.push({ url, where: '<script> (inline)' });
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(/** @type {Node} */ (/** @type {unknown} */ (parse(html))));
  return found;
}
