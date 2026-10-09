import net from "node:net";
import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { verifyKey } from "./key.ts";
import {
	decryptJsonWithSavedKey,
	encryptJson,
	HIAE_ENCRYPTION_HEADER,
	HIAE_ENCRYPTION_VERSION,
	type SecurePayload,
} from "./utils/secure_payload.ts";
import type { Config } from "./utils/config.d.ts";

// Fail closed if the selected NPU backend cannot load.
const config: Config = (await import("./user_config.ts")).default;

const { single_ci, commit, getUserData, addUserWord } = config.runner;

function arrayLimtPush<T>(arr: T[], item: T, maxLen: number) {
	arr.push(item);
	if (arr.length <= maxLen) return;
	for (let i = 0; i < arr.length - maxLen; i++) {
		arr.shift();
	}
}

const inputLogMaxLen = 10 ** 5;
export const inputLog: {
	keyDeltaTimes: Array<number>;
	lastKeyTime: number | null;
	ziDeltaTimes: Array<number>;
	lastZiTime: number | null;
	ziCount: number;
	lastCandidates: {
		time: number;
		candidates: string[];
	};
	offsetTimes: Record<number, Array<number>>;
	history: string; // 与直接从模型获取记录不同，模型有上下文限制，这里记录所有输入的文本，供后续微调使用
} = {
	keyDeltaTimes: [],
	lastKeyTime: null,
	ziDeltaTimes: [],
	lastZiTime: null,
	ziCount: 0,
	lastCandidates: {
		time: 0,
		candidates: [],
	},
	offsetTimes: {},
	history: "",
};

try {
	const words = Deno.readTextFileSync(config.userWordsPath)
		.split("\n")
		.filter((w) => w.trim());
	const textEncoder = new TextEncoder();
	for (const [i, w] of words.entries()) {
		addUserWord(w);
		Deno.stdout.writeSync(
			textEncoder.encode(
				`加载用户词 ${(((i + 1) / words.length) * 100).toFixed(2)}%\r`,
			),
		);
	}
	console.log(`\n加载用户词完成，数量 ${words.length}`);
} catch {
	//
}

const app = new Hono();
const api = new Hono();
api.use("/*", async (c, next) => {
	const path = new URL(c.req.url).pathname;
	const isEncryptedInputRequest = c.req.method === "POST" &&
		c.req.header(HIAE_ENCRYPTION_HEADER) === HIAE_ENCRYPTION_VERSION &&
		(path.endsWith("/candidates") || path.endsWith("/commit"));
	if (isEncryptedInputRequest) {
		return next();
	}

	const middleware = bearerAuth({
		verifyToken: (t) => {
			return verifyKey(t);
		},
	});
	return middleware(c, next);
});

// A single model context is shared; serialize mutations across both frontends.
let pending = Promise.resolve();
api.use("*", async (_c,next) => {
 const previous=pending;
 const slot=Promise.withResolvers<void>();
 pending=slot.promise;
 await previous;
 try { await next(); } finally {slot.resolve();}
});
api.use("*", logger());

async function readRequestJson<T>(
	c: Context,
): Promise<{ body: T; responseKey?: Uint8Array }> {
	if (c.req.header(HIAE_ENCRYPTION_HEADER) !== HIAE_ENCRYPTION_VERSION) {
		return { body: await c.req.json<T>() };
	}

	const payload = await c.req.json<SecurePayload>();
	const decrypted = await decryptJsonWithSavedKey<T>(payload);
	if (!decrypted) {
		throw new HTTPException(401, { message: "HiAE 请求认证失败" });
	}
	return { body: decrypted.value, responseKey: decrypted.key };
}

function jsonResponse(c: Context, value: unknown, key?: Uint8Array) {
	if (!key) return c.json(value);
	c.header(HIAE_ENCRYPTION_HEADER, HIAE_ENCRYPTION_VERSION);
	return c.json(encryptJson(value, key));
}

api.post("/context", async (c) => {
 const {text = ""} = await c.req.json<{text?: string}>();
 await config.runner.reset_context();
 if(text) await commit(text);
 await config.runner.getEvalResult();
 return c.json({device:"HTP0",model:Deno.env.get("LIME_MODEL") ?? "Qwen3-1.7B-Q4_0.gguf",ready:true});
});

