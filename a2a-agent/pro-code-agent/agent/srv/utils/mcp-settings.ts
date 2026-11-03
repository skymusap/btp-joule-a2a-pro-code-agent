import path from "path";
import fs from "fs";
import cds from "@sap/cds";
import type { ClaudeMcpServers } from "./mcp-loader";

const logger = cds.log("pro-code-agent", { label: "MCP Settings" });

const CONFIG_KEY = "MCP_SERVER_SETTING";
const LOCAL_FILE = path.resolve(process.cwd(), "config/mcp_servers.json");

// ---------------------------------------------------------------------------
// Source 4 — code static (developer essential servers, lowest priority)
// Override this constant to embed MCP servers that are always required.
// ---------------------------------------------------------------------------
const STATIC_MCP_SERVERS: ClaudeMcpServers = {};

// ---------------------------------------------------------------------------
// Source 3 — local file  config/mcp_servers.json  (developer additional)
// ---------------------------------------------------------------------------
function loadFromFile(): ClaudeMcpServers {
    try {
        if (!fs.existsSync(LOCAL_FILE)) return {};
        const raw = fs.readFileSync(LOCAL_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        // Strip comment/example keys that start with "_"
        const servers: ClaudeMcpServers = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (!k.startsWith("_")) servers[k] = v as ClaudeMcpServers[string];
        }
        const count = Object.keys(servers).length;
        if (count > 0) logger.info(`[MCP-Settings] file: ${count} server(s) from ${LOCAL_FILE}`);
        return servers;
    } catch (err) {
        logger.warn("[MCP-Settings] file: failed to read config/mcp_servers.json —", err);
        return {};
    }
}

// ---------------------------------------------------------------------------
// Source 2 — environment variable  MCP_SERVER_SETTING  (admin managed)
// ---------------------------------------------------------------------------
function loadFromEnv(): ClaudeMcpServers {
    const raw = process.env[CONFIG_KEY];
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as ClaudeMcpServers;
        const count = Object.keys(parsed).length;
        logger.info(`[MCP-Settings] env: ${count} server(s) from ${CONFIG_KEY}`);
        return parsed;
    } catch (err) {
        logger.error("[MCP-Settings] env: failed to parse MCP_SERVER_SETTING —", err);
        return {};
    }
}

// ---------------------------------------------------------------------------
// Source 1 — DB table agent.config.AgentConfiguration  (customer managed, highest)
// ---------------------------------------------------------------------------
async function loadFromDb(): Promise<ClaudeMcpServers> {
    try {
        const db = await cds.connect.to("db");
        const { AgentConfiguration } = db.entities("agent.config");
        const row = await db.run(SELECT.one(AgentConfiguration).where({ name: CONFIG_KEY }));
        if (!row?.value) return {};
        const parsed = JSON.parse(row.value) as ClaudeMcpServers;
        const count = Object.keys(parsed).length;
        logger.info(`[MCP-Settings] db: ${count} server(s) from AgentConfiguration`);
        return parsed;
    } catch (err) {
        // DB might not be available in local dev (sqlite not seeded, etc.) — degrade gracefully
        logger.warn("[MCP-Settings] db: could not read AgentConfiguration —", (err as Error).message);
        return {};
    }
}

// ---------------------------------------------------------------------------
// Merge helper — later sources win (higher priority overwrites lower)
// ---------------------------------------------------------------------------
function merge(...layers: ClaudeMcpServers[]): ClaudeMcpServers {
    const result: ClaudeMcpServers = {};
    for (const layer of layers) {
        Object.assign(result, layer);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and merge MCP server settings from all four sources.
 *
 * Priority (highest wins on name collision):
 *   1. DB  AgentConfiguration[MCP_SERVER_SETTING]  — customer-managed
 *   2. env  MCP_SERVER_SETTING                      — admin-managed
 *   3. config/mcp_servers.json                      — developer additional
 *   4. STATIC_MCP_SERVERS (code constant)           — developer essential
 */
export async function loadMcpSettings(): Promise<ClaudeMcpServers> {
    const [dbServers, envServers, fileServers] = await Promise.all([
        loadFromDb(),
        Promise.resolve(loadFromEnv()),
        Promise.resolve(loadFromFile())
    ]);

    // Merge lowest → highest so each higher layer overwrites same-named keys
    const merged = merge(STATIC_MCP_SERVERS, fileServers, envServers, dbServers);

    const total = Object.keys(merged).length;
    logger.info(`[MCP-Settings] merged total: ${total} server(s) — ${Object.keys(merged).join(", ") || "(none)"}`);
    return merged;
}
