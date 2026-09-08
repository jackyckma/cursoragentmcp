// Types mirror the Cursor Cloud Agents API v1 (public beta) response shapes.
// See: https://cursor.com/docs/cloud-agent/api/endpoints

export type AgentStatus = "ACTIVE" | "IDLE" | "ARCHIVED";
export type RunStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

export interface AgentEnv {
  type: "cloud" | "pool" | "machine";
  name?: string;
}

export interface AgentRepo {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

export interface Agent {
  id: string;
  name?: string;
  status: AgentStatus;
  env?: AgentEnv;
  repos?: AgentRepo[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  url?: string;
  createdAt: string;
  updatedAt: string;
  latestRunId?: string;
}

export interface GitBranch {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
}

export interface Run {
  id: string;
  agentId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  result?: string;
  git?: { branches: GitBranch[] };
}

export interface CreateAgentResponse {
  agent: Agent;
  run: Run;
}

export interface ListAgentsResponse {
  items: Agent[];
  nextCursor?: string;
}

export interface ListRunsResponse {
  items: Run[];
}

export interface CreateRunResponse {
  run: Run;
}

export interface ModelParamValue {
  value: string;
  displayName?: string;
}

export interface ModelParameter {
  id: string;
  displayName?: string;
  values: ModelParamValue[];
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: ModelParameter[];
}

export interface ListModelsResponse {
  items: ModelInfo[];
}

export interface ListRepositoriesResponse {
  items: { url: string }[];
}

export interface UsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface AgentUsageResponse {
  totalUsage: UsageEntry;
  runs: { id: string; usageUuid?: string; usage: UsageEntry }[];
}
