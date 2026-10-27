/**
 * @puddleworks/opencode — ask an OpenCode Zen model for JSON matching a schema
 *
 * Holds the OpenCode API key and the model choice once per instance. The `ask`
 * method sends a prompt and a JSON Schema and stores the model's JSON answer;
 * `models` lists what the account can use. `ask` validates the answer against
 * the supplied schema and retries rejected answers with feedback.
 *
 * Routing by model id:
 * - `claude-*` → POST /messages (Anthropic format, `x-api-key`, `output_config`)
 * - `gpt-*`    → not supported (needs /responses)
 * - others     → POST /chat/completions (Bearer, one forced function tool)
 *
 * @module
 */
import { z } from "npm:zod@4";
import { Validator } from "npm:@cfworker/json-schema@4.1.1";

/** Base URL of the OpenCode Zen API, used when `baseUrl` is not set. */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

/** Settings fixed once per model instance. */
export const GlobalArgsSchema = z.object({
  apiKey: z.string().min(1).meta({
    sensitive: true,
    description: "OpenCode API key. Reference it from a vault.",
  }),
  model: z.string().min(1).describe(
    "OpenCode Zen model id, e.g. deepseek-v4.1-flash or claude-opus-5-5.",
  ),
  baseUrl: z.string().min(1).default(DEFAULT_BASE_URL).describe(
    "OpenCode Zen base URL.",
  ),
  timeoutMs: z.number().int().positive().default(120000).describe(
    "Give up on a request after this many milliseconds.",
  ),
});
/** The settings of one model instance. */
export type Settings = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `ask`: optional system prompt, the prompt, the JSON Schema the answer must follow, and the data name to store it under. */
export const AskArgsSchema = z.object({
  system: z.string().optional().describe("System prompt."),
  prompt: z.string().describe("The user prompt."),
  schema: z.record(z.string(), z.unknown()).describe(
    "JSON Schema the answer must follow.",
  ),
  maxAttempts: z.number().int().min(1).max(5).default(2).describe(
    "Maximum answer attempts for invalid or incomplete responses.",
  ),
  name: z.string().min(1).default("answer").describe(
    "Data name to store the answer under. `latest` is reserved.",
  ),
});
/** The arguments `ask` accepts. */
export type AskArgs = z.infer<typeof AskArgsSchema>;