api.post("/candidates", async (c) => {
	const { body, responseKey } = await readRequestJson<{ keys?: string; context?: string }>(c);
	const keys = body.keys || "";
    if (typeof body.context === "string") await config.runner.sync_context(body.context);

	console.log(keys);
	const time = Date.now();
	if (inputLog.lastKeyTime === null || keys.length === 1) {
		inputLog.lastKeyTime = time;
		inputLog.lastZiTime = time;
	} else {
		arrayLimtPush(
			inputLog.keyDeltaTimes,
			time - inputLog.lastKeyTime,
			inputLogMaxLen,
		);
		inputLog.lastKeyTime = time;
	}

	const pinyinInput = config.key2ZiInd(keys);
	const result = await single_ci(pinyinInput);

	if (result.candidates.length <= 1) {
		inputLog.lastZiTime = null;
	} else
		inputLog.lastCandidates = {
			time,
			candidates: result.candidates.map((c) => c.word),
		};

	return jsonResponse(c, result, responseKey);
});

api.post("/commit", async (c) => {
	try {
		const { body, responseKey } = await readRequestJson<{
			text?: string;
            context?: string;
			new?: boolean;
			update?: boolean;
		}>(c);
		const text = body.text || "";
		const isNew = body.new ?? true;
		const shouldUpdate = body.update ?? false;

		if (!text) {
			throw new HTTPException(400, { message: "未提供文本内容" });
		}

		if (typeof body.context === "string") await config.runner.sync_context(body.context);
        const newT = await commit(text, shouldUpdate, isNew);

		if (isNew) {
			if (inputLog.lastZiTime !== null)
				arrayLimtPush(
					inputLog.ziDeltaTimes,
					(Date.now() - inputLog.lastZiTime) / text.length,
					inputLogMaxLen,
				);
			inputLog.lastZiTime = null;
			inputLog.lastKeyTime = null;
			inputLog.ziCount += text.length;
			inputLog.history += text;
		}
		{
			const offset = inputLog.lastCandidates.candidates.indexOf(newT ?? "");
			if (offset !== -1 && inputLog.lastCandidates.time !== 0) {
				const time = Date.now();
				const ofts = inputLog.offsetTimes[offset] || [];
				arrayLimtPush(
					ofts,
					time - inputLog.lastCandidates.time,
					inputLogMaxLen,
				);
				inputLog.offsetTimes[offset] = ofts;
			}
			inputLog.lastCandidates = {
				time: 0,
				candidates: [],
			};
		}

		return jsonResponse(
			c,
			{
				message: "文本提交成功",
			},
			responseKey,
		);
	} catch (error) {
		if (error instanceof HTTPException) throw error;
		console.error("提交文本失败:", error);
		throw new HTTPException(400, { message: "请求数据格式错误" });
	}
});

api.get("/userdata", (c) => {
	return c.json(getUserData());
});

api.get("/inputlog", (c) => {
	return c.json(inputLog);
});

api.post("/learntext", async (c) => {
	const body = await c.req.text();
	await commit(body, true, true);
	return c.json({
		message: "文本提交成功",
	});
});

try {
	Deno.statSync("./interface/dist");
} catch {
	console.log(
		"没有构建前端，一些服务器页面可能不显示（不影响输入法），如果需要，运行：\ndeno run install_interface\ndeno run build_interface\n然后重启服务器",
	);
}

app.use(
	"*",
	cors({
		origin: "*",
	}),
);

app.use("/*", serveStatic({ root: "./interface/dist" }));

app.route("/api", api);

app.post("/candidates", (c) => {
	return api.fetch(c.req.raw);
});

app.post("/commit", (c) => {
	return api.fetch(c.req.raw);
});

// Rime Lua can open a Windows named pipe directly, avoiding per-key subprocesses.
const pipeServer=net.createServer((socket)=>{
 socket.setEncoding("utf8");
 let buffer=""; let chain=Promise.resolve();
 socket.on("error",()=>{});
 socket.on("data",chunk=>{
  buffer+=chunk;
  if(buffer.length>1024*1024){socket.destroy();return;}
  let newline;
  while((newline=buffer.indexOf("\n"))>=0){
   const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
   chain=chain.then(async()=>{
    try {
     const message=JSON.parse(line);
     if(!["candidates","commit","context"].includes(message.route))throw Error("Invalid route");
     const response=await app.request("http://localhost/api/"+message.route,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+message.key},body:JSON.stringify(message.body)});
     socket.write(JSON.stringify({code:response.status,body:await response.text()})+"\n");
    }catch {socket.write(JSON.stringify({code:500,body:"{}"})+"\n");}
   });
  }
 });
});
pipeServer.listen("\\\\.\\pipe\\lime-npu");
pipeServer.on("error",error=>console.error("Rime pipe failed",error));

export default app;
