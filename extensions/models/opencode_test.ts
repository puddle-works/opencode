/**
 * Tests for @puddleworks/opencode.
 *
 * Run with: make test
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  ask,
  type AskArgs,
  AskArgsSchema,
  GlobalArgsSchema,
  listModels,
  model,
  type Settings,
} from "./opencode.ts";

const SCHEMA = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
};
const SETTINGS: Settings = {
  apiKey: "test-key",
  model: "deepseek-v4.1-flash",
  baseUrl: "https://opencode.ai/zen/v1",
  timeoutMs: 120000,
};
const ARGS: AskArgs = {
  system: "Be brief.",
  prompt: "Give n.",
  schema: SCHEMA,
  name: "answer",
  maxAttempts: 2,
};
const NOW = () => new Date("2026-10-07T10:00:00Z");

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | null;
}

/** A fetch answering every call with `reply` and `status`, recording the requests. */
function fakeApi(reply: unknown | unknown[], status = 200) {
  const replies = Array.isArray(reply) ? [...reply] : null;
  const calls: Call[] = [];
  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    const text = await req.text();
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
      signal: init?.signal ?? null,
    });
    const current = replies ? replies.shift() : reply;
    return typeof current === "string"
      ? new Response(current, { status })
      : Response.json(current, { status });
  };
  return { calls, deps: { fetch, now: NOW } };
}

