import cds from "@sap/cds";
import { MCPAdapter } from "@langchain/mcp-adapters";
import type { Connection } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

const logger = cds.log("pro-code-agent", { label: "MCP Loader" });

/**
 * Claude Code mcpServers format (subset we support):
 *   stdio: { command, args?, env? }
 *   HTTP:  { url, type?: "sse"|"http"|"streamable_http", headers? }
 */
export type ClaudeStdioEntry = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
};

export type ClaudeHttpEntry = {
    url: string;
    type?: "sse" | "http" | "streamable_http";
    headers?: Record<string, string>;
};

export type ClaudeMcpEntry = ClaudeStdioEntry | ClaudeHttpEntry;
export type ClaudeMcpServers = Record<string, ClaudeMcpEntry>;

export function toAdapterConnection(entry: ClaudeMcpEntry): Connection {
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

/**
 * Connect to the servers described in `config` and return all discovered LangChain tools.
 * The caller is responsible for merging configs from multiple sources before calling this.
 */
export async function loadMcpTools(config: ClaudeMcpServers): Promise<DynamicStructuredTool[]> {
    const serverNames = Object.keys(config);
    if (serverNames.length === 0) {
        return [];
    }

    const servers: Record<string, Connection> = {};
    for (const name of serverNames) {
        servers[name] = toAdapterConnection(config[name]);
    }

    logger.info(`[MCP] Connecting to ${serverNames.length} server(s): ${serverNames.join(", ")}`);

    const client = new MCPAdapter({ servers });

    let toolsByServer: Record<string, DynamicStructuredTool[]>;
    try {
        toolsByServer = await client.listToolsets();
    } catch (err) {
        logger.error("[MCP] Failed to discover tools:", err);
        return [];
    }

    const allTools: DynamicStructuredTool[] = [];
    for (const [server, tools] of Object.entries(toolsByServer)) {
        logger.info(`[MCP] "${server}" → ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
        allTools.push(...tools);
    }

    logger.info(`[MCP] Total tools loaded: ${allTools.length}`);
    return allTools;
}
