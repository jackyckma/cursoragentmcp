import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cursorRequest,
  handleCursorApiError,
} from "./cursorClient.js";
import { CHARACTER_LIMIT, MAX_REPOS_PER_AGENT, REPOSITORIES_ENDPOINT_NOTE } from "./constants.js";
import {
  Agent,
  AgentUsageResponse,
  CreateAgentResponse,
  CreateRunResponse,
  ListAgentsResponse,
  ListModelsResponse,
  ListRepositoriesResponse,
  ListRunsResponse,
  Run,
} from "./types.js";

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Narrow your query — e.g. filter by agent ID or reduce 'limit'.]`
  );
}

function jsonContent(output: unknown) {
  return {
    content: [
      { type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) },
    ],
    structuredContent: output as Record<string, unknown>,
  };
}

function errorContent(error: unknown) {
  return { content: [{ type: "text" as const, text: handleCursorApiError(error) }], isError: true };
}

const RepoInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("GitHub repository URL, e.g. https://github.com/jackyckma/cursoragentmcp"),
  startingRef: z
    .string()
    .optional()
    .describe("Branch name or commit SHA to start from. Ignored when prUrl is set. Defaults to the repo's default branch."),
  prUrl: z
    .string()
    .url()
    .optional()
    .describe("An existing GitHub PR URL. When set, the agent works on that PR's branch and startingRef is ignored."),
});

const ModelInputSchema = z
  .object({
    id: z
      .string()
      .describe("Model ID from cursor_list_models, e.g. 'claude-4.6-sonnet-thinking' or 'composer-2'."),
    params: z
      .array(z.object({ id: z.string(), value: z.string() }))
      .optional()
      .describe("Per-model parameters (e.g. reasoning effort). Valid ids/values come from cursor_list_models."),
  })
  .optional()
  .describe("Model to use for this run. Omit to use the account/team default model.");

export function registerTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------

  server.registerTool(
    "cursor_create_agent",
    {
      title: "Launch a Cursor Cloud Agent",
      description: `Create a new Cursor Cloud Agent and immediately start its first run. This is how you DISPATCH a coding task to Cursor from chat.

By default Cursor pushes the agent's commits to a new auto-generated branch (cursor/...). Set autoCreatePR=true to also open a pull request when the run finishes.

Args:
  - prompt (string, required): The task instruction for the agent.
  - repos (array, optional): Up to ${MAX_REPOS_PER_AGENT} repos, each with { url, startingRef?, prUrl? }. Omit entirely to start a no-repo agent (e.g. for research/scratch tasks).
  - name (string, optional): Display name, max 100 chars. Auto-derived from the prompt if omitted.
  - model (object, optional): { id, params? }. Omit to use the default model. Call cursor_list_models first if the user names a specific model.
  - autoCreatePR (boolean, optional): Open a PR automatically when the run completes.
  - workOnCurrentBranch (boolean, optional, default false): Push directly to startingRef instead of a new branch.
  - mode ('agent' | 'plan', optional, default 'agent'): 'plan' drafts a plan before coding instead of implementing directly.

Returns: the created agent (id, status, url) and its initial run (id, status). Use the agent id with cursor_get_agent / cursor_get_run to check progress, and cursor_create_run to send follow-ups.

Example: dispatch "Add a health-check endpoint" to a repo on main -> params with prompt text set, repos=[{url:"https://github.com/org/repo", startingRef:"main"}], autoCreatePR=true.`,
      inputSchema: {
        prompt: z.string().min(1).describe("The task instruction for the agent."),
        repos: z
          .array(RepoInputSchema)
          .max(MAX_REPOS_PER_AGENT)
          .optional()
          .describe(`Repositories for the agent to work in (max ${MAX_REPOS_PER_AGENT}). Omit for a no-repo agent.`),
        name: z.string().max(100).optional().describe("Display name for the agent (max 100 chars)."),
        model: ModelInputSchema,
        autoCreatePR: z.boolean().optional().describe("Open a pull request automatically when the run finishes."),
        skipReviewerRequest: z
          .boolean()
          .optional()
          .describe("Skip requesting the user as PR reviewer. Only applies when autoCreatePR is true."),
        workOnCurrentBranch: z
          .boolean()
          .optional()
          .describe("Push directly to startingRef instead of a new cursor/... branch. Default false."),
        mode: z
          .enum(["agent", "plan"])
          .optional()
          .describe("'agent' implements changes directly (default). 'plan' drafts a plan first."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const data = await cursorRequest<CreateAgentResponse>("POST", "/v1/agents", {
          data: {
            prompt: { text: params.prompt },
            ...(params.repos ? { repos: params.repos } : {}),
            ...(params.name ? { name: params.name } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.autoCreatePR !== undefined ? { autoCreatePR: params.autoCreatePR } : {}),
            ...(params.skipReviewerRequest !== undefined
              ? { skipReviewerRequest: params.skipReviewerRequest }
              : {}),
            ...(params.workOnCurrentBranch !== undefined
              ? { workOnCurrentBranch: params.workOnCurrentBranch }
              : {}),
            ...(params.mode ? { mode: params.mode } : {}),
          },
        });
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_list_agents",
    {
      title: "List Cursor Cloud Agents",
      description: `List cloud agents for the authenticated Cursor account, newest first. List items only carry durable identity fields (id, name, status, url) — call cursor_get_agent for full details like repos.

