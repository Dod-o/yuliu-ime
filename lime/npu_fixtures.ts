import { getLlama } from "node-llama-cpp";
const llama=await getLlama({gpu:false});
const model=await llama.loadModel({modelPath:"../models/Qwen3-0.6B-Q4_0.gguf"});
const texts=["下面的内容主题多样","下面的内容主题多样你好","今天天气"];
const fixtures=texts.map(text=>({text,tokens:model.tokenize(text)}));
await Deno.writeTextFile("../work/token-fixtures.json",JSON.stringify(fixtures,null,2));
await model.dispose();
