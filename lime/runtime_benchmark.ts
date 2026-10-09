import {getLlama} from "node-llama-cpp";
const llama=await getLlama({gpu:false});
const fixtures=JSON.parse(await Deno.readTextFile('../work/token-fixtures.json')) as {text:string;tokens:number[]}[];
const results:unknown[]=[];
for(const quant of ['IQ4_XS','Q4_0']){
 const model=await llama.loadModel({modelPath:`../models/Qwen3-0.6B-${quant}.gguf`});
 const context=await model.createContext({contextSize:512,threads:4});
 const seq=context.getSequence();
 for(const fixture of fixtures){
  for(let repeat=0;repeat<3;repeat++){
   await seq.clearHistory();
   const t=performance.now();
   const ids=model.tokenize(fixture.text);
   const r=await seq.controlledEvaluate([...ids.slice(0,-1),[ids.at(-1)!,{generateNext:{probabilities:true,options:{topK:Infinity}}}]]);
   const row={runtime:'node-llama-cpp',quant,text:fixture.text,repeat,input_tokens:ids.length,ms:Math.round((performance.now()-t)*10)/10,probability_count:r.at(-1)?.next.probabilities?.size};
   results.push(row);console.log(JSON.stringify(row));
  }
 }
 await context.dispose();await model.dispose();
}
await Deno.writeTextFile('../work/runtime-benchmark.json',JSON.stringify(results,null,2));
