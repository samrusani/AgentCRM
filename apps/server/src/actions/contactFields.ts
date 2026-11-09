import { z } from 'zod';

// Phone and website are plain text columns on people and organizations (migration 036). One set of rules covers every
// write path: PATCH, proposals, capture, and import accept.

export const phoneMessage = 'A phone number needs at least one digit.';
export const websiteMessage = 'Website must be an http or https link, such as https://example.com.';

const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i;

// Trims, then returns the phone, null for an empty value, or undefined when it is not a phone. Callers that do not
// bound the length (the zod field below does) pass an already bounded string.
export function normalizePhone(value: string): string | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  if (text.length > 40 || !/\d/.test(text)) return undefined;
  return text;
}

// Control, zero width, and bidirectional characters: the WHATWG parser silently strips some of them, so without this
// check "ex\tample.com" would validate while the stored text keeps the tab.
const invisibleCharacters = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/;

// Trims, prepends https:// when there is no scheme (leading slashes dropped first), and checks the result parses as
// an http or https URL with a dotted domain host and no userinfo. Returns the website, null for an empty value, or
// undefined when it is not a usable link. The stored value is the text as typed; only url.hostname is punycode, so
// the host rule runs on that while the raw text is what persists.
export function normalizeWebsite(value: string): string | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  if (text.length > 500 || invisibleCharacters.test(text)) return undefined;
  const bare = hasScheme.test(text) ? text : text.replace(/^\/+/, '');
  if (bare === '') return undefined;
  const full = hasScheme.test(bare) ? bare : `https://${bare}`;
  if (full.length > 500) return undefined;
  try {
    const url = new URL(full);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    // A pasted email address or a URL with credentials is not a website.
    if (url.username !== '' || url.password !== '') return undefined;
    // The URL parser is lenient about hosts (it accepts "ht!tp" as one). A website is a dotted domain name:
    // letters, digits and hyphens between dots, at least two labels.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/.test(url.hostname)) return undefined;
  } catch {
    return undefined;
  }
  return full;
}

export const phoneField = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .transform((value, ctx) => {
    if (value === null) return null;
    const phone = normalizePhone(value);
    if (phone === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: phoneMessage.replace(/\.$/, '') });
      return z.NEVER;
    }
    return phone;
  });

export const websiteField = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .transform((value, ctx) => {
    if (value === null) return null;
    const website = normalizeWebsite(value);
    if (website === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: websiteMessage.replace(/\.$/, '') });
      return z.NEVER;
    }
    return website;
  });
