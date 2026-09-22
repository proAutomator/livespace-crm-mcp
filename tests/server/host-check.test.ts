import { expect, test } from "bun:test";
import { createHostCheck, SYNTHETIC_HOST_TOKEN } from "../../scripts/host-check.js";

function call(name: string, args: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1:3020/mcp", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3020",
      authorization: `Bearer ${SYNTHETIC_HOST_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name, arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "synthetic-host", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

test("host probe exposes an unpredictable marker only in structured record data", async () => {
  const probe = createHostCheck();
  expect(probe.marker).not.toBe(createHostCheck().marker);
  const response = await probe.app.request(call("get_records", {
    kind: "person", ids: ["person-synthetic-001"], detail: "full",
  }));
  const body = await response.json() as any;
  expect(body.result.structuredContent.items[0].person.note).toBe(probe.marker);
  expect(JSON.stringify(body.result.content)).not.toContain(probe.marker);
  expect(probe.writeCount()).toBe(0);
});

test("host probe uses production preview and safe refusal without in-memory writes", async () => {
  const probe = createHostCheck();
  const args = { persons: [{ firstname: "Synthetic Host Check" }] };
  const preview = await probe.app.request(call("create_records", { ...args, dryRun: true }));
  const previewBody = await preview.json() as any;
  expect(previewBody.result.isError).not.toBe(true);
  expect(previewBody.result.structuredContent.requiresConfirmation).toBeUndefined();
  expect(previewBody.result.structuredContent.plan[0].status).toBe("create");
  expect(previewBody.result.structuredContent.results).toBeUndefined();
  const refused = await probe.app.request(call("create_records", { ...args, confirm: true }));
  const refusedBody = await refused.json() as any;
  expect(refusedBody.result.isError).toBe(true);
  expect(JSON.stringify(refusedBody.result)).toContain("BAD_PARAMS");
  expect(probe.writeCount()).toBe(0);
});