const chatReply = (
  args: unknown = '{"n":1}',
  extra: Record<string, unknown> = {},
) => ({
  choices: [{
    finish_reason: "tool_calls",
    message: {
      tool_calls: [{
        type: "function",
        function: { name: "answer", arguments: args },
      }],
      ...extra,
    },
  }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

const messagesReply = (text = '{"n":2}', stop = "end_turn") => ({
  stop_reason: stop,
  content: [{ type: "text", text }],
  usage: { input_tokens: 5, output_tokens: 3 },
});

Deno.test("settings: model required, defaults applied, apiKey sensitive", () => {
  assertEquals(GlobalArgsSchema.safeParse({ apiKey: "k" }).success, false);
  const parsed = GlobalArgsSchema.parse({ apiKey: "k", model: "m" });
  assertEquals(parsed.baseUrl, "https://opencode.ai/zen/v1");
  assertEquals(parsed.timeoutMs, 120000);
  assertEquals(GlobalArgsSchema.shape.apiKey.meta()?.sensitive, true);
});

Deno.test("ask arguments default name to answer and make system optional", () => {
  const a = AskArgsSchema.parse({ prompt: "p", schema: SCHEMA });
  assertEquals(a.name, "answer");
  assertEquals(a.maxAttempts, 2);
  assertEquals(
    AskArgsSchema.safeParse({ prompt: "p", schema: SCHEMA, maxAttempts: 0 })
      .success,
    false,
  );
  assertEquals(
    AskArgsSchema.safeParse({ prompt: "p", schema: SCHEMA, maxAttempts: 6 })
      .success,
    false,
  );
  assertEquals(a.system, undefined);
});

Deno.test("chat route: URL, bearer auth, tool wiring and result", async () => {
  const api = fakeApi(chatReply());
  const out = await ask(ARGS, SETTINGS, api.deps);
  assertEquals(api.calls.length, 1);
  const { url, method, headers, body, signal } = api.calls[0];
  assertEquals(url, "https://opencode.ai/zen/v1/chat/completions");
  assertEquals(method, "POST");
  assertEquals(headers.get("authorization"), "Bearer test-key");
  assertEquals(headers.get("x-api-key"), null);
  assertEquals(body?.model, "deepseek-v4.1-flash");
  assertEquals(body?.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Give n." },
  ]);
  assertEquals(body?.tools, [{
    type: "function",
    function: {
      name: "answer",
      description: "Return the answer in this shape.",
      parameters: SCHEMA,
    },
  }]);
  assertEquals(body?.tool_choice, "required");
  assertEquals(signal !== null, true);
  assertEquals(out, {
    model: "deepseek-v4.1-flash",
    json: { n: 1 },
    attempts: 1,
    usage: { inputTokens: 11, outputTokens: 7 },
    askedAt: "2026-10-07T10:00:00.000Z",
  });
});

Deno.test("chat route omits the system message when none is given", async () => {
  const api = fakeApi(chatReply());
  await ask({ ...ARGS, system: undefined }, SETTINGS, api.deps);
  assertEquals(api.calls[0].body?.messages, [{
    role: "user",
    content: "Give n.",
  }]);
});

Deno.test("baseUrl trailing slash is tolerated", async () => {
  const api = fakeApi(chatReply());
  await ask(ARGS, { ...SETTINGS, baseUrl: "https://x.test/v1/" }, api.deps);
  assertEquals(api.calls[0].url, "https://x.test/v1/chat/completions");
});

Deno.test("messages route for claude models: x-api-key, output_config, text answer", async () => {
  const api = fakeApi(messagesReply());
  const out = await ask(
    ARGS,
    { ...SETTINGS, model: "claude-opus-5-5" },
    api.deps,
  );
  const { url, headers, body } = api.calls[0];
  assertEquals(url, "https://opencode.ai/zen/v1/messages");
  assertEquals(headers.get("x-api-key"), "test-key");
  assertEquals(headers.get("anthropic-version"), "2023-06-01");
  assertEquals(headers.get("authorization"), null);
  assertEquals(body?.model, "claude-opus-5-5");
  assertEquals(body?.system, "Be brief.");
  assertEquals(body?.messages, [{ role: "user", content: "Give n." }]);
  assertEquals(body?.output_config, {
    format: { type: "json_schema", schema: SCHEMA },
  });
  assertEquals(body?.tool_choice, undefined);
  assertEquals(typeof body?.max_tokens, "number");
  assertEquals(out.json, { n: 2 });
  assertEquals(out.usage, { inputTokens: 5, outputTokens: 3 });
});

Deno.test("messages route without system sends no system field", async () => {
  const api = fakeApi(messagesReply());
  await ask({ ...ARGS, system: undefined }, {
    ...SETTINGS,
    model: "claude-opus-5-5",
  }, api.deps);
  assertEquals("system" in (api.calls[0].body ?? {}), false);
});

Deno.test("gpt models are refused readably without calling the API", async () => {
  const api = fakeApi({});
  await assertRejects(
    () => ask(ARGS, { ...SETTINGS, model: "gpt-5" }, api.deps),
    Error,
    "GPT",
  );
  assertEquals(api.calls.length, 0);
});

Deno.test("HTTP error shows status and the body's message (both shapes)", async () => {
  const anthropic = fakeApi({
    type: "error",
    error: { type: "AuthError", message: "Invalid API key." },
  }, 401);
  await assertRejects(
    () => ask(ARGS, { ...SETTINGS, model: "claude-opus-5-5" }, anthropic.deps),
    Error,
    "HTTP 401",
  );
  await assertRejects(
    () => ask(ARGS, { ...SETTINGS, model: "claude-opus-5-5" }, anthropic.deps),
    Error,
    "Invalid API key.",
  );
  const chat = fakeApi({ error: { message: "Model not found." } }, 404);
  await assertRejects(
    () => ask(ARGS, SETTINGS, chat.deps),
    Error,
    "Model not found.",
  );
  const plain = fakeApi("upstream down", 502);
  await assertRejects(
    () => ask(ARGS, SETTINGS, plain.deps),
    Error,
    "upstream down",
  );
});

Deno.test("messages route: incomplete answer reports the stop reason", async () => {
  for (const stop of ["max_tokens", "refusal"]) {
    const api = fakeApi(messagesReply('{"n":', stop));
    await assertRejects(
      () => ask(ARGS, { ...SETTINGS, model: "claude-opus-5-5" }, api.deps),
      Error,
      stop,
    );
  }
});

Deno.test("messages route: no text block is an error", async () => {
  const api = fakeApi({ stop_reason: "end_turn", content: [] });
  await assertRejects(
    () => ask(ARGS, { ...SETTINGS, model: "claude-opus-5-5" }, api.deps),
    Error,
    "no text",
  );
});

Deno.test("chat route: no tool call is an error", async () => {
  const api = fakeApi({
    choices: [{ finish_reason: "stop", message: { content: "hello" } }],
  });
  await assertRejects(
    () => ask(ARGS, SETTINGS, api.deps),
    Error,
    "did not call",
  );
});

Deno.test("chat route: truncated answer reports the finish reason", async () => {
  const reply = chatReply('{"n":');
  reply.choices[0].finish_reason = "length";
  await assertRejects(
    () => ask(ARGS, SETTINGS, fakeApi(reply).deps),
    Error,
    "length",
  );
});

Deno.test("answer that is not JSON is an error showing the start of it", async () => {
  await assertRejects(
    () => ask(ARGS, SETTINGS, fakeApi(chatReply("not json at all")).deps),
    Error,
    "not JSON",
  );
  await assertRejects(
    () =>
      ask(
        ARGS,
        { ...SETTINGS, model: "claude-opus-5-5" },
        fakeApi(messagesReply("nope")).deps,
      ),
    Error,
    "not JSON",
  );
});

Deno.test("missing usage becomes zero", async () => {
  const out = await ask(
    ARGS,
    SETTINGS,
    fakeApi({ choices: chatReply().choices }).deps,
  );
  assertEquals(out.usage, { inputTokens: 0, outputTokens: 0 });
});

Deno.test("models lists ids from the catalogue with a bearer key", async () => {
  const api = fakeApi({
    data: [{ id: "claude-opus-5-5" }, { id: "deepseek-v4.1-flash" }],
  });
  const out = await listModels(SETTINGS, api.deps);
  assertEquals(api.calls[0].url, "https://opencode.ai/zen/v1/models");
  assertEquals(api.calls[0].method, "GET");
  assertEquals(api.calls[0].headers.get("authorization"), "Bearer test-key");
  assertEquals(out, {
    models: ["claude-opus-5-5", "deepseek-v4.1-flash"],
    fetchedAt: "2026-10-07T10:00:00.000Z",
  });
});

Deno.test("models reports HTTP errors", async () => {
  await assertRejects(
    () =>
      listModels(
        SETTINGS,
        fakeApi({ error: { message: "Invalid API key." } }, 401).deps,
      ),
    Error,
    "HTTP 401",
  );
});

// --- Method wiring ---

function ctx(globalArgs: Settings) {
  const writes: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    writes,
    context: {
      globalArgs,
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

Deno.test("ask method stores the answer resource under the given name", async () => {
  const { behaviour } = await import("./opencode.ts");
  const orig = behaviour.fetch;
  const api = fakeApi(chatReply());
  behaviour.fetch = api.deps.fetch;
  try {
    const { writes, context } = ctx(SETTINGS);
    const out = await model.methods.ask.execute(
      { ...ARGS, name: "daily" },
      context,
    );
    assertEquals(out.dataHandles.length, 1);
    assertEquals(writes[0].specName, "answer");
    assertEquals(writes[0].name, "daily");
    assertEquals((writes[0].data.json as { n: number }).n, 1);
    assertEquals(writes[0].data.model, "deepseek-v4.1-flash");
  } finally {
    behaviour.fetch = orig;
  }
});

Deno.test("ask method refuses the reserved name latest and calls nothing", async () => {
  const { behaviour } = await import("./opencode.ts");
  const orig = behaviour.fetch;
  const api = fakeApi(chatReply());
  behaviour.fetch = api.deps.fetch;
  try {
    const { writes, context } = ctx(SETTINGS);
    await assertRejects(
      () => model.methods.ask.execute({ ...ARGS, name: "latest" }, context),
      Error,
      "latest",
    );
    assertEquals(api.calls.length, 0);
    assertEquals(writes.length, 0);
  } finally {
    behaviour.fetch = orig;
  }
});

Deno.test("models method stores the catalog resource", async () => {
  const { behaviour } = await import("./opencode.ts");
  const orig = behaviour.fetch;
  behaviour.fetch = fakeApi({ data: [{ id: "a" }] }).deps.fetch;
  try {
    const { writes, context } = ctx(SETTINGS);
    await model.methods.models.execute({}, context);
    assertEquals(writes[0].specName, "catalog");
    assertEquals(writes[0].name, "catalog");
    assertEquals(writes[0].data.models, ["a"]);
    assertStringIncludes(String(writes[0].data.fetchedAt), "20");
  } finally {
    behaviour.fetch = orig;
  }
});

Deno.test("schema mismatch retries with feedback and sums usage", async () => {
  const api = fakeApi([chatReply('{"n":"wrong"}'), chatReply()]);
  const out = await ask(ARGS, SETTINGS, api.deps);
  assertEquals(api.calls.length, 2);
  const messages = api.calls[1].body?.messages as Array<
    { role: string; content: string }
  >;
  assertEquals(messages[0], { role: "system", content: "Be brief." });
  assertEquals(messages[1], { role: "user", content: "Give n." });
  assertStringIncludes(messages[2].content, "rejected");
  assertStringIncludes(messages[2].content, '{"n":"wrong"}');
  assertEquals(out.attempts, 2);
  assertEquals(out.usage, { inputTokens: 22, outputTokens: 14 });
});

Deno.test("malformed JSON retries on chat route", async () => {
  const api = fakeApi([chatReply("oops"), chatReply()]);
  const out = await ask(ARGS, SETTINGS, api.deps);
  assertEquals(out.attempts, 2);
  assertEquals(api.calls.length, 2);
  assertStringIncludes(JSON.stringify(api.calls[1].body?.messages), "not JSON");
});

Deno.test("incomplete messages reply retries with feedback", async () => {
  const api = fakeApi([messagesReply('{"n":', "max_tokens"), messagesReply()]);
  const out = await ask(
    ARGS,
    { ...SETTINGS, model: "claude-opus-5-5" },
    api.deps,
  );
  assertEquals(out.attempts, 2);
  assertEquals(out.usage, { inputTokens: 10, outputTokens: 6 });
  assertStringIncludes(
    JSON.stringify(api.calls[1].body?.messages),
    "max_tokens",
  );
});

Deno.test("invalid answers stop at the configured attempt limit", async () => {
  for (const maxAttempts of [1, 2]) {
    const api = fakeApi(chatReply('{"n":"wrong"}'));
    await assertRejects(
      () => ask({ ...ARGS, maxAttempts }, SETTINGS, api.deps),
      Error,
      `after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}`,
    );
    assertEquals(api.calls.length, maxAttempts);
  }
});

Deno.test("final error is singular for one attempt and lists every reason for several", async () => {
  const one = await ask(
    { ...ARGS, maxAttempts: 1 },
    SETTINGS,
    fakeApi(chatReply('{"n":"wrong"}')).deps,
  ).catch((e: Error) => e.message);
  assertStringIncludes(String(one), "after 1 attempt:");
  assertEquals(String(one).includes("all reasons"), false);

  const two = await ask(
    { ...ARGS, maxAttempts: 2 },
    SETTINGS,
    fakeApi([chatReply("first oops"), chatReply('{"n":"wrong"}')]).deps,
  ).catch((e: Error) => e.message);
  assertStringIncludes(String(two), "after 2 attempts:");
  assertStringIncludes(String(two), "(all reasons: 1. ");
  assertStringIncludes(String(two), " 2. ");
});

Deno.test("rejection reasons are readable: schema errors name the location, not raw JSON", async () => {
  const api = fakeApi(chatReply('{"n":"wrong"}'));
  const message = await ask({ ...ARGS, maxAttempts: 1 }, SETTINGS, api.deps)
    .catch((e: Error) => e.message);
  assertStringIncludes(String(message), "does not match the schema: ");
  assertStringIncludes(String(message), "#/n: Instance type");
  assertEquals(String(message).includes("instanceLocation"), false);
});

Deno.test("not-JSON reason shows the start of the answer", async () => {
  const message = await ask(
    { ...ARGS, maxAttempts: 1 },
    SETTINGS,
    fakeApi(chatReply("not json at all")).deps,
  ).catch((e: Error) => e.message);
  assertStringIncludes(String(message), "The answer was not JSON: not json at all");
});

Deno.test("HTTP 500 is not retried", async () => {
  const api = fakeApi({ error: { message: "server down" } }, 500);
  await assertRejects(() => ask(ARGS, SETTINGS, api.deps), Error, "HTTP 500");
  assertEquals(api.calls.length, 1);
});

Deno.test("third attempt receives only the latest rejection feedback", async () => {
  const api = fakeApi([
    chatReply("first invalid"),
    chatReply("second invalid"),
    chatReply(),
  ]);
  const out = await ask({ ...ARGS, maxAttempts: 3 }, SETTINGS, api.deps);
  const messages = api.calls[2].body?.messages as Array<
    { role: string; content: string }
  >;
  assertEquals(messages.length, 3);
  assertStringIncludes(messages[2].content, "second invalid");
  assertEquals(messages[2].content.includes("first invalid"), false);
  assertEquals(out.attempts, 3);
});

Deno.test("valid long JSON is parsed in full", async () => {
  const value = "x".repeat(3000);
  const api = fakeApi(chatReply(JSON.stringify({ n: 1, extra: value })));
  const out = await ask(ARGS, SETTINGS, api.deps);
  assertEquals((out.json as { extra: string }).extra, value);
});

Deno.test("the type is @puddleworks/opencode and requests name it", async () => {
  assertEquals(model.type, "@puddleworks/opencode");
  const api = fakeApi({ data: [{ id: "a" }] });
  await listModels(SETTINGS, api.deps);
  assertEquals(
    api.calls[0].headers.get("user-agent"),
    `puddleworks-opencode/${model.version}`,
  );
});
