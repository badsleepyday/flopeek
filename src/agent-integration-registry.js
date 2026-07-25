const AGENT_PLATFORM_REGISTRY_SCHEMA = "flopeek-agent-platform-registry/v1";

const PLATFORMS = Object.freeze([
  {
    id: "claude",
    label: "Claude Code",
    status: "supported",
    executables: ["claude"],
    skillDirectory: ".claude/skills/flopeek",
    mcpConfig: ".mcp.json",
    configFormat: "json-mcp-servers",
    localStdio: true,
  },
  {
    id: "codex",
    label: "Codex",
    status: "supported",
    executables: ["codex"],
    skillDirectory: ".agents/skills/flopeek",
    mcpConfig: ".codex/config.toml",
    configFormat: "toml-managed-block",
    localStdio: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    status: "supported",
    executables: ["cursor-agent", "cursor"],
    skillDirectory: ".cursor/skills/flopeek",
    mcpConfig: ".cursor/mcp.json",
    configFormat: "json-mcp-servers",
    localStdio: true,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    status: "supported",
    executables: ["gemini"],
    skillDirectory: ".gemini/skills/flopeek",
    mcpConfig: ".gemini/settings.json",
    configFormat: "json-mcp-servers",
    localStdio: true,
  },
  {
    id: "chatgpt-web",
    label: "ChatGPT web",
    status: "remote-only",
    executables: [],
    skillDirectory: null,
    mcpConfig: null,
    configFormat: null,
    localStdio: false,
    reason: "ChatGPT web does not load project-local MCP stdio configuration. Use a supported local host or a separately deployed remote integration.",
  },
]);

function platformRegistry() {
  return { schemaVersion: AGENT_PLATFORM_REGISTRY_SCHEMA, platforms: PLATFORMS.map((item) => ({ ...item })) };
}

function findPlatform(id) {
  return PLATFORMS.find((platform) => platform.id === id) || null;
}

module.exports = { AGENT_PLATFORM_REGISTRY_SCHEMA, findPlatform, platformRegistry };
