import { phase } from "../utils/perf.ts";
import { LRU } from "./primitives.ts";
export interface Probabilities {
  values: Float32Array;
  logNormalizer: number;
}
export class NPUProvider {
  private cache = new LRU<string, Probabilities>(64);
  private pending = new Map<string, Promise<Probabilities>>();
  stats = { hits: 0, misses: 0, inflightHits: 0 };
  private key = Deno.readTextFileSync(
    new URL("../../work/local-key.txt", import.meta.url),
  ).trim();
  peek(tokens: number[]) {
    return this.cache.get(tokens.join(","));
  }
  async get(tokens: number[]): Promise<Probabilities> {
    const prefix = tokens.join(","), cached = this.cache.get(prefix);
    if (cached) {
      this.stats.hits++;
      return cached;
    }
    const old = this.pending.get(prefix);
    if (old) {
      this.stats.inflightHits++;
      return old;
    }
    this.stats.misses++;
    const task = phase("npu_request", async () => {
      const response = await fetch("http://127.0.0.1:5001", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tokens }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error("NPU inference failed: " + response.status);
      const values = new Float32Array(await response.arrayBuffer());
      let max = -Infinity;
      for (const v of values) {
        if (!Number.isFinite(v)) throw Error("Non-finite NPU logits");
        if (v > max) max = v;
      }
      let sum = 0;
      for (const v of values) sum += Math.exp(v - max);
      const result = { values, logNormalizer: max + Math.log(sum) };
      this.cache.set(prefix, result);
      return result;
    }, () => ({ tokens: tokens.length }));
    this.pending.set(prefix, task);
    try {
      return await task;
    } finally {
      this.pending.delete(prefix);
    }
  }
}
export function logProbability(p: Probabilities, id: number) {
  return p.values[id] - p.logNormalizer;
}
