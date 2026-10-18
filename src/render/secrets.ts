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
];

// kbquery.go:297 secretPairRe
const SECRET_PAIR_RE = /(?:password|passwd|secret|api[_-]?key|access[_-]?key|token)["']?[\t\n\f\r ]*(?::=|[:=])[\t\n\f\r ]*["']?([^\t\n\f\r "',;]{8,})/giu;

// kbquery.go:304 fieldAccessRe
const FIELD_ACCESS_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/u;

// kbquery.go:299-301 secretValue
function secretValue(v: string): boolean {
  return !'${%<'.includes(v.charAt(0)) && !v.includes('(') && !FIELD_ACCESS_RE.test(v);
}

// kbquery.go:307-325 leaksSecret; knownSecrets (keychain_env values) match as exact substrings.
export function leaksSecret(texts: string[], knownSecrets: string[] = []): boolean {
  const known = knownSecrets.filter((s) => s.length > 0);
  for (const t of texts) {
    if (SECRET_RES.some((re) => re.test(t))) return true;
    for (const m of t.matchAll(SECRET_PAIR_RE)) {
      if (m[1] !== undefined && secretValue(m[1])) return true;
    }
    if (known.some((s) => t.includes(s))) return true;
  }
  return false;
}
