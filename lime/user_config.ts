import path from "node:path";
import { fileURLToPath } from "node:url";
import { load_pinyin } from "./key_map/pinyin/gen_zi_pinyin.ts";
import { keys_to_pinyin } from "./key_map/pinyin/keys_to_pinyin.ts";
import { initLIME } from "./main.ts";
import type { Config } from "./utils/config.d.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: Config = {
	runner: await initLIME({
		ziInd: load_pinyin(),
		modelPath: path.join(__dirname, "../models/" + (Deno.env.get("LIME_MODEL") ?? "Qwen3-1.7B-Q4_0.gguf")),
		omitContext: false,
		afterReSort: [],
	}),
	key2ZiInd: (key: string) =>
		keys_to_pinyin(key, {
			shuangpin: false,
			fuzzy: {},
		}),
	userWordsPath: path.join(__dirname, "userword/preload_word.txt"),
};

export default config;
