// Go counts code points; JavaScript .length counts UTF-16 units and would split emoji.
export const runes = (s: string): string[] => Array.from(s);
export const runeLength = (s: string): number => runes(s).length;
export const runeSlice = (s: string, n: number): string => runes(s).slice(0, n).join('');
