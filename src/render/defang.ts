// Ported from ciel/kbquery.go:326-343: links in text posted as the user must not turn clickable.
const SCHEME_RE = /\bhttp(s?):\/\//giu;
const WWW_RE = /\bwww\./giu;

export function defang(s: string): string {
  return s.replace(SCHEME_RE, 'hxxp$1://').replace(WWW_RE, 'www[.]');
}

export function defangAll(items: string[]): string[] {
  return items.map(defang);
}
