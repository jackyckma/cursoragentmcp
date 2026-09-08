import axios, { AxiosError, AxiosInstance } from "axios";
import { CURSOR_API_BASE_URL } from "./constants.js";

let client: AxiosInstance | null = null;

/**
 * Lazily-created axios instance authenticated against the Cursor Cloud
 * Agents API. Cursor accepts Basic auth with the API key as the
 * username and an empty password (matches the `-u YOUR_API_KEY:`
 * pattern in Cursor's own docs).
 */
export function getCursorClient(): AxiosInstance {
  if (client) return client;

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY environment variable is required. Generate one from Cursor Dashboard -> API Keys."
    );
  }

  client = axios.create({
    baseURL: CURSOR_API_BASE_URL,
    timeout: 30000,
    auth: { username: apiKey, password: "" },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  return client;
}

export async function cursorRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options?: { data?: unknown; params?: unknown }
): Promise<T> {
  const c = getCursorClient();
  const response = await c.request<T>({
    method,
    url: path,
    data: options?.data,
    params: options?.params,
  });
  return response.data;
}

/** Turn an API failure into a message the calling agent can act on. */
export function handleCursorApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const body = error.response?.data as
      | { code?: string; message?: string }
      | undefined;
    const detail = body?.message || body?.code;

    switch (status) {
      case 400:
        return `Error: Bad request${detail ? ` — ${detail}` : ""}. Check that repo URLs, model IDs, and other fields match what Cursor expects (use cursor_list_models / cursor_list_repositories to confirm valid values).`;
      case 401:
        return "Error: Authentication failed. The CURSOR_API_KEY is missing, invalid, or revoked — generate a fresh key from Cursor Dashboard -> API Keys.";
      case 403:
        return "Error: Permission denied. This API key doesn't have access to that agent, run, or repository.";
      case 404:
        return "Error: Not found. Double-check the agent or run ID — it may have been deleted, or belong to a different account.";
      case 409:
        if (detail?.includes("agent_busy")) {
          return "Error: This agent already has an active run. Poll cursor_get_run until it reaches a terminal status (FINISHED, ERROR, CANCELLED, EXPIRED) before sending another follow-up, or cancel the current run first.";
        }
        if (detail?.includes("agent_id_conflict")) {
          return "Error: An agent with this agentId already exists. Omit agentId to let Cursor generate one, or use the existing agent instead.";
        }
        if (detail?.includes("run_not_cancellable")) {
          return "Error: This run is already in a terminal state (or was never active) and cannot be cancelled.";
        }
        return `Error: Conflict${detail ? ` — ${detail}` : ""}.`;
      case 429:
        return "Error: Rate limit exceeded. Cursor enforces especially strict limits on GET /v1/repositories (1/minute, 30/hour) — wait before retrying.";
      case 410:
        return "Error: This resource has expired (for example, a run's SSE stream past its retention window). Fetch the run's current state with cursor_get_run instead.";
      default:
        if (status) {
          return `Error: Cursor API request failed with status ${status}${detail ? ` — ${detail}` : ""}.`;
        }
    }
    if (error.code === "ECONNABORTED") {
      return "Error: Request to the Cursor API timed out. Please try again.";
    }
  }
  return `Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`;
}
