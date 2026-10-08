/**
 * @mesgme/opencode — ask an OpenCode Zen model for JSON matching a schema
 *
 * Holds the OpenCode API key and the model choice once per instance. The `ask`
 * method sends a prompt and a JSON Schema and stores the model's JSON answer;
 * `models` lists what the account can use. It does not validate the answer
 * against the schema: callers do that with their own zod schema.
 *
 * Routing by model id:
 * - `claude-*` → POST /messages (Anthropic format, `x-api-key`, `output_config`)
 * - `gpt-*`    → not supported (needs /responses)
 * - others     → POST /chat/completions (Bearer, one forced function tool)
 *
 * @module
 */
import { z } from "npm:zod@4";

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
}

const USER_AGENT = "mesgme-opencode/2026.10.07.1";
const MAX_TOKENS = 16000;

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
  const res = await doFetch(url, {
    ...init,
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  const text = await res.text();
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

function parseAnswer(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const head = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    throw new Error(`The answer was not JSON: ${head}`);
  }
}

/** Ask the configured model; returns the stored answer. */
export async function ask(
  args: AskArgs,
  settings: Settings,
  deps: Deps = {},
): Promise<Answer> {
  const id = settings.model;
  const messages = [{ role: "user", content: args.prompt }];
  let json: unknown;
  let inputTokens = 0;
  let outputTokens = 0;

  if (id.startsWith("gpt-")) {
    throw new Error(
      `Model "${id}" is a GPT model, which OpenCode Zen serves only through /responses. GPT models are not supported; use a Claude, DeepSeek, Kimi or GLM model.`,
    );
  } else if (id.startsWith("claude-")) {
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
    if (reply?.stop_reason !== "end_turn") {
      throw new Error(
        `${id} gave no complete answer (stop reason: ${
          reply?.stop_reason ?? "unknown"
        }).`,
      );
    }
    // deno-lint-ignore no-explicit-any
    const text = reply?.content?.find((c: any) => c.type === "text")?.text;
    if (typeof text !== "string") {
      throw new Error(`${id} returned no text block in its answer.`);
    }
    json = parseAnswer(text);
    inputTokens = reply?.usage?.input_tokens ?? 0;
    outputTokens = reply?.usage?.output_tokens ?? 0;
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
    const choice = reply?.choices?.[0];
    const call = choice?.message?.tool_calls?.[0];
    if (choice?.finish_reason === "length") {
      throw new Error(`${id} gave no complete answer (finish reason: length).`);
    }
    if (typeof call?.function?.arguments !== "string") {
      throw new Error(
        `${id} did not call the answer tool (finish reason: ${
          choice?.finish_reason ?? "unknown"
        }).`,
      );
    }
    json = parseAnswer(call.function.arguments);
    inputTokens = reply?.usage?.prompt_tokens ?? 0;
    outputTokens = reply?.usage?.completion_tokens ?? 0;
  }

  return {
    model: id,
    json,
    usage: { inputTokens, outputTokens },
    askedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
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

interface MethodContext {
  globalArgs: Settings;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The model type: `ask` stores a JSON answer, `models` stores the list of usable model ids. */
export const model = {
  type: "@mesgme/opencode",
  version: "2026.10.07.1",
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
        if (args.name === "latest") {
          throw new Error(
            'The data name "latest" is reserved by swamp; choose another `name`.',
          );
        }
        const answer = await ask(args, context.globalArgs, {
          fetch: behaviour.fetch,
        });
        const handle = await context.writeResource("answer", args.name, answer);
        return { dataHandles: [handle] };
      },
    },
    models: {
      description: "List the model ids OpenCode Zen offers this account.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const catalog = await listModels(context.globalArgs, {
          fetch: behaviour.fetch,
        });
        const handle = await context.writeResource(
          "catalog",
          "catalog",
          catalog,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
