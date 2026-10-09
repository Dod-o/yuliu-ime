import { syncPhase, trace } from "../utils/perf.ts";
import type { Candidate, LIME } from "../main.ts";
import type { Token } from "node-llama-cpp";
import {
  edits,
  forms,
  LRU,
  matchReadingDetails,
  normalizedKeys,
  type Reading,
} from "./primitives.ts";
import { logProbability, NPUProvider, type Probabilities } from "./npu.ts";
import { LearningStore } from "./learning.ts";

type Entry = {
  id: number;
  word: string;
  pinyin: string[];
  readings: Reading[];
};
type State = {
  tokens: number[];
  word: string;
  py: string[];
  offset: number;
  logp: number;
  cost: number;
  abbreviated: boolean;
  completion: boolean;
};
export type Query = {
  keys?: string;
  context?: string;
  after?: string;
  progressive?: boolean;
  session?: string;
  surrounding?: boolean;
};
type Reply = {
  candidates: Candidate[];
  job: string;
  pending: boolean;
  revision: number;
  contextSource: string;
  error?: string;
  stats?: object;
};
type Job = {
  id: string;
  input: Query;
  reply: Reply;
  promise: Promise<void>;
  cancelled: boolean;
  initial: ReturnType<typeof Promise.withResolvers<void>>;
  usable: ReturnType<typeof Promise.withResolvers<void>>;
};
export class AdvancedIME {
  readonly provider = new NPUProvider();
  readonly learning = new LearningStore();
  private index = new Map<string, Entry[]>();
  private jobs = new LRU<string, Job>(96);
  private byId = new LRU<string, Job>(96);
  private latest = new LRU<string, Job>(96);
  private defaultContext = "";
  private epoch = 0;
  private syllables = new Set<string>();
  readonly historyChars = Math.max(
    32,
    Math.min(1000, Number(Deno.env.get("LIME_CONTEXT_CHARS") ?? 256)),
  );
  constructor(private base: LIME) {
    for (const [id, pronunciations] of base.token_pinyin_map) {
      const word = base.model.detokenize([id as Token]);
      if (!/^[\p{Script=Han}]+$/u.test(word) || pronunciations.length > 8) {
        continue;
      }
      let combinations: string[][] = [[]];
      for (const variants of pronunciations) {
        combinations = combinations.flatMap((p) =>
          variants.map((py) => [...p, py])
        ).slice(0, 16);
      }
      for (const ps of combinations) {
        for (const py of ps) this.syllables.add(py);
      }
      const readings = combinations.flatMap(forms).slice(0, 64);
      const entry = { id, word, pinyin: combinations[0], readings };
      for (
        const c of new Set(
          readings.map((r) => r.pieces[0]?.[0]).filter(Boolean),
        )
      ) {
        const list = this.index.get(c) ?? [];
        list.push(entry);
        this.index.set(c, list);
      }
    }
  }
  private recent(text: string) {
    return Array.from(text).slice(-this.historyChars).join("");
  }
  private tokens(context: string) {
    return this.base.model.tokenize(
      "下面是中文输入内容：" + this.recent(context),
    ).slice(-352) as number[];
  }
  setContext(text: string) {
    this.defaultContext = this.recent(text);
    void this.provider.get(this.tokens(text)).catch(() => {});
  }
  data() {
    return {
      words: {},
      committedContext: this.defaultContext,
      contextChars: Array.from(this.defaultContext).length,
      contextLimit: this.historyChars,
      context: this.tokens(this.defaultContext).map((token) => ({
        token,
        t: this.base.model.detokenize([token as Token]),
      })),
      cache: this.provider.stats,
    };
  }
  commit(
    body: {
      text?: string;
      context?: string;
      keys?: string;
      selected?: boolean;
    },
  ) {
    const text = body.text ?? "", before = body.context ?? this.defaultContext;
    this.defaultContext = this.recent(before + text);
    if (body.selected && body.keys) {
      this.learning.learn(normalizedKeys(body.keys)?.keys ?? "", text);
      this.epoch++;
    }
    void this.provider.get(this.tokens(this.defaultContext)).catch(() => {});
    return {
      message: "文本提交成功",
      contextChars: Array.from(this.defaultContext).length,
      at: Date.now(),
    };
  }
  changeLearning(action: string, id?: string) {
    const result = this.learning.change(action, id);
    this.epoch++;
    return result;
  }
  getResult(id: string) {
    return this.byId.get(id)?.reply;
  }
  async waitInitial(id: string) {
    const job = this.byId.get(id);
    if (job && job.reply.candidates.length === 0) await job.initial.promise;
    return job?.reply;
  }
  private hasUsable(job: Job) {
    const strict = this.validPinyin(normalizedKeys(job.input.keys!)!.keys);
    return job.reply.candidates.some((c) =>
      c.consumedkeys === job.input.keys!.length &&
      (!strict || (!c.abbreviated && !c.completion && !c.correction))
    );
  }
  async waitUsable(id: string) {
    const job = this.byId.get(id);
    if (job && !this.hasUsable(job)) await job.usable.promise;
    return job?.reply;
  }
  async waitResult(id: string) {
    const job = this.byId.get(id);
    if (job) await job.promise;
    return job?.reply;
  }
  private candidates(
    states: State[],
    input: Query,
    variantKeys: string,
    correction = false,
  ): Candidate[] {
    const raw = input.keys ?? "", normalized = normalizedKeys(raw)!;
    return states.filter((s) => s.word).map((s) => {
      const complete = s.offset === variantKeys.length;
      return {
        word: s.word,
        score: s.logp / Math.pow(Array.from(s.word).length, 0.7) - s.cost -
          (correction ? 4 : 0) + this.learning.bonus(normalized.keys, s.word),
        pinyin: s.py,
        consumedkeys: correction
          ? raw.length
          : (normalized.ends[s.offset - 1] ?? 0),
        remainkeys: complete ? [] : [normalized.keys.slice(s.offset)],
        preedit: s.py.join(" "),
        abbreviated: s.abbreviated,
        completion: s.completion,
        ...(correction ? { correction: variantKeys } : {}),
      };
    }).filter((c) => !correction || c.remainkeys.length === 0);
  }
  private rank(candidates: Candidate[], raw: string) {
    const best = new Map<string, Candidate>();
    for (const c of candidates) {
      const key = c.word + "|" + c.consumedkeys;
      const previous = best.get(key);
      if (!previous || c.score > previous.score) best.set(key, c);
    }
    return [...best.values()].sort((a, b) => {
      const aFull = a.consumedkeys === raw.length,
        bFull = b.consumedkeys === raw.length;
      const aCorrected = "correction" in a, bCorrected = "correction" in b;
      const aStrict = !a.abbreviated && !a.completion,
        bStrict = !b.abbreviated && !b.completion;
      // Exact complete matches win over typo repair; incomplete matches can still
      // be displaced by a confident complete repair.
      return Number(bFull && !bCorrected && bStrict) -
          Number(aFull && !aCorrected && aStrict) ||
        Number(bFull) - Number(aFull) ||
        (this.validPinyin(normalizedKeys(raw)!.keys)
          ? Number(bStrict) - Number(aStrict)
          : 0) ||
        b.consumedkeys - a.consumedkeys ||
        b.score - a.score;
    }).slice(0, 40);
  }
  private expand(
    state: State,
    keys: string,
    probs: Probabilities,
    boundaries: number[] = [],
  ): State[] {
    return syncPhase(
      "candidate_filter",
      () => this.expandRaw(state, keys, probs, boundaries),
    );
  }
  private expandRaw(
    state: State,
    keys: string,
    probs: Probabilities,
    boundaries: number[],
  ): State[] {
    const remaining = keys.slice(state.offset);
    const options: State[] = [];
    for (const e of this.index.get(remaining[0]) ?? []) {
      let length = 0,
        abbreviated = Infinity,
        pronunciation = e.pinyin,
        completion = true;
      for (const r of e.readings) {
        const details = matchReadingDetails(
            remaining,
            r,
            boundaries.filter((b) => b > state.offset).map((b) =>
              b - state.offset
            ),
          ),
          n = details.consumed;
        if (
          n > length ||
          (n === length &&
            r.abbreviated * 2 + Number(details.completion) * 1.5 <
              abbreviated * 2 + Number(completion) * 1.5)
        ) {
          length = n;
          abbreviated = r.abbreviated;
          pronunciation = r.pinyin ?? e.pinyin;
          completion = details.completion;
        }
      }
      if (!length) continue;
      const lp = logProbability(probs, e.id);
      if (!Number.isFinite(lp)) continue;
      options.push({
        tokens: [...state.tokens, e.id],
        word: state.word + e.word,
        py: [...state.py, ...pronunciation],
        offset: state.offset + length,
        logp: state.logp + lp,
        cost: state.cost + abbreviated * 2 + Number(completion) * 1.5,
        abbreviated: state.abbreviated || abbreviated > 0,
        completion: state.completion || completion,
      });
    }
    return options.sort((a, b) => {
      const aFull = a.offset === keys.length, bFull = b.offset === keys.length;
      return Number(bFull && b.cost === 0) - Number(aFull && a.cost === 0) ||
        this.stateScore(b) - this.stateScore(a) || b.offset - a.offset;
    }).slice(0, 12);
  }
  private validPinyin(keys: string) {
    const possible = new Set([0]);
    for (let i = 0; i < keys.length; i++) {
      if (possible.has(i)) {
        for (const py of this.syllables) {
          if (keys.startsWith(py, i)) possible.add(i + py.length);
        }
      }
    }
    return possible.has(keys.length);
  }
  private stateScore(s: State) {
    return s.logp / Math.pow(Math.max(1, Array.from(s.word).length), 0.7) -
      s.cost;
  }
  async query(input: Query): Promise<Reply> {
    const raw = input.keys ?? "";
    if (raw.length > 96) throw Error("拼音过长（最多 96 个字符）");
    const normalized = normalizedKeys(raw);
    if (!normalized || !normalized.keys) {
      return {
        candidates: [],
        job: "",
        pending: false,
        revision: 0,
        contextSource: "provided",
      };
    }
    const context = this.recent(input.context ?? this.defaultContext);
    const normalizedInput = { ...input, context };
    const cacheKey = JSON.stringify([
      raw,
      context,
      input.after ?? "",
      input.session ?? "default",
      this.epoch,
    ]);
    const session = input.session ?? "default";
    const previous = this.latest.get(session);
    const cached = this.jobs.get(cacheKey);
    if (cached && !cached.cancelled) {
      if (previous && previous !== cached && previous.reply.pending) {
        previous.cancelled = true;
      }
      this.latest.set(session, cached);
      if (!input.progressive) await cached.promise;
      return cached.reply;
    }
    if (previous?.reply.pending) previous.cancelled = true;
    const id = crypto.randomUUID();
    const prefix = this.tokens(context),
      baseState: State = {
        tokens: [],
        word: "",
        py: [],
        offset: 0,
        logp: 0,
        cost: 0,
        abbreviated: false,
        completion: false,
      };
    const available = this.provider.peek(prefix);
    const first = available
      ? this.expand(
        baseState,
        normalized.keys,
        available,
        normalized.boundaries,
      )
      : [];
    const reply: Reply = {
      candidates: this.rank(
        this.candidates(first, normalizedInput, normalized.keys),
        raw,
      ),
      job: id,
      pending: true,
      revision: 0,
      contextSource: input.surrounding ? "document" : "commits",
    };
    const job: Job = {
      id,
      input: normalizedInput,
      reply,
      promise: Promise.resolve(),
      cancelled: false,
      initial: Promise.withResolvers<void>(),
      usable: Promise.withResolvers<void>(),
    };
    this.jobs.set(cacheKey, job);
    this.byId.set(id, job);
    this.latest.set(session, job);
    const created = performance.now();
    job.promise = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
      () =>
        trace("candidate_search", {
          keyChars: raw.length,
          contextChars: Array.from(context).length,
        }, () => this.search(job, prefix, normalized.keys)),
    ).catch((e) => {
      reply.error = String(e);
    }).finally(() => {
      job.initial.resolve();
      job.usable.resolve();
      reply.pending = false;
      reply.stats = {
        ms: Math.round(performance.now() - created),
        budgetMs: 1800,
        cancelled: job.cancelled,
        ...reply.stats,
      };
    });
    if (!input.progressive) await job.promise;
    return reply;
  }
  private async search(job: Job, prefix: number[], keys: string) {
    const start = performance.now(), deadline = start + 1800;
    let calls = 0;
    const boundaries = normalizedKeys(job.input.keys!)!.boundaries;
    const probabilities = await this.provider.get(prefix);
    if (job.cancelled) return;
    const seed: State = {
      tokens: [],
      word: "",
      py: [],
      offset: 0,
      logp: 0,
      cost: 0,
      abbreviated: false,
      completion: false,
    };
    let frontier = this.expand(seed, keys, probabilities, boundaries);
    const all: State[] = [...frontier];
    job.reply.candidates = this.rank(
      this.candidates(all, job.input, keys),
      job.input.keys!,
    );
    job.reply.revision++;
    job.initial.resolve();
    if (this.hasUsable(job)) job.usable.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let depth = 0; depth < 7; depth++) {
      const active = frontier.filter((s) => s.offset < keys.length).sort((
        a,
        b,
      ) =>
        Number(this.validPinyin(keys) && a.cost > 0) -
          Number(this.validPinyin(keys) && b.cost > 0) ||
        (this.stateScore(b) + b.offset * 1.5) -
          (this.stateScore(a) + a.offset * 1.5)
      ).slice(0, 3);
      if (!active.length) break;
      const next: State[] = [];
      for (const state of active) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (job.cancelled || performance.now() > deadline) return;
        const p = await this.provider.get([...prefix, ...state.tokens]);
        calls++;
        if (job.cancelled) return;
        next.push(...this.expand(state, keys, p, boundaries));
      }
      all.push(...next);
      frontier = next;
      job.reply.candidates = this.rank(
        this.candidates(all, job.input, keys),
        job.input.keys!,
      );
      job.reply.revision++;
      if (this.hasUsable(job)) {
        job.usable.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (all.filter((s) => s.offset === keys.length).length >= 8) break;
    }
    // Personal terms are explicitly supplied by the user, but still receive an
    // actual model score rather than a fabricated dictionary probability.
    for (const term of this.learning.matching(keys).slice(0, 3)) {
      if (job.cancelled || performance.now() > deadline) return;
      const ts = this.base.model.tokenize(term.word) as number[];
      let score = 0;
      for (let i = 0; i < ts.length; i++) {
        if (job.cancelled || performance.now() > deadline) return;
        const p = await this.provider.get([...prefix, ...ts.slice(0, i)]);
        score += logProbability(p, ts[i]);
      }
      job.reply.candidates.push({
        word: term.word,
        score: score / Math.pow(Array.from(term.word).length, 0.7) +
          this.learning.bonus(keys, term.word),
        pinyin: [],
        consumedkeys: job.input.keys!.length,
        remainkeys: [],
        preedit: keys,
      });
    }
    if (
      keys.length >= 4 && /[aeiou]/.test(keys) &&
      !job.reply.candidates.some((c) =>
        c.consumedkeys === job.input.keys!.length &&
        !c.abbreviated && !c.completion
      )
    ) {
      const variants = edits(keys).filter((k) => this.validPinyin(k));
      const repairStarts: { variant: string; state: State }[] = [];
      for (const [i, variant] of variants.entries()) {
        if (i % 8 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (job.cancelled || performance.now() > deadline) break;
        }
        repairStarts.push(
          ...this.expand(seed, variant, probabilities).filter((s) =>
            s.cost === 0
          ).slice(0, 1).map((state) => ({ variant, state })),
        );
      }
      const starts = repairStarts.sort((a, b) =>
        this.stateScore(b.state) - this.stateScore(a.state)
      ).slice(0, 3);
      for (const item of starts) {
        let state = item.state;
        for (
          let depth = 0;
          state.offset < item.variant.length && depth < 5;
          depth++
        ) {
          if (job.cancelled || performance.now() > deadline) break;
          const p = await this.provider.get([...prefix, ...state.tokens]);
          calls++;
          const next = this.expand(state, item.variant, p).filter((s) =>
            s.cost === 0
          )[0];
          if (!next) break;
          state = next;
        }
        if (state.offset === item.variant.length) {
          job.reply.candidates.push(
            ...this.candidates([state], job.input, item.variant, true),
          );
        }
      }
    }
    // Score a bounded suffix on every candidate in the comparison set.
    const ranked = this.rank(job.reply.candidates, job.input.keys!);
    const after = job.input.after ?? "";
    if (
      keys.length >= 3 && this.validPinyin(keys) && after && ranked.length &&
      performance.now() + 650 < deadline
    ) {
      const suffix = this.base.model.tokenize(after).slice(0, 2) as number[];
      const scored: Candidate[] = [];
      for (const c of ranked.slice(0, 3)) {
        if (job.cancelled) return;
        const ts = this.base.model.tokenize(c.word) as number[];
        let lookahead = 0;
        for (let i = 0; i < suffix.length; i++) {
          if (job.cancelled) return;
          if (performance.now() > deadline) {
            job.reply.candidates = ranked;
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const p = await this.provider.get([
            ...prefix,
            ...ts,
            ...suffix.slice(0, i),
          ]);
          calls++;
          lookahead += logProbability(p, suffix[i]);
        }
        scored.push({ ...c, score: c.score + lookahead });
      }
      job.reply.candidates = this.rank(scored, job.input.keys!);
    } else job.reply.candidates = ranked;
    job.reply.revision++;
    job.reply.stats = {
      ms: Math.round(performance.now() - start),
      branchCalls: calls,
      cache: { ...this.provider.stats },
    };
  }
}
