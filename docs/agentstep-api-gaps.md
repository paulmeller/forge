# AgentStep API — gaps found during Forge integration

**Date:** 2026-04-26
**Context:** Forge's MA adapter talks the `managed-agents-2026-04-01` spec. AgentStep implements it. During live testing (Codex engine + Sprites sandbox), we hit several undocumented behaviors and one missing endpoint. This doc is for the gateway team to address.

---

## 1. Missing: `POST /v1/vaults/{vault_id}/credentials`

**Severity: blocking.** This is how Anthropic's MA spec stores per-vault credentials. AgentStep returns 404 on this path.

**What happened:**
```bash
# Vault creation works
POST /v1/vaults → 201 { id: "vault_01KQ4S10B9YCDH2Z7PREZSJGYF" }

# Credential creation does not
POST /v1/vaults/vault_01KQ4S10B9YCDH2Z7PREZSJGYF/credentials → 404 (Next.js HTML page)
```

**What we needed to store:**
```json
{
  "display_name": "Sprites sandbox token",
  "key": "SPRITE_TOKEN",
  "value": "paul-meller/1502426/59ca84a1..."
}
```
```json
{
  "display_name": "OpenAI API key",
  "key": "OPENAI_API_KEY",
  "value": "sk-svcacct-..."
}
```

**Session error without it:**
```json
{
  "type": "server_error",
  "message": "container creation failed: provider sprites is not available: SPRITE_TOKEN required — add to vault or .env"
}
```

**Recommendation:** Implement `POST /v1/vaults/{vault_id}/credentials` with a simple key-value schema for provider tokens:

```yaml
# OpenAPI
/v1/vaults/{vault_id}/credentials:
  post:
    summary: Add a credential to a vault
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [display_name, key, value]
            properties:
              display_name:
                type: string
                description: Human-readable label shown in the UI
              key:
                type: string
                description: Environment variable name injected into the sandbox
                enum: [SPRITE_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY]
              value:
                type: string
                description: The secret value (write-only — never returned in GET responses)
    responses:
      201:
        description: Credential created
        content:
          application/json:
            schema:
              type: object
              properties:
                id: { type: string }
                display_name: { type: string }
                key: { type: string }
                created_at: { type: string, format: date-time }
      404:
        description: Vault not found
```

Also implement:
- `GET /v1/vaults/{vault_id}/credentials` — list credentials (metadata only, no values)
- `DELETE /v1/vaults/{vault_id}/credentials/{credential_id}` — remove a credential

---

## 2. Undocumented: `config.provider` required on environment create

Anthropic's MA uses `config.type: "cloud"` with no provider field. AgentStep requires it.

**What Anthropic accepts:**
```json
{ "config": { "type": "cloud", "networking": { "type": "unrestricted" } } }
```

**What AgentStep requires:**
```json
{ "config": { "type": "cloud", "provider": "sprites", "networking": { "type": "unrestricted" } } }
```

**Error without it:**
```json
{ "message": "config.provider is required — specify a sandbox provider (e.g. docker, apple-container)" }
```

**Recommendation:** Document `config.provider` as a required field in the OpenAPI spec with an enum of supported values:

```yaml
config:
  type: object
  required: [type, provider]
  properties:
    type:
      type: string
      enum: [cloud]
    provider:
      type: string
      enum: [docker, podman, apple-container, daytona, e2b, vercel-sandbox, modal, sprites, fly]
      description: Sandbox runtime provider. Anthropic MA equivalent uses provider=anthropic implicitly.
    networking:
      type: object
      properties:
        type:
          type: string
          enum: [unrestricted, package_managers_and_custom]
```

---

## 3. Undocumented: `engine` field on agent create

Anthropic's MA implicitly uses Claude. AgentStep supports multiple engines and requires the field for non-Claude models.

**What Anthropic accepts:**
```json
{ "model": "claude-opus-4-7" }
```

**What AgentStep needs for Codex:**
```json
{ "engine": "codex", "model": "gpt-5.4-mini" }
```

**Error without `engine`:**
```json
{ "message": "Model \"codex/gpt-5.4-mini\" is not supported by the claude engine" }
```

**Error with `tools` on codex engine:**
```json
{ "message": "codex backend does not use agent tool configs; tools are managed by the backend's internal permission system" }
```

**Recommendation:** Document `engine` and per-engine constraints:

```yaml
engine:
  type: string
  enum: [claude, codex, gemini, opencode, factory]
  default: claude
  description: |
    Which agent harness to use. Each engine has different model and tool constraints:
    - claude: supports agent_toolset, mcp_toolset, custom tools. Models: claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5.
    - codex: tools managed internally by the codex backend — omit the tools field. Models: gpt-5.4, gpt-5.4-mini.
    - gemini: supports agent_toolset. Models: gemini-3.1-pro, gemini-3, gemini-2.5-pro, gemini-2.5-flash.
    - opencode: any model via provider prefix (e.g. openai/gpt-5.4). Tools vary by underlying provider.
    - factory: multi-model. Tools vary.
```

---

## 4. Undocumented: vault requires `agent_id`

Anthropic's MA vaults are workspace-scoped. AgentStep scopes them per-agent.

**What Anthropic accepts:**
```json
{ "display_name": "my vault" }
```

**What AgentStep requires:**
```json
{ "display_name": "my vault", "agent_id": "agent_01KQ4..." }
```

**Error without it:**
```json
{ "message": "[{\"code\":\"invalid_type\",\"expected\":\"string\",\"received\":\"undefined\",\"path\":[\"agent_id\"],\"message\":\"Required\"}]" }
```

**Recommendation:** Document `agent_id` as required. Consider whether workspace-scoped vaults (no agent_id) should also be supported for shared credentials across agents.

---

## 5. URL redirect loses POST body

`agentstep.com` redirects to `www.agentstep.com`. HTTP redirects on POST requests drop the request body per RFC 7231. This means:

```bash
# This silently fails (redirect drops the body, returns a listing instead of creating)
POST https://agentstep.com/v1/environments → 302 → GET https://www.agentstep.com/v1/environments

# This works
POST https://www.agentstep.com/v1/environments → 201
```

**Recommendation:** Either:
- Remove the redirect and serve the API on both `agentstep.com` and `www.agentstep.com`, OR
- Use a 307 redirect (which preserves method + body) instead of 301/302, OR
- Document that the canonical API URL is `https://www.agentstep.com` (not `https://agentstep.com`)

---

## 6. Suggested: `/v1/docs` should return OpenAPI JSON

Currently `GET /v1/docs` redirects to a web page. For programmatic consumers (SDK codegen, API testing, Forge's gateway adapter), serving OpenAPI 3.1 JSON at `/v1/docs` or `/v1/openapi.json` would let integrators self-serve.

---

## Summary for the gateway team

| Priority | Issue | Fix |
|---|---|---|
| **P0** | `/v1/vaults/{id}/credentials` 404 | Implement the endpoint — this blocks multi-provider usage |
| **P1** | `config.provider` undocumented | Add to OpenAPI spec with enum of valid providers |
| **P1** | `engine` field undocumented | Add to OpenAPI spec with per-engine model/tool constraints |
| **P1** | POST redirect drops body | Fix redirect (307 or serve on both domains) |
| **P2** | `vault.agent_id` required but undocumented | Document; consider workspace-scoped vaults |
| **P2** | No OpenAPI JSON endpoint | Serve at `/v1/openapi.json` |

These are all small fixes individually. The credential endpoint (P0) is the only one that requires new code; the rest are documentation + config changes.
