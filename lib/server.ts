import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import config from "../config/config.json";
import { DownloadTaskInput, DownloadTaskResult, DownloadType, runDownloadTask } from "./index";

interface ApiRateLimitConfig {
  windowMs?: number;
  max?: number;
}

interface ApiConfig {
  apiKey?: string;
  port?: number;
  rateLimit?: ApiRateLimitConfig;
}

type JobStatus = "queued" | "running" | "completed" | "failed";

interface ApiJob {
  id: string;
  status: JobStatus;
  input: DownloadTaskInput;
  createdAt: string;
  updatedAt: string;
  result?: DownloadTaskResult;
  error?: string;
}

interface RateLimitBucket {
  windowStart: number;
  count: number;
}

const apiConfig = ((config as { api?: ApiConfig }).api ?? {}) as ApiConfig;
const apiKey = (process.env.TIKTOK_API_KEY ?? apiConfig.apiKey)?.trim();
const apiPort = Number(process.env.PORT ?? apiConfig.port ?? 3000);
const rateLimitWindowMs = apiConfig.rateLimit?.windowMs ?? 60_000;
const rateLimitMax = apiConfig.rateLimit?.max ?? 30;
const maxBodyBytes = 1024 * 1024;
const jobs = new Map<string, ApiJob>();
const queue: ApiJob[] = [];
const rateLimitBuckets = new Map<string, RateLimitBucket>();
let queueRunning = false;

const forbiddenBodyKeys = new Set([
  "odin_tt",
  "passport_csrf_token",
  "sessionid",
  "cookie",
  "cookies",
  "apiKey",
  "api_key",
]);

const sendJson = (res: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
};

const getClientIp = (req: IncomingMessage) => {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) return forwardedFor.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
};

const getApiKeyFromRequest = (req: IncomingMessage) => {
  const headerApiKey = req.headers["x-api-key"];
  if (typeof headerApiKey === "string") return headerApiKey;

  const authorization = req.headers.authorization ?? "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1];
};

const checkRateLimit = (req: IncomingMessage) => {
  if (rateLimitMax <= 0) return null;

  const now = Date.now();
  const requestApiKey = getApiKeyFromRequest(req) ?? "anonymous";
  const bucketKey = `${getClientIp(req)}:${requestApiKey}`;
  const current = rateLimitBuckets.get(bucketKey);

  if (!current || now - current.windowStart >= rateLimitWindowMs) {
    rateLimitBuckets.set(bucketKey, { windowStart: now, count: 1 });
    return null;
  }

  current.count += 1;
  if (current.count <= rateLimitMax) return null;

  const retryAfterMs = Math.max(rateLimitWindowMs - (now - current.windowStart), 0);
  return Math.ceil(retryAfterMs / 1000);
};

const assertAuthorized = (req: IncomingMessage) => {
  const requestApiKey = getApiKeyFromRequest(req);
  return !!apiKey && requestApiKey === apiKey;
};

const readJsonBody = async (req: IncomingMessage) => {
  let body = "";

  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) {
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }
  }

  if (!body.trim()) return {};
  return JSON.parse(body);
};

const validateDownloadInput = (body: unknown): DownloadTaskInput => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("请求体必须是 JSON 对象");
  }

  for (const key of Object.keys(body)) {
    if (forbiddenBodyKeys.has(key)) {
      throw new Error(`${key} 应在本地 config/config.json 中配置，不应通过 API 传入`);
    }
  }

  const { user, type, limit, username } = body as Record<string, unknown>;

  if (typeof user !== "string" || user.trim().length === 0) {
    throw new Error("user 必须是非空字符串");
  }

  if (type !== "post" && type !== "like") {
    throw new Error("type 必须是 post 或 like");
  }

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
    throw new Error("limit 必须是大于等于 0 的整数，0 表示无限制");
  }

  if (username !== undefined && (typeof username !== "string" || username.trim().length === 0)) {
    throw new Error("username 必须是非空字符串");
  }

  return {
    user: user.trim(),
    type: type as DownloadType,
    limit,
    username: typeof username === "string" ? username.trim() : undefined,
  };
};

const runNextJob = async () => {
  if (queueRunning) return;

  const job = queue.shift();
  if (!job) return;

  queueRunning = true;
  job.status = "running";
  job.updatedAt = new Date().toISOString();

  try {
    job.result = await runDownloadTask(job.input, jobs.size);
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    job.updatedAt = new Date().toISOString();
    queueRunning = false;
    void runNextJob();
  }
};

const enqueueJob = (input: DownloadTaskInput) => {
  const now = new Date().toISOString();
  const job: ApiJob = {
    id: randomUUID(),
    status: "queued",
    input,
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(job.id, job);
  queue.push(job);
  void runNextJob();
  return job;
};

const handleDownload = async (req: IncomingMessage, res: ServerResponse) => {
  let body: unknown;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    const statusCode = error instanceof Error && error.message === "REQUEST_BODY_TOO_LARGE" ? 413 : 400;
    sendJson(res, statusCode, { error: "请求体必须是合法 JSON，且大小不能超过 1MB" });
    return;
  }

  try {
    const input = validateDownloadInput(body);
    const job = enqueueJob(input);
    sendJson(res, 202, {
      id: job.id,
      status: job.status,
      statusUrl: `/api/tasks/${job.id}`,
    });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
};

const handleGetJob = (jobId: string, res: ServerResponse) => {
  const job = jobs.get(jobId);
  if (!job) {
    sendJson(res, 404, { error: "任务不存在" });
    return;
  }

  sendJson(res, 200, job);
};

export const createApiServer = () => {
  if (!apiKey) {
    throw new Error("请先在 config/config.json 中配置 api.apiKey，再启动 API 服务");
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    const retryAfter = checkRateLimit(req);
    if (retryAfter !== null) {
      sendJson(
        res,
        429,
        { error: "请求过于频繁，请稍后再试" },
        { "Retry-After": String(retryAfter) }
      );
      return;
    }

    if (!assertAuthorized(req)) {
      sendJson(res, 401, { error: "无效或缺失 API key" });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/download" || url.pathname === "/api/tasks")) {
      await handleDownload(req, res);
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "GET" && taskMatch) {
      handleGetJob(taskMatch[1], res);
      return;
    }

    sendJson(res, 404, { error: "接口不存在" });
  });
};

if (require.main === module) {
  const server = createApiServer();
  server.listen(apiPort, () => {
    console.log(`API 服务已启动: http://localhost:${apiPort}`);
  });
}
