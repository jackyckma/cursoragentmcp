# cursor-agent-mcp-server

A streaming MCP server that lets AI assistants (Claude, etc.) launch, monitor,
and converse with [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent)
directly from chat. It wraps the [Cursor Cloud Agents API v1](https://cursor.com/docs/cloud-agent/api/endpoints)
(public beta).

Built for remote deployment (e.g. on [Zeabur](https://zeabur.com)) using the
MCP Streamable HTTP transport, so it can be used from claude.ai web/mobile —
not just from a local Claude Desktop/Code install. It also supports stdio for
local use.

## What it does

Once connected, the assistant can:

- **Dispatch** a coding task: create a new Cloud Agent on a repo/branch with a prompt (`cursor_create_agent`)
- **Check progress**: list agents/runs, get status and results (`cursor_list_agents`, `cursor_get_agent`, `cursor_get_run`, `cursor_wait_for_run`)
- **Continue a conversation**: send a follow-up prompt to a running agent (`cursor_create_run`)
- **Manage lifecycle**: cancel a run, archive/unarchive/delete an agent
- **Look up metadata**: available models, accessible repos, API key identity, token usage

Full tool list is in [`src/tools.ts`](./src/tools.ts) — each tool's
`description` documents its exact arguments and return shape.

## Prerequisites

- A Cursor account with Cloud Agents access, and an API key from
  **Cursor Dashboard → API Keys**.
- Node.js 18+ (for local dev) or Docker (for deployment).

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Purpose |
|---|---|---|
| `CURSOR_API_KEY` | Yes | Authenticates against the Cursor API. |
| `MCP_SERVER_TOKEN` | Strongly recommended for public deployments | Shared-secret bearer token that gates the `/mcp` endpoint. This server can create billable Cloud Agent runs — do not deploy publicly without it. |
| `TRANSPORT` | No (default `http`) | `http` for remote/Zeabur, `stdio` for local Claude Desktop/Code. |
| `PORT` | No (default `3000`) | HTTP port. Zeabur sets this automatically. |

## Local development

```bash
npm install
npm run build
npm start          # runs dist/index.js with TRANSPORT from your env
# or, for auto-reload during development:
npm run dev
```

Test with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

## Deploying on Zeabur

1. Push this repo to GitHub (already done if you're reading this from
   `jackyckma/cursoragentmcp`).
2. In Zeabur, create a new service from this GitHub repo. Zeabur will detect
   the `Dockerfile` automatically.
3. Set environment variables on the service: `CURSOR_API_KEY` and
   `MCP_SERVER_TOKEN` at minimum. Zeabur injects `PORT` itself.
4. Deploy. Zeabur gives you a public URL — the MCP endpoint is at
   `https://<your-service>.zeabur.app/mcp`.
5. A `GET /health` route is included for Zeabur's health checks.

See [Setup Guide](#setup-guide) for the full walkthrough (API key, Zeabur
variables, and connecting from Claude).

## Connecting from an MCP client

Add a remote MCP connector pointing at `https://<your-service>.zeabur.app/mcp`
with header:

```
Authorization: Bearer <your MCP_SERVER_TOKEN>
```

The exact steps depend on the client (claude.ai custom connectors, Claude
Desktop's config file, etc.) — this server speaks standard Streamable HTTP
MCP, so any spec-compliant client works.

For local stdio use (e.g. Claude Desktop config), set `TRANSPORT=stdio` and
point the client at `node dist/index.js` with `CURSOR_API_KEY` in its `env`.

Claude-specific steps (custom connector, request headers, per-conversation
toggle) are in [Setup Guide → Connecting to Claude](#3-connecting-to-claude-claudeai).

## Setup Guide

End-to-end path from a Cursor API key to a working Claude connector.

### 1. Getting a Cursor API key

1. Open the [Cursor Dashboard](https://cursor.com/dashboard).
2. Go to **API Keys**. On older dashboards this may be under **Integrations**.
3. Create a new key and copy it somewhere safe.

This key can create **billable Cloud Agent runs**. Treat it like a password —
do not commit it, paste it into chat, or share it.

### 2. Configuring Zeabur

After you have deployed this repo as a service on Zeabur (it auto-detects the
`Dockerfile`):

1. Open the service's **Variables** / **Environment** settings.
2. Set the following:

   | Variable | Value |
   |---|---|
   | `CURSOR_API_KEY` | The key from step 1. |
   | `MCP_SERVER_TOKEN` | A random secret you generate yourself, e.g. `openssl rand -hex 32`. This protects the public `/mcp` endpoint from unauthenticated use. |

   `PORT` is injected automatically by Zeabur — you do not need to set it.
3. Save. Zeabur will redeploy the service.
4. Once it's up, the public MCP endpoint is:

   ```
   https://<service>.zeabur.app/mcp
   ```

   Hit `https://<service>.zeabur.app/health` to confirm the service is running.

### 3. Connecting to Claude (claude.ai)

1. In Claude, go to **Customize → Connectors**.
2. Click **+**, then select **Add custom connector**.
3. Enter a **Name** and the **Remote MCP server URL** — the Zeabur `/mcp`
   URL from step 2 (e.g. `https://<service>.zeabur.app/mcp`).
4. Set **Authentication** to **None**. This server does not use OAuth.
5. Open **Request headers**, then add a header:
   - Name: `authorization` (or **Custom header** → `Authorization`)
   - Value: `Bearer <MCP_SERVER_TOKEN>` — the same token you set on Zeabur.
     There must be a space after `Bearer`.
   - Mark the header **Required**.
6. Click **Add**.

The **Request headers** section is currently in beta and may not be visible
on all Claude accounts yet.

To use the connector in a conversation: click the **+** button in the chat,
select **Add connectors**, and toggle it on. Connectors are enabled
**per-conversation**, not globally.

## Security notes

- This server can spend Cursor compute (creating agents, runs) on your
  behalf — always set `MCP_SERVER_TOKEN` before exposing it publicly.
- `CURSOR_API_KEY` and `MCP_SERVER_TOKEN` are read from the environment only;
  never commit a `.env` file (already gitignored).
- `GET /v1/repositories` is rate-limited by Cursor to 1 request/user/minute
  and 30/hour — the `cursor_list_repositories` tool description warns the
  calling model about this, but avoid calling it in a loop.

## API version note

This server targets **Cursor Cloud Agents API v1**, which is in public beta
and may change before general availability. The legacy v0 API (which most
older community MCP wrappers target) remains available if you need it — see
[Cursor's v0 docs](https://cursor.com/docs/cloud-agent/api/v0) — but v1 is
the direction Cursor is investing in (agent+run model, upcoming webhooks).

## License

MIT
