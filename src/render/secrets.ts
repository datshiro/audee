// Ported from ciel/kbquery.go:286-325. Go RE2 to JavaScript: `u` flag everywhere, (?i) becomes the i flag,
// \s becomes [\t\n\f\r ] (RE2's \s is ASCII-only).

// kbquery.go:286-291 secretRes
const SECRET_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/u,
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\t\n\f\r :/@]+:[^\t\n\f\r :/@]+@/u, // URI with user:password
  /\b(?:glpat-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA)[A-Za-z0-9_\-]{12,}|\bsk-[A-Za-z0-9]{20,}/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u, // JWT
  // audee additions
  /sk-ant-[A-Za-z0-9_-]{20,}/u,
  /glsa_[A-Za-z0-9_]{20,}/u,
  /glpat-[A-Za-z0-9_-]{20,}/u,
  /glcbt-[A-Za-z0-9_-]{20,}/u,
  /:APA91b[A-Za-z0-9_-]{40,}/u, // a bare FCM registration token
];

// kbquery.go:297 secretPairRe, plus audee's push registration and device keys
const SECRET_PAIR_RE = /(?:password|passwd|secret|api[_-]?key|access[_-]?key|tokens?|registration_?id|reg_?id|device_?id)["']?[\t\n\f\r ]*(?::=|[:=])[\t\n\f\r ]*["']?([^\t\n\f\r "',;]{8,})/giu;
// A list of FCM registration ids; every item is a secret.
const SECRET_LIST_RE = /(?:registration_?ids|fcm_?tokens|device_?tokens)["']?[\t\n\f\r ]*[:=][\t\n\f\r ]*\[([^\]]*)\]/giu;
const LIST_ITEM_RE = /[^\t\n\f\r "',;[\]]{8,}/gu;
// An HTTP credential. A value with no digit or = is taken for a placeholder or prose (YOUR_ACCESS_TOKEN, auth/token-based).
const AUTH_RE = /\b(?:Bearer|Basic)[\t\n\f\r ]+([A-Za-z0-9._~+/-]{16,}=*)/giu;
const credential = (v: string): boolean => /[0-9=]/u.test(v);

// kbquery.go:304 fieldAccessRe
const FIELD_ACCESS_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/u;

// kbquery.go:299-301 secretValue
function secretValue(v: string): boolean {
  return !'${%<'.includes(v.charAt(0)) && !v.startsWith('[<') && !v.includes('(') && !FIELD_ACCESS_RE.test(v);
}

// JSON-escaped quotes, once or more ({\"token\":\"...\"}, {\\\"token\\\"...}): SECRET_PAIR_RE does not see them as a pair.
const unescapeQuotes = (s: string): string => s.replace(/\\+"/gu, '"');

// kbquery.go:307-325 leaksSecret; knownSecrets (keychain_env values) match as exact substrings. Each text is also
// checked with its escaped quotes undone, as redactSecretPairs reads it.
export function leaksSecret(texts: string[], knownSecrets: string[] = []): boolean {
  const known = knownSecrets.filter((s) => s.length > 0);
  for (const t of texts.flatMap((x) => [...new Set([x, unescapeQuotes(x)])])) {
    if (SECRET_RES.some((re) => re.test(t))) return true;
    for (const m of t.matchAll(SECRET_PAIR_RE)) {
      if (m[1] !== undefined && secretValue(m[1])) return true;
    }
    for (const m of t.matchAll(SECRET_LIST_RE)) {
      if ([...(m[1] ?? '').matchAll(LIST_ITEM_RE)].some((v) => secretValue(v[0]))) return true;
    }
    for (const m of t.matchAll(AUTH_RE)) {
      if (m[1] !== undefined && credential(m[1])) return true;
    }
    if (known.some((s) => t.includes(s))) return true;
  }
  return false;
}

const redactTail = (whole: string, value: string): string => whole.slice(0, whole.length - value.length) + '<redacted>';

// The value of a secret-named pair, a registration id list or an HTTP credential replaced, so a quoted log line can
// be shown; other secret shapes still leak.
export function redactSecretPairs(s: string): string {
  return unescapeQuotes(s)
    .replace(SECRET_LIST_RE, (whole: string, items: string) => `${whole.slice(0, whole.length - items.length - 1)}${items.replace(LIST_ITEM_RE, (v) => (secretValue(v) ? '<redacted>' : v))}]`)
    .replace(SECRET_PAIR_RE, (whole: string, value: string) => (secretValue(value) ? redactTail(whole, value) : whole))
    .replace(AUTH_RE, (whole: string, value: string) => (credential(value) ? redactTail(whole, value) : whole));
}
