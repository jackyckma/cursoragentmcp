#!/usr/bin/env node
/**
 * cursor-agent-mcp-server
 *
 * MCP server wrapping the Cursor Cloud Agents API v1 (public beta), so an
 * MCP client (Claude, etc.) can launch, monitor, and converse with Cursor
 * Cloud Agents that work on GitHub repositories.
 *
 * Transport is chosen via the TRANSPORT env var:
 *   - "http" (default): Streamable HTTP, for remote deployment (e.g. Zeabur).
 *   - "stdio": local subprocess transport, for Claude Desktop / Claude Code.
 */

import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

function requireCursorApiKey(): void {
  if (!process.env.CURSOR_API_KEY) {
    console.error(
      "ERROR: CURSOR_API_KEY environment variable is required. Generate one from Cursor Dashboard -> API Keys, then set it before starting this server."
    );
    process.exit(1);
  }
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "cursor-agent-mcp-server",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

async function runStdio(): Promise<void> {
  requireCursorApiKey();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cursor-agent-mcp-server running via stdio");
}

/**
 * Constant-time-ish bearer token check. This server can create billable
 * Cursor Cloud Agents, so the HTTP endpoint MUST NOT be left open on a
 * public Zeabur URL without a shared secret. Set MCP_SERVER_TOKEN and
 * configure the same value in your MCP client's Authorization header.
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_SERVER_TOKEN;
  if (!expected) {
    // No token configured: allow, but this was already warned about at boot.
    next();
    return;
  }
  const header = req.header("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

async function runHTTP(): Promise<void> {
  requireCursorApiKey();

  if (!process.env.MCP_SERVER_TOKEN) {
    console.error(
      "WARNING: MCP_SERVER_TOKEN is not set. This server's /mcp endpoint will be reachable by anyone who finds the URL, and can create billable Cursor Cloud Agents. Set MCP_SERVER_TOKEN before deploying publicly."
    );
  }

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", authMiddleware, async (req, res) => {
    try {
      // Stateless: a fresh server + transport per request avoids request-id
      // collisions across concurrent clients and keeps deployment simple.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling /mcp request:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`cursor-agent-mcp-server listening on http://0.0.0.0:${port}/mcp`);
  });
}

const transport = process.env.TRANSPORT || "http";
if (transport === "stdio") {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runHTTP().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
