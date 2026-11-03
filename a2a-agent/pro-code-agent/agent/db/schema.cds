namespace agent.config;

/**
 * Key-value configuration store.
 * Well-known key: MCP_SERVER_SETTING  — value is a JSON string (mcpServers object).
 * On HANA the LargeString type maps to NCLOB, giving CLOB-equivalent storage for large JSON payloads.
 */
entity AgentConfiguration {
    key name  : String(255);
        value : LargeString;
}
