# @mesgme/opencode

A reusable swamp extension that asks an [OpenCode Zen](https://opencode.ai/zen)
model for JSON matching a schema the caller supplies. The instance holds the API
key and the model choice; apps send a prompt and a schema and read back JSON.
It does not validate the answer against the schema — validate it in the caller
with your own zod schema.

Source: `extensions/models/opencode.ts`. Tests: `extensions/models/opencode_test.ts`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `apiKey` | required, sensitive | OpenCode API key. Reference it from a vault. |
| `model` | required | Zen model id, e.g. `deepseek-v4.1-flash`, `claude-opus-5-5`. |
| `baseUrl` | `https://opencode.ai/zen/v1` | Zen base URL. |
| `timeoutMs` | `120000` | Abort a request after this long. |

## Methods

- **`ask`** — arguments `system` (optional), `prompt`, `schema` (a JSON Schema
  object), `name` (data name, default `answer`; `latest` is refused because swamp
  reserves it). Stores resource `answer` under `name`:
  `{ model, json, usage: {inputTokens, outputTokens}, askedAt }`.
- **`models`** — lists the model ids the account can use. Stores resource
  `catalog`: `{ models: string[], fetchedAt }`.

Routing on the model id: `claude-*` use `/messages` (`x-api-key`, structured
`output_config`); GPT models are not supported (they need `/responses`) and fail
with a readable error; everything else uses `/chat/completions` with one forced
function tool whose parameters are the schema.

## Create an instance

```bash
swamp vault create local_encryption opencode   # once; skip if you have a vault
swamp vault put opencode opencodeApiKey        # prompts for the key
swamp model create @mesgme/opencode opencode \
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
$DENO test extensions/models/opencode_test.ts
```
