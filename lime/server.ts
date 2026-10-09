import { trace } from "./utils/perf.ts";
import { AdvancedIME, type Query } from "./ime/engine.ts";
import net from "node:net";
import { type Context, Hono } from "hono";
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

const { addUserWord } = config.runner;
const advanced = new AdvancedIME(config.runner);

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
  const { text = "" } = await c.req.json<{ text?: string }>();
  advanced.setContext(text);
  return c.json({ device: "HTP0", ready: true });
});
api.post("/candidates", async (c) => {
  const { body, responseKey } = await readRequestJson<Query>(c);
  return jsonResponse(
    c,
    await trace("candidate_initial", {
      keyChars: body.keys?.length ?? 0,
      contextChars: Array.from(body.context ?? " ").length,
      progressive: !!body.progressive,
    }, () => advanced.query(body)),
    responseKey,
  );
});
api.get("/results/:id", async (c) => {
  const result = c.req.query("wait") === "1"
    ? await advanced.waitResult(c.req.param("id"))
    : advanced.getResult(c.req.param("id"));
  return result ? c.json(result) : c.json({ error: "expired" }, 404);
});
api.post("/commit", async (c) => {
  const { body, responseKey } = await readRequestJson<
    { text?: string; context?: string; keys?: string; selected?: boolean }
  >(c);
  if (typeof body.text !== "string" || !body.text) {
    throw new HTTPException(400, { message: "未提供文本内容" });
  }
  return jsonResponse(c, advanced.commit(body), responseKey);
});
api.get("/userdata", (c) => c.json(advanced.data()));
api.get("/learning", (c) => c.json(advanced.learning.list()));
api.post("/learning", async (c) => {
  const { action, id } = await c.req.json<{ action: string; id?: string }>();
  return c.json(advanced.changeLearning(action, id));
});
api.get("/inputlog", (c) => {
  return c.json(inputLog);
});

api.post("/learntext", async (c) => {
  const body = await c.req.text();
  advanced.commit({ text: body, context: "" });
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
const pipeServer = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let chain = Promise.resolve();
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      socket.destroy();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      chain = chain.then(async () => {
        try {
          const message = JSON.parse(line);
          if (
            !["candidates", "commit", "context", "result", "learning"].includes(
              message.route,
            )
          ) throw Error("Invalid route");
          const isResult = message.route === "result";
          const response = await app.request(
            "http://localhost/api/" +
              (isResult
                ? "results/" + encodeURIComponent(message.body.id) +
                  (message.body.wait ? "?wait=1" : "")
                : message.route),
            {
              method: isResult ? "GET" : "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + message.key,
              },
              ...(isResult ? {} : { body: JSON.stringify(message.body) }),
            },
          );
          socket.write(
            JSON.stringify({
              code: response.status,
              body: await response.text(),
            }) + "\n",
          );
        } catch {
          socket.write(JSON.stringify({ code: 500, body: "{}" }) + "\n");
        }
      });
    }
  });
});
pipeServer.listen("\\\\.\\pipe\\lime-npu");
pipeServer.on("error", (error) => console.error("Rime pipe failed", error));

export default app;
