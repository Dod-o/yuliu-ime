export class LRU<K, V> {
  private values = new Map<K, V>();
  constructor(private limit: number) {}
  get(key: K) {
    const v = this.values.get(key);
    if (v !== undefined) {
      this.values.delete(key);
      this.values.set(key, v);
    }
    return v;
  }
  set(key: K, value: V) {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > this.limit) {
      this.values.delete(this.values.keys().next().value!);
    }
  }
  clear() {
    this.values.clear();
  }
  get size() {
    return this.values.size;
  }
}
export type Reading = {
  pieces: string[];
  abbreviated: number;
  pinyin?: string[];
};
export function forms(pinyin: string[]): Reading[] {
  let result: Reading[] = [{ pieces: [], abbreviated: 0 }];
  for (const py of pinyin) {
    result = result.flatMap(
      (r) => [
        { pieces: [...r.pieces, py], abbreviated: r.abbreviated },
        ...(py.length > 1
          ? [{ pieces: [...r.pieces, py[0]], abbreviated: r.abbreviated + 1 }]
          : []),
      ],
    ).slice(0, 64);
  }
  return result.map((r) => ({ ...r, pinyin }));
}
export function matchReadingDetails(
  keys: string,
  reading: Reading,
  boundaries: number[] = [],
): { consumed: number; completion: boolean } {
  let offset = 0;
  const syllableEnds: number[] = [];
  for (let i = 0; i < reading.pieces.length; i++) {
    const piece = reading.pieces[i], remaining = keys.slice(offset);
    if (!remaining) return { consumed: 0, completion: false };
    if (remaining.startsWith(piece)) {
      offset += piece.length;
      syllableEnds.push(offset);
      continue;
    }
    if (i === reading.pieces.length - 1 && piece.startsWith(remaining)) {
      if (
        boundaries.some((b) =>
          b === keys.length || b < keys.length && !syllableEnds.includes(b)
        )
      ) return { consumed: 0, completion: false };
      return { consumed: keys.length, completion: true };
    }
    return { consumed: 0, completion: false };
  }
  if (boundaries.some((b) => b <= offset && !syllableEnds.includes(b))) {
    return { consumed: 0, completion: false };
  }
  return { consumed: offset, completion: false };
}
export function matchReading(keys: string, reading: Reading): number {
  return matchReadingDetails(keys, reading).consumed;
}
export function edits(keys: string): string[] {
  if (keys.length < 4 || keys.length > 32) return [];
  const values = new Set<string>();
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < keys.length; i++) {
    values.add(keys.slice(0, i) + keys.slice(i + 1));
    if (i + 1 < keys.length) {
      values.add(keys.slice(0, i) + keys[i + 1] + keys[i] + keys.slice(i + 2));
    }
    for (const c of alphabet) {
      values.add(keys.slice(0, i) + c + keys.slice(i + 1));
    }
  }
  for (let i = 0; i <= keys.length; i++) {
    for (const c of alphabet) {
      values.add(keys.slice(0, i) + c + keys.slice(i));
    }
  }
  values.delete(keys);
  return [...values];
}
export function normalizedKeys(raw: string) {
  const letters: string[] = [];
  const ends: number[] = [];
  const boundaries: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i].toLowerCase();
    if (/[a-z]/.test(c)) {
      letters.push(c);
      ends.push(i + 1);
    } else if (c === "'" || c === " ") {
      if (letters.length) {
        ends[ends.length - 1] = i + 1;
        if (!boundaries.includes(letters.length)) {
          boundaries.push(letters.length);
        }
      }
    } else return null;
  }
  return { keys: letters.join(""), ends, boundaries };
}
