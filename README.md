# @puddleworks/opencode

A reusable swamp extension that asks an [OpenCode Zen](https://opencode.ai/zen)
model for JSON matching a schema the caller supplies. The instance holds the API
key and the model choice; apps send a prompt and a schema and read back JSON.
It validates the answer against the supplied JSON Schema. Invalid or incomplete
answers are retried with the rejection reason and previous answer in the prompt.
Callers can still apply their own schema as a final guard.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `apiKey` | required, sensitive | OpenCode API key. Reference it from a vault. |
| `model` | required | Zen model id, e.g. `deepseek-v4.1-flash`, `claude-opus-5-5`. |
| `baseUrl` | `https://opencode.ai/zen/v1` | Zen base URL. |
| `timeoutMs` | `120000` | Abort a request after this long. |

## Methods

- **`ask`** — arguments `system` (optional), `prompt`, `schema` (a JSON Schema
  object), `maxAttempts` (1–5, default 2), `name` (data name, default
  `answer`; `latest` is refused because swamp reserves it, and `catalog`
  because `models` stores under it). Stores resource `answer` under `name`:
  `{ model, json, attempts, usage: {inputTokens, outputTokens}, askedAt }`.
  Usage sums tokens across all attempts. HTTP errors are returned immediately,
  except 429 and 503 (below).
- **`models`** — lists the model ids the account can use. Stores resource
  `catalog`: `{ models: string[], fetchedAt }`.

Both methods log at info level when they start and finish. A 429 or 503 reply
is tried up to three times in all, waiting for `Retry-After` seconds between
tries (1 second when it is absent, at most 30). If it still fails, the error
names the status.

Routing on the model id: `claude-*` use `/messages` (`x-api-key`, structured
`output_config`); GPT models are not supported (they need `/responses`) and fail
with a readable error; everything else uses `/chat/completions` with one forced
function tool whose parameters are the schema.

## Install

```bash
swamp extension pull @puddleworks/opencode
```

An app that calls it lists `"@puddleworks/opencode"` under `dependencies:` in
its manifest, so pulling the app pulls this too.

## Create an instance

```bash
swamp vault create local_encryption opencode   # once; skip if you have a vault
swamp vault put opencode opencodeApiKey        # prompts for the key
swamp model create @puddleworks/opencode opencode \
  --global-arg 'apiKey=${{ vault.get("opencode", "opencodeApiKey") }}' \
  --global-arg model=deepseek-v4.1-flash
```

Change `model` by editing the instance (`swamp model edit opencode`).

## Call `ask` from a workflow

```yaml
- name: ask
  dependsOn:
    - { step: prepare, condition: { type: succeeded } }
  task:
    type: model_method
    modelIdOrName: opencode
    methodName: ask
    inputs:
      system: ${{ data.latest("my-app", "request").attributes.system }}
      prompt: ${{ data.latest("my-app", "request").attributes.prompt }}
      schema: ${{ data.latest("my-app", "request").attributes.schema }}
      name: my-app
```

Read the answer in a later step with
`${{ data.latest("opencode", "my-app").attributes.json }}`.

## Test it

```bash
DENO=$(swamp doctor extensions --json | jq -r '.denoPath')
$DENO check extensions/models/opencode.ts
make test
make publish VISIBILITY=public DRY_RUN=1
```