Args:
  - limit (number, optional, default 20, max 100)
  - cursor (string, optional): pagination cursor from a previous response's nextCursor
  - prUrl (string, optional): filter to the agent tied to a specific GitHub PR URL
  - includeArchived (boolean, optional, default true)

Returns: { items: Agent[], nextCursor? }. Absence of nextCursor means no more pages.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("Max agents to return (1-100)."),
        cursor: z.string().optional().describe("Pagination cursor from a previous nextCursor."),
        prUrl: z.string().url().optional().describe("Filter agents by GitHub pull request URL."),
        includeArchived: z.boolean().optional().default(true).describe("Include archived agents."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data = await cursorRequest<ListAgentsResponse>("GET", "/v1/agents", {
          params: {
            limit: params.limit,
            cursor: params.cursor,
            prUrl: params.prUrl,
            includeArchived: params.includeArchived,
          },
        });
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_get_agent",
    {
      title: "Get Cursor Agent Details",
      description: `Retrieve durable metadata for one agent: status (ACTIVE/IDLE/ARCHIVED), repos, PR settings, and latestRunId.

Note: execution status lives on RUNS, not the agent. ACTIVE/IDLE only tells you whether the agent's machine is up — call cursor_get_run with latestRunId to see whether a task is actually still working, finished, or errored.

Args:
  - id (string, required): agent id, e.g. "bc-00000000-0000-0000-0000-000000000001"`,
      inputSchema: {
        id: z.string().min(1).describe("Agent id, e.g. bc-<uuid>."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const data = await cursorRequest<Agent>("GET", `/v1/agents/${id}`);
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_archive_agent",
    {
      title: "Archive a Cursor Agent",
      description:
        "Archive an agent (reversible soft-delete). Archived agents remain readable but cannot accept new runs until unarchived. Idempotent — archiving an already-archived agent is a no-op success.",
      inputSchema: { id: z.string().min(1).describe("Agent id to archive.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const data = await cursorRequest<{ id: string }>("POST", `/v1/agents/${id}/archive`);
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_unarchive_agent",
    {
      title: "Unarchive a Cursor Agent",
      description:
        "Restore an archived agent so it can accept new runs again. Idempotent — calling it on an already-active agent is a no-op success.",
      inputSchema: { id: z.string().min(1).describe("Agent id to unarchive.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const data = await cursorRequest<{ id: string }>("POST", `/v1/agents/${id}/unarchive`);
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_delete_agent",
    {
      title: "Permanently Delete a Cursor Agent",
      description:
        "PERMANENTLY delete an agent. This is irreversible and destroys its workspace and history. Prefer cursor_archive_agent for reversible removal — only use this when the user explicitly asks to permanently delete.",
      inputSchema: { id: z.string().min(1).describe("Agent id to permanently delete.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const data = await cursorRequest<{ id: string }>("DELETE", `/v1/agents/${id}`);
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_get_agent_usage",
    {
      title: "Get Cursor Agent Token Usage",
      description:
        "Retrieve token usage for an agent, broken down per run, plus a totalUsage summary. Useful for cost tracking. Args: id (required), runId (optional, scopes to one run).",
      inputSchema: {
        id: z.string().min(1).describe("Agent id."),
        runId: z.string().optional().describe("Scope to a single run id. Omit for usage across every run."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, runId }) => {
      try {
        const data = await cursorRequest<AgentUsageResponse>("GET", `/v1/agents/${id}/usage`, {
          params: runId ? { runId } : undefined,
        });
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  // ---------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------

  server.registerTool(
    "cursor_create_run",
    {
      title: "Send a Follow-up to a Cursor Agent",
      description: `Send a follow-up prompt to an EXISTING agent, continuing its current conversation and workspace state. Use this to refine or extend work already in progress instead of creating a new agent.

Only one run can be active per agent at a time — calling this while the agent's latest run is still CREATING or RUNNING fails with agent_busy. Check status first with cursor_get_run, or cursor_cancel_run to interrupt it.

Args:
  - id (string, required): the agent id to follow up on
  - prompt (string, required): the follow-up instruction
  - mode ('agent' | 'plan', optional): override the conversation mode for this run only`,
      inputSchema: {
        id: z.string().min(1).describe("Agent id to send the follow-up to."),
        prompt: z.string().min(1).describe("The follow-up instruction text."),
        mode: z.enum(["agent", "plan"]).optional().describe("Override conversation mode for this run."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, prompt, mode }) => {
      try {
        const data = await cursorRequest<CreateRunResponse>("POST", `/v1/agents/${id}/runs`, {
          data: { prompt: { text: prompt }, ...(mode ? { mode } : {}) },
        });
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_list_runs",
    {
      title: "List Runs for a Cursor Agent",
      description:
        "List runs for one agent, newest first, including each run's status and (once pushed) its git branches. Args: id (required), limit (optional, default 20, max 100), cursor (optional pagination token).",
      inputSchema: {
        id: z.string().min(1).describe("Agent id."),
        limit: z.number().int().min(1).max(100).default(20).describe("Max runs to return (1-100)."),
        cursor: z.string().optional().describe("Pagination cursor from a previous nextCursor."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, limit, cursor }) => {
      try {
        const data = await cursorRequest<ListRunsResponse>("GET", `/v1/agents/${id}/runs`, {
          params: { limit, cursor },
        });
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_get_run",
    {
      title: "Get Cursor Run Status / Result",
      description: `Retrieve status and, for terminal runs, the final result text, duration, and pushed branches/PR links for one run. This is the primary way to check whether a dispatched task is done.

status is one of: CREATING, RUNNING (still working), FINISHED, ERROR, CANCELLED, EXPIRED (terminal).

Args:
  - id (string, required): the agent id
  - runId (string, required): the run id (from cursor_create_agent's response, or cursor_list_runs)`,
      inputSchema: {
        id: z.string().min(1).describe("Agent id."),
        runId: z.string().min(1).describe("Run id, e.g. run-<uuid>."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, runId }) => {
      try {
        const data = await cursorRequest<Run>("GET", `/v1/agents/${id}/runs/${runId}`);
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_wait_for_run",
    {
      title: "Wait for a Cursor Run to Finish",
      description: `Poll a run until it reaches a terminal status (FINISHED, ERROR, CANCELLED, EXPIRED) or the timeout elapses, then return its final state. Convenience wrapper around repeated cursor_get_run calls — use this instead of manually polling in a loop.

Args:
  - id (string, required): agent id
  - runId (string, required): run id
  - timeoutSeconds (number, optional, default 120, max 280): give up and return the last-seen status after this long. Keep this under ~280s — MCP clients typically enforce their own tool-call timeout around 300s.
  - pollIntervalSeconds (number, optional, default 5, min 2): how often to check

Returns the run object plus a 'timedOut' boolean. If timedOut is true, the run is likely still going — call cursor_get_run again later, or re-call this tool.`,
      inputSchema: {
        id: z.string().min(1).describe("Agent id."),
        runId: z.string().min(1).describe("Run id."),
        timeoutSeconds: z.number().int().min(5).max(280).default(120).describe("Max time to wait, in seconds."),
        pollIntervalSeconds: z.number().int().min(2).max(30).default(5).describe("Seconds between status checks."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, runId, timeoutSeconds, pollIntervalSeconds }) => {
      const terminal = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);
      const deadline = Date.now() + timeoutSeconds * 1000;
      try {
        let run = await cursorRequest<Run>("GET", `/v1/agents/${id}/runs/${runId}`);
        while (!terminal.has(run.status) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
          run = await cursorRequest<Run>("GET", `/v1/agents/${id}/runs/${runId}`);
        }
        return jsonContent({ ...run, timedOut: !terminal.has(run.status) });
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_cancel_run",
    {
      title: "Cancel a Cursor Run",
      description:
        "Cancel the active run for an agent. Terminal and irreversible — the run moves to CANCELLED and cannot be resumed. To keep working, start a new run on the same agent with cursor_create_run. Fails with run_not_cancellable if the run is already terminal or was never active.",
      inputSchema: {
        id: z.string().min(1).describe("Agent id."),
        runId: z.string().min(1).describe("Run id to cancel."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, runId }) => {
      try {
        const data = await cursorRequest<{ id: string }>("POST", `/v1/agents/${id}/runs/${runId}/cancel`);
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  // ---------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------

  server.registerTool(
    "cursor_list_models",
    {
      title: "List Available Cursor Models",
      description:
        "List the model IDs that can be passed as model.id to cursor_create_agent, along with their supported parameters. Call this before honoring a user's request for a specific model, to confirm the exact id and valid params.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await cursorRequest<ListModelsResponse>("GET", "/v1/models");
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_list_repositories",
    {
      title: "List Accessible GitHub Repositories",
      description: `List GitHub repositories accessible to the authenticated user through Cursor's GitHub App installation. ${REPOSITORIES_ENDPOINT_NOTE}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await cursorRequest<ListRepositoriesResponse>("GET", "/v1/repositories");
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "cursor_get_me",
    {
      title: "Get Cursor API Key Info",
      description:
        "Retrieve information about the API key currently authenticating this server (name, owner email, created date). Useful to confirm which Cursor account is connected.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await cursorRequest<Record<string, unknown>>("GET", "/v1/me");
        return jsonContent(data);
      } catch (error) {
        return errorContent(error);
      }
    }
  );
}
