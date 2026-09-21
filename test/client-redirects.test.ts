import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DelegaApiError, DelegaClient } from "../src/delega-client.js";

async function start(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("API redirects are refused without forwarding, retrying, or retaining redirect content", async t => {
  for (const method of ["GET", "POST"]) {
    for (const status of [301, 302, 303, 307, 308]) {
      for (const relative of [false, true]) {
        await t.test(`${method} ${status} ${relative ? "relative" : "different origin"}`, async () => {
          let targetCalls = 0, originCalls = 0;
          const target = createServer(async (request, response) => {
            targetCalls++;
            for await (const _chunk of request) { /* consume synthetic payload */ }
            response.setHeader("Content-Type", "application/json");
            response.end('{"id":"synthetic-task"}');
          });
          const targetUrl = await start(target);
          const origin = createServer(async (request, response) => {
            for await (const _chunk of request) { /* consume synthetic payload */ }
            if (request.url?.startsWith("/redirect-target")) {
              targetCalls++;
              response.setHeader("Content-Type", "application/json");
              response.end('{"id":"synthetic-task"}');
              return;
            }
            originCalls++;
            response.writeHead(status, "SYNTHETIC-STATUS-DETAIL", {
              Location: `${relative ? "" : targetUrl}/redirect-target?token=SYNTHETIC-LOCATION`,
              "Content-Type": "application/json",
            });
            response.end(JSON.stringify({ error: "SYNTHETIC-BODY-DETAIL", echoed_key: request.headers["x-agent-key"] }));
          });
          const originUrl = await start(origin);
          const client = new DelegaClient(originUrl, "synthetic-agent", "synthetic-access-id", "synthetic-access-secret");
          try {
            await assert.rejects(
              () => method === "GET" ? client.getTask("synthetic-task") : client.createTask({ content: "Synthetic checklist" }),
              (error: unknown) => {
                assert.ok(error instanceof DelegaApiError);
                assert.equal(error.status, status);
                assert.equal(error.statusText, "Redirect refused");
                assert.equal(error.responseBody, "");
                assert.doesNotMatch(error.message, /SYNTHETIC|synthetic-agent|redirect-target/);
                return true;
              },
            );
            assert.equal(originCalls, 1, "a redirect is not a transient network failure");
            assert.equal(targetCalls, 0, "no target receives any request, body, or credential");
          } finally { await close(origin); await close(target); }
        });
      }
    }
  }
});

test("direct API responses still work with all configured authentication headers", async () => {
  let calls = 0;
  let authenticated = false;
  const origin = createServer((request, response) => {
    calls++;
    authenticated = request.headers["x-agent-key"] === "synthetic-agent"
      && request.headers["cf-access-client-id"] === "synthetic-access-id"
      && request.headers["cf-access-client-secret"] === "synthetic-access-secret";
    response.setHeader("Content-Type", "application/json");
    response.end('{"id":"synthetic-task"}');
  });
  const url = await start(origin);
  try {
    const client = new DelegaClient(url, "synthetic-agent", "synthetic-access-id", "synthetic-access-secret");
    assert.deepEqual(await client.getTask("synthetic-task"), { id: "synthetic-task" });
    assert.equal(calls, 1); assert.equal(authenticated, true);
  } finally { await close(origin); }
});
