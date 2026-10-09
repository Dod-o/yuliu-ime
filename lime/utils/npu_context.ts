import type { LlamaContext, Token } from "node-llama-cpp";
import { phase } from "./perf.ts";
export function npuContext(contextSize = 512): LlamaContext {
 let tokens: Token[] = []; let evaluated = 0;
 const cache = new Map<string, Map<Token, number>>();
 const key = Deno.readTextFileSync(new URL("../../work/local-key.txt", import.meta.url)).trim();
 const sequence = {
  get contextTokens() { return [...tokens]; },
  tokenMeter: { getState: () => ({ usedInputTokens: evaluated, usedOutputTokens: 0 }), diff: (before: { usedInputTokens: number }) => ({ usedInputTokens: evaluated-before.usedInputTokens, usedOutputTokens: 0 }) },
  async clearHistory() { tokens = []; },
  async eraseContextTokenRanges(ranges: { start: number; end: number }[]) { for (const r of [...ranges].sort((a,b)=>b.start-a.start)) tokens.splice(r.start,r.end-r.start); },
  async controlledEvaluate(items: (Token | [Token, unknown])[]) {
   const results = [];
   for (const item of items) {
    tokens.push(Array.isArray(item)?item[0]:item); evaluated++;
    if (!Array.isArray(item)) { results.push(undefined); continue; }
    const prefix = tokens.join(",");
    const cached = cache.get(prefix);
    if (cached) { results.push({next:{probabilities:cached}}); continue; }
    const response = await phase("npu_request", () => fetch("http://127.0.0.1:5001", { method:"POST", headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"}, body:JSON.stringify({tokens}) }));
    if (!response.ok) throw new Error(`NPU inference failed: ${await response.text()}`);
    const logits = new Float32Array(await response.arrayBuffer());
    let max = -Infinity; for (const v of logits) if(v>max)max=v;
    let sum=0; for(let i=0;i<logits.length;i++){ logits[i]=Math.exp(logits[i]-max); sum+=logits[i]; }
    const probabilities=new Map<Token,number>();
    for(let id=0;id<logits.length;id++)probabilities.set(id as Token,logits[id]/sum);
    cache.set(prefix,probabilities);
    if(cache.size>32)cache.delete(cache.keys().next().value!);
    results.push({next:{probabilities}});
   }
   return results;
  },
 };
 return {contextSize,currentThreads:4,idealThreads:4,batchSize:512,flashAttention:true,getSequence:()=>sequence} as unknown as LlamaContext;
}
