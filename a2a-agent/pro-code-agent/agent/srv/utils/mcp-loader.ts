import cds from "@sap/cds";
import { MCPAdapter } from "@langchain/mcp-adapters";
import type { Connection } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

const logger = cds.log("pro-code-agent", { label: "MCP Loader" });

/**
 * Claude Code mcpServers format (subset we support):
 *   { "server-name": { "command": "npx", "args": [...], "env": {...} } }          — stdio
 *   { "server-name": { "url": "https://...", "type": "sse"|"http", "headers": {...} } } — HTTP/SSE
 */
type ClaudeStdioEntry = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
};

type ClaudeHttpEntry = {
    url: string;
    type?: "sse" | "http" | "streamable_http";
    headers?: Record<string, string>;
};

type ClaudeMcpEntry = ClaudeStdioEntry | ClaudeHttpEntry;
type ClaudeMcpServers = Record<string, ClaudeMcpEntry>;

function toAdapterConnection(entry: ClaudeMcpEntry): Connection {
    if ("url" in entry) {
        const transport = entry.type === "sse" ? "sse" : "streamable_http";
        return { transport, url: entry.url, headers: entry.headers } as Connection;
    }
    return {
        transport: "stdio",
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env
    } as Connection;
}

export async function loadMcpTools(): Promise<DynamicStructuredTool[]> {
    const raw = process.env.MCP_SERVER_SETTING;
    if (!raw) {
        logger.info("[MCP] MCP_SERVER_SETTING not set — no MCP tools loaded");
        return [];
    }

    let parsed: ClaudeMcpServers;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logger.error("[MCP] Failed to parse MCP_SERVER_SETTING JSON:", err);
        return [];
    }

    const serverNames = Object.keys(parsed);
    if (serverNames.length === 0) {
        logger.info("[MCP] MCP_SERVER_SETTING is empty — no MCP tools loaded");
        return [];
    }

    const servers: Record<string, Connection> = {};
    for (const name of serverNames) {
        servers[name] = toAdapterConnection(parsed[name]);
    }

    logger.info(`[MCP] Connecting to ${serverNames.length} MCP server(s): ${serverNames.join(", ")}`);

    const client = new MCPAdapter({ servers });

    let toolsByServer: Record<string, DynamicStructuredTool[]>;
    try {
        toolsByServer = await client.listToolsets();
    } catch (err) {
        logger.error("[MCP] Failed to discover MCP tools:", err);
        return [];
    }

    const allTools: DynamicStructuredTool[] = [];
    for (const [server, tools] of Object.entries(toolsByServer)) {
        logger.info(`[MCP] Server "${server}" provided ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
        allTools.push(...tools);
    }

    logger.info(`[MCP] Total MCP tools loaded: ${allTools.length}`);
    return allTools;
}