/** A model's JSON answer to one `ask`, with the model used and token counts. */
export const AnswerSchema = z.object({
  model: z.string(),
  json: z.unknown(),
  attempts: z.number().int().positive(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  askedAt: z.iso.datetime(),
});
/** The stored answer of one `ask`. */
export type Answer = z.infer<typeof AnswerSchema>;

/** The model ids the account can use, and when they were fetched. */
export const CatalogSchema = z.object({
  models: z.array(z.string()),
  fetchedAt: z.iso.datetime(),
});
/** The stored result of `models`. */
export type Catalog = z.infer<typeof CatalogSchema>;

/** What the methods reach outside for. Tests replace these. */
export interface Deps {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

// Keep in step with `model.version` below (a test checks it).
const VERSION = "2026.10.09.1";
const USER_AGENT = `puddleworks-opencode/${VERSION}`;
const MAX_TOKENS = 16000;
// 429 and 503 are retried after Retry-After (1s when absent, at most 30s).
const BUSY_STATUSES = [429, 503];
const MAX_TRIES = 3;
const MAX_WAIT_MS = 30000;
// Data names `ask` must not use: swamp reserves `latest`, `models` stores `catalog`.
const RESERVED_NAMES = ["latest", "catalog"];

function waitMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds * 1000, MAX_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Reply {
  ok: boolean;
  status: number;
  // deno-lint-ignore no-explicit-any
  json: any;
  text: string;
}

async function send(
  url: string,
  init: RequestInit,
  settings: Settings,
  deps: Deps,
): Promise<Reply> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  let res: Response;
  let text: string;
  for (let tries = 1;; tries++) {
    res = await doFetch(url, {
      ...init,
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    text = await res.text();
    if (!BUSY_STATUSES.includes(res.status) || tries === MAX_TRIES) break;
    await (deps.sleep ?? sleep)(waitMs(res.headers.get("retry-after")));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    // deno-lint-ignore no-explicit-any
    const why = (json as any)?.error?.message || (json as any)?.message ||
      text.trim() || res.statusText;
    throw new Error(
      `OpenCode Zen refused the request (HTTP ${res.status}): ${why}`,
    );
  }
  return { ok: true, status: res.status, json, text };
}

function base(settings: Settings): string {
  return settings.baseUrl.replace(/\/+$/, "");
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

class RejectedAnswer extends Error {
  readonly raw: string;
  constructor(reason: string, raw: string, readonly usage: TokenUsage) {
    super(reason);
    this.raw = raw.slice(0, 2048);
  }
}

function parseAnswer(text: string, usage: TokenUsage): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const head = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    throw new RejectedAnswer(`The answer was not JSON: ${head}`, text, usage);
  }
}

function rawAnswer(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "") ?? "";
}

interface Message {
  role: "user";
  content: string;
}

/** One request. Only answer-shape failures become RejectedAnswer. */
async function askOnce(
  messages: Message[],
  args: AskArgs,
  settings: Settings,
  deps: Deps,
  validator: Validator,
): Promise<{ json: unknown; usage: TokenUsage }> {
  const id = settings.model;
  if (id.startsWith("gpt-")) {
    throw new Error(
      `Model "${id}" is a GPT model, which OpenCode Zen serves only through /responses. GPT models are not supported; use a Claude, DeepSeek, Kimi or GLM model.`,
    );
  }

  let raw: string;
  let usage: TokenUsage;
  if (id.startsWith("claude-")) {
    const { json: reply } = await send(
      `${base(settings)}/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          model: id,
          max_tokens: MAX_TOKENS,
          ...(args.system ? { system: args.system } : {}),
          messages,
          output_config: {
            format: { type: "json_schema", schema: args.schema },
          },
        }),
      },
      settings,
      deps,
    );
    usage = {
      inputTokens: reply?.usage?.input_tokens ?? 0,
      outputTokens: reply?.usage?.output_tokens ?? 0,
    };
    // deno-lint-ignore no-explicit-any
    const text = reply?.content?.find((c: any) => c.type === "text")?.text;
    raw = rawAnswer(text ?? reply?.content);
    if (reply?.stop_reason !== "end_turn") {
      throw new RejectedAnswer(
        `${id} gave no complete answer (stop reason: ${
          reply?.stop_reason ?? "unknown"
        }).`,
        raw,
        usage,
      );
    }
    if (typeof text !== "string") {
      throw new RejectedAnswer(
        `${id} returned no text block in its answer.`,
        raw,
        usage,
      );
    }
  } else {
    const { json: reply } = await send(
      `${base(settings)}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          model: id,
          messages: args.system
            ? [{ role: "system", content: args.system }, ...messages]
            : messages,
          tools: [{
            type: "function",
            function: {
              name: "answer",
              description: "Return the answer in this shape.",
              parameters: args.schema,
            },
          }],
          tool_choice: "required",
        }),
      },
      settings,
      deps,
    );
    usage = {
      inputTokens: reply?.usage?.prompt_tokens ?? 0,
      outputTokens: reply?.usage?.completion_tokens ?? 0,
    };
    const choice = reply?.choices?.[0];
    const call = choice?.message?.tool_calls?.[0];
    raw = rawAnswer(
      call?.function?.arguments ?? choice?.message?.content ?? choice?.message,
    );
    if (choice?.finish_reason === "length") {
      throw new RejectedAnswer(
        `${id} gave no complete answer (finish reason: length).`,
        raw,
        usage,
      );
    }
    if (typeof call?.function?.arguments !== "string") {
      throw new RejectedAnswer(
        `${id} did not call the answer tool (finish reason: ${
          choice?.finish_reason ?? "unknown"
        }).`,
        raw,
        usage,
      );
    }
  }

  const json = parseAnswer(raw, usage);
  const result = validator.validate(json);
  if (!result.valid) {
    const reason = result.errors.map((error) =>
      `${error.instanceLocation || "#"}: ${error.error}`
    ).join("; ");
    throw new RejectedAnswer(
      `The answer does not match the schema: ${reason}`,
      raw,
      usage,
    );
  }
  return { json, usage };
}

