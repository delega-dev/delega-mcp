import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DelegaClient } from "./delega-client.js";
import { createHumanRequestConnector, parseHumanRequestTaskIds } from "./human-request-connector.js";

async function main() {
  const taskIds = parseHumanRequestTaskIds(process.env.DELEGA_HUMAN_REQUEST_TASK_IDS);
  const key = process.env.DELEGA_AGENT_KEY || process.env.DELEGA_API_KEY;
  if (!key?.trim()) throw new Error("Missing host credential");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const client = new DelegaClient(process.env.DELEGA_API_URL, key,
    process.env.DELEGA_CF_ACCESS_CLIENT_ID, process.env.DELEGA_CF_ACCESS_CLIENT_SECRET);
  const server = createHumanRequestConnector({ client, taskIds, version: packageJson.version });
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  // Startup failures can contain a malformed URL or other sensitive config.
  console.error("Human-request connector could not start. Check the host task scope, API URL, credential, and paired Access settings.");
  process.exitCode = 1;
});
