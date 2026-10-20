const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Lowercase email used for uniqueness. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Canonical email for "one free trial per email" checks: lowercase, `+tag` removed,
 * and for Gmail the dots in the local part removed (j.ohn+x@gmail.com == john@gmail.com).
 */
export function emailKey(email: string): string {
  const [rawLocal = '', rawDomain = ''] = normalizeEmail(email).split('@');
  const domain = GMAIL_DOMAINS.has(rawDomain) ? 'gmail.com' : rawDomain;
  let local = rawLocal.split('+')[0] ?? rawLocal;
  if (domain === 'gmail.com') {
    local = local.replaceAll('.', '');
  }
  return `${local}@${domain}`;
}
