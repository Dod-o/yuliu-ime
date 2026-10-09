export type LearnedEntry = {
  id: string;
  keys: string;
  word: string;
  count: number;
  updated: number;
};
export class LearningStore {
  private entries: LearnedEntry[] = [];
  enabled = true;
  private undoSnapshot: LearnedEntry[] | null = null;
  constructor(
    private file = new URL("../../work/learning.json", import.meta.url),
  ) {
    try {
      const data = JSON.parse(Deno.readTextFileSync(file));
      this.entries = data.entries;
      this.enabled = data.enabled !== false;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  list() {
    return {
      enabled: this.enabled,
      entries: this.entries.map((e) => ({ ...e })),
    };
  }
  matching(keys: string) {
    return this.entries.filter((e) => e.keys === keys);
  }
  bonus(keys: string, word: string) {
    if (!this.enabled) return 0;
    const e = this.entries.find((e) => e.keys === keys && e.word === word);
    return e ? Math.min(1.5, 0.35 * Math.log1p(e.count)) : 0;
  }
  learn(keys: string, word: string) {
    if (
      !this.enabled || !keys || !word || keys.length > 64 ||
      Array.from(word).length > 32
    ) return;
    this.snapshot();
    const found = this.entries.find((e) => e.keys === keys && e.word === word);
    if (found) {
      found.count++;
      found.updated = Date.now();
    } else {this.entries.push({
        id: crypto.randomUUID(),
        keys,
        word,
        count: 1,
        updated: Date.now(),
      });}
    this.entries.sort((a, b) => b.updated - a.updated);
    this.entries = this.entries.slice(0, 2000);
    this.save();
  }
  change(action: string, id?: string) {
    if (action === "undo") {
      if (this.undoSnapshot) {
        this.entries = this.undoSnapshot;
        this.undoSnapshot = null;
      }
    } else if (action === "pause") this.enabled = false;
    else if (action === "resume") this.enabled = true;
    else if (action === "clear") {
      this.snapshot();
      this.entries = [];
    } else if (action === "remove") {
      this.snapshot();
      this.entries = this.entries.filter((e) => e.id !== id);
    } else throw Error("Invalid learning action");
    this.save();
    return this.list();
  }
  private snapshot() {
    this.undoSnapshot = this.entries.map((e) => ({ ...e }));
  }
  private save() {
    const tmp = new URL(this.file.href + ".tmp");
    Deno.writeTextFileSync(
      tmp,
      JSON.stringify({ enabled: this.enabled, entries: this.entries }),
    );
    Deno.renameSync(tmp, this.file);
  }
}
