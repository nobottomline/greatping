import { USER_CODE_ALPHABET } from './constants';

/**
 * Links that carry a one-time pairing or device-link code.
 *
 * A QR code holds `https://greatping.com/p#ABCDEFGH` (pair a computer) or
 * `/l#…` (link a device). A phone with the app opens it through Universal
 * Links / Android App Links; a phone without it gets a page on the site
 * instead of a dead end, and no other app can claim the link as it can a
 * custom scheme. The code sits in the fragment, which a browser never sends
 * to a server or in a Referer: its second half is the password of the
 * pairing key exchange and must never reach any server, ours included.
 *
 * The paths are one letter and the code has no separator so that the link is
 * 32 bytes, the most a version 2 QR code (25 × 25 modules) holds; the
 * terminal QR stays as small as the older `greatping://pair?code=…` one.
 */

/** The site whose verified association files let the app open these links. */
export const SITE_ORIGIN = 'https://greatping.com';

/** What a code link asks the scanning device to do. */
export const CODE_LINK_KINDS = ['pair', 'link'] as const;
export type CodeLinkKind = (typeof CODE_LINK_KINDS)[number];

/** The site path of each kind. */
export const CODE_LINK_PATHS: Record<CodeLinkKind, string> = { pair: '/p', link: '/l' };

const CODE_LENGTH = 8;

/** The eight-symbol code of a typed or linked value, or null if it is not exactly one. */
function exactCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/-/g, '');
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((ch) => USER_CODE_ALPHABET.includes(ch)) ? code : null;
}

function checkedCode(code: string): string {
  const exact = exactCode(code);
  if (!exact) throw new Error('not a pairing code');
  return exact;
}

/** `https://greatping.com/p#ABCDEFGH`; `code` in any case, with or without its dash. */
export function buildCodeLink(kind: CodeLinkKind, code: string): string {
  return `${SITE_ORIGIN}${CODE_LINK_PATHS[kind]}#${checkedCode(code)}`;
}

/**
 * The older `greatping://pair?code=ABCD-EFGH`, for a QR that a device whose
 * scanner predates site links may still have to read.
 */
export function buildSchemeCodeLink(kind: CodeLinkKind, code: string): string {
  const exact = checkedCode(code);
  return `greatping://${kind}?code=${exact.slice(0, 4)}-${exact.slice(4)}`;
}

/** The QR a computer shows for `greatping login`. */
export const buildPairDeepLink = (code: string) => buildCodeLink('pair', code);

// Exact shapes only: no other host, port, user info, path, query or extra
// fragment content. Scheme and host compare case-insensitively, as URLs do;
// the path does not, like the association files and the static site: `/P`
// would open neither the app nor the code page, only the site's 404.
// The path is exact, as in the association files: `/p/` would open the page,
// not the app, so it is not a code link either.
const SITE_LINK =
  /^[Hh][Tt][Tt][Pp][Ss]:\/\/[Gg][Rr][Ee][Aa][Tt][Pp][Ii][Nn][Gg]\.[Cc][Oo][Mm]\/([pl])#([0-9A-Za-z]{4}-?[0-9A-Za-z]{4})$/;
const SITE_PAGE =
  /^[Hh][Tt][Tt][Pp][Ss]:\/\/[Gg][Rr][Ee][Aa][Tt][Pp][Ii][Nn][Gg]\.[Cc][Oo][Mm]\/([pl])\/?(?:[?#].*)?$/;
// Links printed by CLI 0.5 and earlier and used by the QA build and E2E flows.
const SCHEME_LINK = /^greatping(?:-qa)?:\/\/\/?(pair|link)\/?\?([^#]*)$/i;

const kindOfPath = (letter: string): CodeLinkKind => (letter === 'p' ? 'pair' : 'link');

/**
 * The kind and code of a pairing or device-link link, or null for anything
 * else. Accepts the site link and the older `greatping://<kind>?code=…`.
 */
export function parseCodeLink(value: string): { kind: CodeLinkKind; code: string } | null {
  const text = value.trim();
  const site = SITE_LINK.exec(text);
  if (site?.[1] && site[2]) {
    const code = exactCode(site[2]);
    return code ? { kind: kindOfPath(site[1]), code } : null;
  }
  const scheme = SCHEME_LINK.exec(text);
  if (!scheme?.[1] || scheme[2] === undefined) return null;
  const codes = new URLSearchParams(scheme[2]).getAll('code');
  const code = codes.length === 1 && codes[0] ? exactCode(codes[0]) : null;
  return code ? { kind: scheme[1].toLowerCase() as CodeLinkKind, code } : null;
}

/** The kind of a site code page, with or without a valid code; null for any other URL. */
export function codeLinkKindOf(value: string): CodeLinkKind | null {
  const match = SITE_PAGE.exec(value.trim());
  return match?.[1] ? kindOfPath(match[1]) : null;
}
