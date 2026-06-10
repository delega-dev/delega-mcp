#!/usr/bin/env node
// Keep server.json (MCP registry manifest) version in sync with package.json.
// Wired as the npm "version" lifecycle script, so `npm version <x>` bumps both
// and stages server.json into the version commit. Prevents the publish guard
// (scripts/prepublish-check.sh) from failing on a version mismatch.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

const server = JSON.parse(readFileSync("server.json", "utf8"));
server.version = version;
if (Array.isArray(server.packages)) {
  for (const p of server.packages) p.version = version;
}
writeFileSync("server.json", JSON.stringify(server, null, 2) + "\n");
console.log(`synced server.json -> ${version}`);
