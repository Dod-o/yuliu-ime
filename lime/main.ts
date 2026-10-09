import path from "node:path";
import { phase, syncPhase, trace } from "./utils/perf.ts";
import { npuContext } from "./utils/npu_context.ts";
import { fileURLToPath } from "node:url";
import {
	getLlama,
	type LlamaContext,
	type LlamaContextSequence,
	type LlamaModel,
	type Token,
} from "node-llama-cpp";
import type { ZiIndAndKey, ZiIndL } from "./key_map/zi_ind.ts";
import { ziid_in_ziid } from "./utils/ziind_in_ziind.ts";

type ZiIndFunc = (zici: string) => string[][];

export type Candidate = {
	word: string;
	score: number;
	pinyin: string[];
	remainkeys: string[];
	preedit: string;
	consumedkeys: number;
	correction?: string;
	abbreviated?: boolean;
	completion?: boolean;
};

export type Result = {
	candidates: Candidate[];
};

export type UserData = {
	words: Record<number, Array<number>>;
	context: Array<{ t: string; token: Token }>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class Lock {
	private pm: Promise<void> | null = null;

	async acquire() {
		if (this.pm) await phase("lock_wait", () => this.pm!);
	}

	async lock() {
		await this.acquire();
		const p = Promise.withResolvers<void>();
		this.pm = p.promise;

		return {
			release: () => {
				p.resolve();
			},
		};
	}
}

export async function loadModel(op?: {
	modelPath?: string;
	contextSize?: number;
}) {
	const modelPath =
		op?.modelPath ??
		path.join(__dirname, "../Qwen3-0.6B-GGUF/Qwen3-0.6B-IQ4_XS.gguf");

	const llama = await getLlama({
		gpu: false,
	});

	console.log("加载模型", modelPath);

	const model = await llama.loadModel({
		modelPath: modelPath,
		vocabOnly: Deno.env.get("LIME_BACKEND") !== "cpu",
	});
	const context = Deno.env.get("LIME_BACKEND") === "cpu" ? await model.createContext({
		contextSize: { max: op?.contextSize ?? 4096 },
		threads: Number(Deno.env.get("LIME_THREADS") ?? 4),
	}) : npuContext(512);
	console.log("加载完成", JSON.stringify({device:Deno.env.get("LIME_BACKEND") === "cpu" ? "CPU" : "HTP0 NPU", idealThreads:context.idealThreads,currentThreads:context.currentThreads,contextSize:context.contextSize,batchSize:context.batchSize,flashAttention:context.flashAttention}));

	return { model, context };
}

export async function initLIME(
	op: Parameters<typeof loadModel>[0] & {
		ziInd: { trans: ZiIndFunc; allSymbol: Set<string> };
		omitContext?: boolean;
		afterReSort?: Array<AfterReSortFunc>;
	},
) {
	const { model, context } = await loadModel(op);
	const lime = new LIME({
		model,
		context,
		ziInd: op.ziInd,
		omitContext: op.omitContext,
		afterReSort: op.afterReSort,
	});
	await lime.init_ctx();
	return lime;
}

type ExToken = Token | number;
export type AfterReSortFunc = (candidates: Candidate[]) => Candidate[];

export class LIME {
	model: LlamaModel;
	context: LlamaContext;
	sequence: LlamaContextSequence;

	token_pinyin_map: Map<number, Array<Array<string>>> = new Map();
	first_pinyin_token = new Map<string, Set<number>>();
	unIndexedZi = new Map<string, Set<string>>();

	private timedEvaluate = async (...args: Parameters<LlamaContextSequence["controlledEvaluate"]>) => {
        const before=this.sequence.tokenMeter.getState();
        return phase("model_evaluate", () => this.sequence.controlledEvaluate(...args), () => ({
            tokens:this.sequence.tokenMeter.diff(before), contextTokens:this.sequence.contextTokens.length,
            currentThreads:this.context.currentThreads, idealThreads:this.context.idealThreads
        }));
    };
    private timedErase = (...args: Parameters<LlamaContextSequence["eraseContextTokenRanges"]>) =>
        phase("context_erase", () => this.sequence.eraseContextTokenRanges(...args));

	private pre_context = "下面是中文输入内容：";
    private committedText = "";
    private historyChars = Math.max(32, Math.min(1000, Number(Deno.env.get("LIME_CONTEXT_CHARS") ?? 256)));
    get committedContext() { return this.committedText; }
    private recentText(text: string) { return Array.from(text).slice(-this.historyChars).join(""); }
    sync_context = async (text: string) => {
        await this.modelEvalLock.acquire();
        const recent = this.recentText(text);
        if (recent === this.committedText) return;
        await this.reset_context();
        if (recent) await this.commit(recent);
        await this.getEvalResult();
    };
	last_context_data = { context: "" };
	private userTokens = new Map<ExToken, Array<Token>>();
	private userTokensFirstIndex = new Map<Token, Set<ExToken>>();
	private tokenIndex = 0;

	private last_result: Map<ExToken, number> | undefined;
	/** 长句补全，记录拼音和token对 */
	private longSentenceCache: {
		py: ZiIndL;
		matchPY: ZiIndAndKey[];
		token: ExToken[];
		nextResult: Map<ExToken, number>;
	}[] = [];
	private lastCommitOffset = 0;

	private afterReSort: Array<AfterReSortFunc>;

	private modelEvalLock = new Lock();

	/** 运行时触发 */
	private max_count = 4000;
	/** 空闲时触发，大任务，所以提前打算，触发值小一点 */
	private smallerMaxCount = 3500;
	private rm_count = 20;
	private omitContext = new deBounce(1000 * 10, async () => {
		await this.modelEvalLock.acquire();
		const { release } = await this.modelEvalLock.lock();
		await this.tryOmitContext();
		release();
	});

	constructor({
		model,
		context,
		ziInd,
		omitContext,
		afterReSort,
	}: {
		model: LlamaModel;
		context: LlamaContext;
		ziInd: { trans: ZiIndFunc; allSymbol: Set<string> };
		omitContext?: boolean;
		afterReSort?: Array<AfterReSortFunc>;
	}) {
		this.model = model;
		this.context = context;
		this.sequence = context.getSequence();

		this.max_count = context.contextSize - 64;
		this.smallerMaxCount =
			this.max_count - Math.min(512, Math.floor(this.max_count * 0.1));
		this.rm_count = Math.min(
			this.smallerMaxCount - 64,
			Math.floor(this.smallerMaxCount * 0.2),
		);
		if (!omitContext) this.omitContext.cancel();

		this.afterReSort = afterReSort ?? [];

		console.log("创建拼音索引");

		const { trans, allSymbol } = ziInd;

		let max = 0;
		for (const token_id of model.iterateAllTokens()) {
			max = Math.max(max, token_id);
		}
		this.tokenIndex = max + 1;

		// todo 先解码字，再遍历所有token建立索引
		for (const token_id of model.iterateAllTokens()) {
			const token = model.detokenize([token_id]);
			if (!token) continue;
			const pinyins = trans(token);
			allSymbol.delete(token);
			if (pinyins.length) {
				this.token_pinyin_map.set(token_id, pinyins);
				for (const fp of pinyins[0]) {
					const s = this.first_pinyin_token.get(fp) ?? new Set();
					s.add(token_id);
					this.first_pinyin_token.set(fp, s);
				}
			}
		}
		for (const zi of allSymbol) {
			const pys = trans(zi);
			if (pys.length === 1) {
				for (const py of pys[0]) {
					const s = this.unIndexedZi.get(py) ?? new Set();
					s.add(zi);
					this.unIndexedZi.set(py, s);
				}
			}
		}
		if (allSymbol.size > 0) {
			console.log(
				"以下字未直接建立拼音索引:",
				Array.from(allSymbol).slice(0, 10).join(" "),
				"等",
			);
		}
	}

	private tryOmitContext = async () => {
		if (this.sequence.contextTokens.length <= this.smallerMaxCount) {
			return;
		}
		const oldTokenLen = this.sequence.contextTokens.length;

		// 输入分词可能有些情况不是像分词器那样的切分，会影响模型性能，这里重编码分词
		const oldTokens = this.sequence.contextTokens.slice();
		const oldText = this.model.detokenize(oldTokens);
		const newTokens = this.model
			.tokenizer(oldText)
			.slice(-Math.max(this.smallerMaxCount - this.rm_count, 1));

		await this.sequence.clearHistory();
		await this.timedEvaluate([
			...newTokens.slice(0, -1),
			[
				// biome-ignore lint/style/noNonNullAssertion: none
				newTokens.at(-1)!,
				{
					generateNext: {
						probabilities: true,
						options: {
							topK: Infinity,
						},
					},
				},
			],
		]);
		this.lastCommitOffset = this.sequence.contextTokens.length;
		console.log(
			`已优化上下文 ${oldTokenLen}->${this.sequence.contextTokens.length}`,
		);
	};

	// 快速从最新删除上下文，保证后面操作不爆
	private fastTryOmitContext = async (buffer = 64) => {
		const maxCount = this.max_count - Math.max(buffer, 64);

		if (this.sequence.contextTokens.length <= maxCount) {
			return;
		}
		await this.timedErase([
			{
				start: 0,
				end: this.sequence.contextTokens.length - maxCount,
			},
		]);
		this.lastCommitOffset = this.sequence.contextTokens.length;
	};

	commit = (text: string, update = false, newT = true) => trace("commit_ack", {text}, () => this.commit_impl(text, update, newT));
	private commit_impl = async (text: string, update = false, newT = true) => {
		let new_text = "";
		let nt = newT;

		this.longSentenceCache = [];

		if (update) {
			if (text.startsWith(this.last_context_data.context)) {
				new_text = text.slice(this.last_context_data.context.length);
				this.last_context_data.context = text;
			} else {
				new_text = text;
				nt = true;
			}
		}
		if (nt) {
			this.last_context_data.context = "";
			if (update === false) {
				new_text = text;
			}
		}
		if (!new_text) return;

		// todo shift context

		// Retokenize the whole recent paragraph, independent of commit boundaries.
        this.committedText = this.recentText(this.committedText + new_text);
        const to_run = this.model.tokenizer(this.pre_context + this.committedText).slice(-this.smallerMaxCount);

		if (to_run.length === 0) return;

		const pre = to_run.slice(0, -1);
		const last = to_run[to_run.length - 1];
		const { release } = await this.modelEvalLock.lock();
		// 后台更新独立计时，保留原有异步提交行为
		void trace("commit_background", {text}, async () => {
            try {
			// Rebuild logical tokens; NPU prefix cache reuses identical distributions.
			// Drop speculative completion tokens before evaluating the canonical paragraph.
			await this.sequence.clearHistory();
			const res = await this.timedEvaluate([
				...pre,
				[
					last,
					{
						generateNext: {
							probabilities: true,
						},
					},
				],
			]);
			this.last_result = res.at(-1)?.next.probabilities; // todo 如果在自定义中某个tk值比较大，那尝试多运行一步
			// 临时
			for (const i of this.userTokens.keys()) {
				this.last_result?.set(i, 0);
			}
			this.lastCommitOffset = this.sequence.contextTokens.length;
			} finally { release(); }
		});

		this.omitContext.reset();

		return new_text;
	};

	reset_context = async () => {
		await this.modelEvalLock.acquire();
		this.last_context_data.context = "";
        this.committedText = "";
		this.userTokens.clear();
		this.longSentenceCache = [];
		await this.sequence.clearHistory();
		await this.init_ctx();
	};

	getEvalResult = async () => {
		await this.modelEvalLock.acquire();
		return this.last_result;
	};

	exTokens = (tokens: ExToken[]) => {
		const tks = tokens.flatMap((i) => this.userTokens.get(i) ?? [i as Token]);
		return tks;
	};
	detoken = (tokens: ExToken[]) => {
		return this.model.detokenize(this.exTokens(tokens));
	};

	checkAddUserWord = async (w: string) => {
		const ts = this.model.tokenizer(w);
		if (ts.length <= 1) return false;
		if (ts.some((i) => !this.token_pinyin_map.has(i))) return false;
		// 外部自己去重

		// todo 根据模型值来看，有些词模型可以很轻松预测出来，不需要加入用户词库
		return true;
	};

	addUserWord = (w: string) => {
		const ts = this.model.tokenizer(w);
		if (ts.length === 0) return false;

		const token_id = this.tokenIndex++;

		this.userTokens.set(token_id, ts);

		const findex = this.userTokensFirstIndex.get(ts[0]) ?? new Set();
		findex.add(token_id);
		this.userTokensFirstIndex.set(ts[0], findex);

		const pys = ts.flatMap((i) => this.token_pinyin_map.get(i) || []);

		this.token_pinyin_map.set(token_id, pys);
		for (const fp of pys[0]) {
			const s = this.first_pinyin_token.get(fp) ?? new Set();
			s.add(token_id);
			this.first_pinyin_token.set(fp, s);
		}

		if (this.last_result) {
			this.last_result.set(token_id, 0);
		}

		return true;
	};

	single_ci = (pinyin_input: ZiIndL): Promise<Result> => trace("candidates", {keys:pinyin_input.map(syllable => syllable[0]?.key ?? "").join(""),pinyin:pinyin_input,contextTokens:this.sequence.contextTokens.length,threads:this.context.idealThreads}, () => this.single_ci_impl(pinyin_input));
	private single_ci_impl = async (pinyin_input: ZiIndL): Promise<Result> => {
		if (pinyin_input.length === 0 || pinyin_input[0].length === 0) {
			return { candidates: [] };
		}

		if (!this.last_result) {
			return { candidates: [] };
		}

		const c: Candidate[] = [];

		await this.modelEvalLock.acquire();
		await this.fastTryOmitContext(pinyin_input.length);

		const filterByPinyin = (
			pinyin_input: ZiIndL,
			last_result: Map<ExToken, number>,
		) => syncPhase("candidate_filter", () => {
			const new_last_result = new Map<
				ExToken,
				{ py: ZiIndAndKey[]; prob: number; token: string }
			>();
			let scoreSum = 0;
			const ftokenid = new Set<number>();
			for (const firstPinyin of pinyin_input[0]) {
				const s = this.first_pinyin_token.get(firstPinyin.ind) ?? new Set();
				for (const tokenid of s) ftokenid.add(tokenid);
			}

			for (const token_id of [...ftokenid].sort((a,b)=>(last_result.get(b) ?? 0)-(last_result.get(a) ?? 0))) {
                const token_prob = last_result.get(token_id) ?? 0;
				if (!ftokenid.has(token_id)) continue;
				const token = this.detoken([token_id]);
				if (!token) continue;
				if (["\t", "\n", " "].includes(token[0])) continue;

				const token_pinyin_dy = this.token_pinyin_map.get(token_id);

				if (!token_pinyin_dy) continue;

				const token_pinyin = ziid_in_ziid(pinyin_input, token_pinyin_dy);
				if (!token_pinyin) continue;
				if (token === token_pinyin[0].ind) continue; // 排除部分英文
				new_last_result.set(token_id, {
					py: token_pinyin,
					prob: token_prob,
					token: this.detoken([token_id]),
				});
				scoreSum += token_prob;
			}
			for (const v of new_last_result.values()) {
				v.prob /= scoreSum;
			}

            // Consume the longest valid pinyin match; use model probability
            // to choose between tokens with equal coverage. Strict phonetics
            // prevents a longer fuzzy match from displacing the typed word.
            return new Map([...new_last_result].sort((a,b) =>
                b[1].py.length-a[1].py.length || b[1].prob-a[1].prob
            ));
		});
		const new_last_result = filterByPinyin(pinyin_input, this.last_result);

		// 首个候选补全为长句
		await (async () => {
			const token_id = new_last_result.keys().next().value;
			if (!token_id) return;
			const _r = new_last_result.get(token_id);
			if (!_r) return;
			const { py: token_pinyin, prob: token_prob } = _r;

			if (pinyin_input.length === token_pinyin.length) {
				this.longSentenceCache = [];
				return;
			}

			let sameCacheLen = 0;
			let pyIndex = 0;

			for (const [i, cache] of this.longSentenceCache.entries()) {
				const cpyl = cache.py;
				const inputPyl = pinyin_input.slice(pyIndex, pyIndex + cpyl.length);
				if (JSON.stringify(cpyl) !== JSON.stringify(inputPyl)) {
					break;
				}
				sameCacheLen = i + 1;
				pyIndex += cpyl.length;
			}
			let sameCache = this.longSentenceCache.slice(0, sameCacheLen);
			let rmpyx = pinyin_input.slice(
				sameCache.flatMap((i) => i.matchPY).length,
			);
			{
				const lc = this.longSentenceCache.slice(0, sameCacheLen);
				const last = lc.at(-1);
				if (last) {
					const npy = last.py.concat(rmpyx);
					const lastlast = lc.at(-2)?.nextResult || this.last_result;
					if (lastlast) {
						const f = filterByPinyin(npy, lastlast);
						const first = f.entries().next().value;
						if (first) {
							if (first[0] !== last.token.at(-1)) {
								sameCacheLen--;
								sameCache = this.longSentenceCache.slice(0, sameCacheLen);
								rmpyx = pinyin_input.slice(
									sameCache.flatMap((i) => i.matchPY).length,
								);
							}
						}
					} else {
						console.warn("no lastlast");
					}
				}
			}

			const cacheTokens = sameCache.flatMap((i) => i.token);
			// todo 下面的判断需要展开
			if (
				this.sequence.contextTokens
					.slice(
						this.lastCommitOffset,
						this.lastCommitOffset + cacheTokens.length,
					)
					.join(",") !== cacheTokens.join(",")
			) {
				console.error("长句缓存不匹配");
			}
			await this.timedErase([
				{
					start: this.lastCommitOffset + cacheTokens.length,
					end: this.sequence.contextTokens.length,
				},
			]);
			if (
				cacheTokens.at(-1) &&
				cacheTokens.at(-1) !== this.sequence.contextTokens.at(-1)
			) {
				console.error("erase error");
			}

			this.longSentenceCache = this.longSentenceCache.slice(0, sameCacheLen);

			let prob = token_prob;
			const tklppy: ZiIndAndKey[] = [...sameCache.flatMap((i) => i.matchPY)];
			const tkl: ExToken[] = [...cacheTokens];

			const select = (op: {
				py: ZiIndL;
				matchPY: ZiIndAndKey[];
				token: ExToken[];
				nextResult: Map<ExToken, number>;
			}) => {
				tklppy.push(...op.matchPY);
				tkl.push(...op.token);
				rmpyx = pinyin_input.slice(tklppy.length);

				this.longSentenceCache.push({
					py: op.py,
					matchPY: op.matchPY,
					token: op.token,
					nextResult: op.nextResult,
				});
			};

			const addToken = async (token: ExToken, generate = true) => {
				const tks = this.exTokens([token]);
                if (!generate) { await this.timedEvaluate(tks); return new Map<ExToken, number>(); }
				const r =
					(
						await this.timedEvaluate([
							...tks.slice(0, -1),
							[
								// biome-ignore lint/style/noNonNullAssertion: none
								tks.at(-1)!,
								{
									generateNext: {
										probabilities: true,
									},
								},
							],
						])
					).at(-1)?.next.probabilities || new Map<ExToken, number>(); // todo
				for (const ntk of this.userTokens.keys()) r.set(ntk, 0);
				return r;
			};

			if (this.longSentenceCache.length === 0)
				select({
					token: [token_id],
					matchPY: token_pinyin,
					py: pinyin_input.slice(0, token_pinyin.length),
					nextResult: await addToken(token_id),
				});

			const l = rmpyx.length;

			await this.fastTryOmitContext(l);

			for (let _i = 0; _i < Math.min(l, 4); _i++) {
				const lastCache = this.longSentenceCache.at(-1);
                let next = lastCache?.nextResult;
                if (lastCache && next?.size === 0) {
                    const cachedTokens = this.exTokens(lastCache.token);
                    await this.timedErase([{start:this.sequence.contextTokens.length-cachedTokens.length,end:this.sequence.contextTokens.length}]);
                    next = await addToken(lastCache.token[0]);
                    lastCache.nextResult = next;
                }
				if (!next) {
					console.log("no next");
					break;
				}
				const f = filterByPinyin(rmpyx, next);
				if (f.size > 0) {
					const first = f.entries().next().value;
					if (first) {
						prob *= first[1].prob;
						const tp = first[1];
						select({
							token: [first[0]],
							matchPY: tp.py,
							py: pinyin_input.slice(
								tklppy.length,
								tklppy.length + tp.py.length,
							),
							nextResult: await addToken(first[0], rmpyx.length > tp.py.length),
						});
						if (rmpyx.length === 0) {
							break;
						}
					}
				}
			}

			if (tkl.length > 1) {
				c.push({
					pinyin: tklppy.map((v) => v.ind),
					score: prob,
					word: this.detoken(tkl),
					remainkeys: rmpyx.map((v) => v[0].ind),
					preedit:
						tklppy.map((v) => v.preeditShow).join(" ") +
						(rmpyx.length ? " " : ""),
					consumedkeys: tklppy.map((v) => v.key).join("").length,
				});
			}
		})();

		// 常规
		for (const [
			_,
			{ py: token_pinyin, prob: token_prob, token },
		] of new_last_result) {
			const rmpy = pinyin_input.slice(token_pinyin.length).map((v) => v[0].ind);
			c.push({
				pinyin: token_pinyin.map((v) => v.ind),
				score: token_prob,
				word: token,
				remainkeys: rmpy,
				preedit:
					token_pinyin.map((v) => v.preeditShow).join(" ") +
					(rmpy.length ? " " : ""),
				consumedkeys: token_pinyin.map((v) => v.key).join("").length,
			});
		}


		syncPhase("candidate_sort", () => c.sort((a, b) => b.pinyin.length - a.pinyin.length || b.score - a.score));
		let tc = c;
		for (const f of this.afterReSort) {
			tc = f(tc);
		}

		this.omitContext.reset();

		if (c.length === 0) {
			console.log("is empty");
		}
		return { candidates: tc };
	};

	init_ctx = async () => {
		const prompt = this.pre_context;
		const tokens = this.model.tokenizer(prompt);
		const [pre, last] = [tokens.slice(0, -1), tokens.at(-1)];
		if (last === undefined) {
			throw "初始token不够";
		}
		const x = await this.timedEvaluate([
			...pre,
			[
				last,
				{
					generateNext: {
						probabilities: true,
						options: {
							topK: Infinity,
						},
					},
				},
			],
		]);
		this.last_result = x.at(-1)?.next.probabilities;
		this.lastCommitOffset = this.sequence.contextTokens.length;
	};

	getUserData = () => {
		return {
			words: Object.fromEntries(this.userTokens),
            committedContext: this.committedText,
            contextChars: Array.from(this.committedText).length,
            contextLimit: this.historyChars,
			context: this.sequence.contextTokens.map((t) => ({
				t: this.model.detokenize([t]) || "",
				token: t,
			})),
		} as UserData;
	};
	loadUserData = (data: UserData) => {
		if (this.userTokens.size > 0) {
			console.log("已存在用户数据");
			return;
		}
		// todo
		this.userTokens.clear();
		for (const [k, v] of Object.entries(data.words))
			this.userTokens.set(Number(k), v as Token[]);
	};
}

class deBounce {
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private delay: number;
	private fun = () => {};
	private cancelled = false;
	constructor(delay: number, fun: () => void) {
		this.delay = delay;
		this.fun = fun;
	}

	reset() {
		if (this.timeout) clearTimeout(this.timeout);
		if (this.cancelled) return;
		this.timeout = setTimeout(() => {
			this.fun();
		}, this.delay);
	}

	cancel() {
		if (this.timeout) clearTimeout(this.timeout);
		this.cancelled = true;
	}
}