/** Ask the configured model, retrying malformed answers with feedback. */
export async function ask(
  args: AskArgs,
  settings: Settings,
  deps: Deps = {},
): Promise<Answer> {
  const validator = new Validator(args.schema);
  const originalMessage: Message = { role: "user", content: args.prompt };
  let feedback: Message | undefined;
  const maxAttempts = args.maxAttempts ?? 2;
  const reasons: string[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const answer = await askOnce(
        feedback ? [originalMessage, feedback] : [originalMessage],
        args,
        settings,
        deps,
        validator,
      );
      usage.inputTokens += answer.usage.inputTokens;
      usage.outputTokens += answer.usage.outputTokens;
      return {
        model: settings.model,
        json: answer.json,
        attempts: attempt,
        usage,
        askedAt: (deps.now ?? (() => new Date()))().toISOString(),
      };
    } catch (error) {
      if (!(error instanceof RejectedAnswer)) throw error;
      usage.inputTokens += error.usage.inputTokens;
      usage.outputTokens += error.usage.outputTokens;
      reasons.push(error.message);
      if (attempt < maxAttempts) {
        feedback = {
          role: "user",
          content:
            `Your previous answer was rejected: ${error.message}.\nPrevious answer:\n${error.raw}\nAnswer again, following the schema exactly.`,
        };
      }
    }
  }
  throw new Error(
    `${settings.model} gave no valid answer after ${maxAttempts} attempt${
      maxAttempts === 1 ? "" : "s"
    }: ${reasons.at(-1)}${
      reasons.length > 1
        ? ` (all reasons: ${reasons.map((r, i) => `${i + 1}. ${r}`).join(" ")})`
        : ""
    }`,
  );
}

/** List the model ids the account can use. */
export async function listModels(
  settings: Settings,
  deps: Deps = {},
): Promise<Catalog> {
  const { json } = await send(
    `${base(settings)}/models`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "user-agent": USER_AGENT,
      },
    },
    settings,
    deps,
  );
  // deno-lint-ignore no-explicit-any
  const models: string[] = (json?.data ?? []).map((m: any) => m.id).filter((
    id: unknown,
  ) => typeof id === "string");
  return {
    models,
    fetchedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

/** What the methods call. Tests swap `fetch` here to check the wiring. */
export const behaviour: { fetch: typeof globalThis.fetch } = {
  fetch: globalThis.fetch,
};

type Log = (message: string, props?: Record<string, unknown>) => void;

interface MethodContext {
  globalArgs: Settings;
  logger: { info: Log; warning: Log };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The model type: `ask` stores a JSON answer, `models` stores the list of usable model ids. */
export const model = {
  type: "@puddleworks/opencode",
  version: "2026.10.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    answer: {
      description:
        "A model's JSON answer to one ask, with the model used and token counts.",
      schema: AnswerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    catalog: {
      description: "The model ids OpenCode Zen offers this account.",
      schema: CatalogSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    ask: {
      description:
        "Send a prompt and a JSON Schema to the configured model and store its JSON answer under `name`.",
      arguments: AskArgsSchema,
      execute: async (args: AskArgs, context: MethodContext) => {
        if (RESERVED_NAMES.includes(args.name)) {
          throw new Error(
            `The data name "${args.name}" is reserved (swamp keeps "latest"; the models method stores "catalog"); choose another \`name\`.`,
          );
        }
        context.logger.info(
          "Asking {model} for JSON (up to {maxAttempts} attempts)",
          { model: context.globalArgs.model, maxAttempts: args.maxAttempts },
        );
        const answer = await ask(args, context.globalArgs, {
          fetch: behaviour.fetch,
        });
        const handle = await context.writeResource("answer", args.name, answer);
        context.logger.info(
          "{model} answered (attempts: {attempts}, tokens in: {inputTokens}, out: {outputTokens}); stored as {name}",
          {
            model: answer.model,
            attempts: answer.attempts,
            inputTokens: answer.usage.inputTokens,
            outputTokens: answer.usage.outputTokens,
            name: args.name,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    models: {
      description: "List the model ids OpenCode Zen offers this account.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        context.logger.info("Listing the models at {baseUrl}", {
          baseUrl: context.globalArgs.baseUrl,
        });
        const catalog = await listModels(context.globalArgs, {
          fetch: behaviour.fetch,
        });
        const handle = await context.writeResource(
          "catalog",
          "catalog",
          catalog,
        );
        context.logger.info("Stored {count} model ids", {
          count: catalog.models.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
