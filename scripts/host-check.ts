import { loadServerConfig } from "../src/config/server-env.js";
import type { RecordFetchers } from "../src/livespace/records.js";
import type { WriteFetchers } from "../src/livespace/writes.js";
import { buildApp } from "../src/server/app.js";
import type { MetadataService } from "../src/server/tools/crm-metadata.js";
import { person } from "../tests/support/records.js";

// Public, synthetic fixture value. Never use it with a real CRM backend.
export const SYNTHETIC_HOST_TOKEN = "synthetic-host-check-token-0123456789-abcd";

/** The real MCP app, backed only by memory. No Livespace client or env config. */
export function createHostCheck() {
  const marker = `synthetic-structured-${crypto.randomUUID()}`;
  const rows = new Map([["person-synthetic-001", person({ note: marker })]]);
  let writes = 0;
  const unsupported = async (): Promise<never> => {
    throw new Error("Operation outside the synthetic host check.");
  };
  const records: RecordFetchers = {
    listPersons: unsupported,
    listCompanies: unsupported,
    listDeals: unsupported,
    listTasks: unsupported,
    searchPhrase: unsupported,
    getRecord: (async (kind: string, id: string) =>
      kind === "person" ? rows.get(id) ?? null : null) as RecordFetchers["getRecord"],
  };
  const writeFetchers: WriteFetchers = {
    createPerson: async (input) => {
      const id = `person-synthetic-created-${++writes}`;
      rows.set(id, person({
        id,
        name: [input.firstname, input.lastname].filter(Boolean).join(" "),
        email: input.emails?.[0] ?? "",
        emails: input.emails ?? [],
        phone: input.phones?.[0] ?? "",
        phones: input.phones ?? [],
        note: input.note ?? "",
        companyId: input.companyId ?? null,
      }));
      return { id };
    },
    createCompany: unsupported,
    createDeal: unsupported,
    createTask: unsupported,
    updatePerson: unsupported,
    updateCompany: unsupported,
    updateDeal: unsupported,
    updateTask: unsupported,
    addNote: unsupported,
    addCall: unsupported,
    moveDealSteps: unsupported,
    sendNotification: unsupported,
    findPersonByEmail: async () => null,
    findCompanyByName: async () => null,
  };
  const metadata: MetadataService = { get: unsupported };
  const app = buildApp({
    version: "0.0.0-synthetic-host-check",
    config: loadServerConfig({
      LIVESPACE_MCP_ENABLE_WRITES: "true",
      MCP_AUTH_TOKEN: SYNTHETIC_HOST_TOKEN,
      MCP_REQUEST_STATE_KEY: `synthetic-${crypto.randomUUID()}`,
    }),
    records, metadata, writes: writeFetchers,
  });
  return { app, marker, writeCount: () => writes };
}

if (import.meta.main) {
  const probe = createHostCheck();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      // Only transport metadata and counters. Never log arguments, auth or results.
      const response = await probe.app.fetch(request);
      console.log(JSON.stringify({
        event: "request",
        protocol: request.headers.get("mcp-protocol-version"),
        method: request.headers.get("mcp-method"),
        tool: request.headers.get("mcp-name"),
        status: response.status,
        writes: probe.writeCount(),
      }));
      return response;
    },
  });
  console.log(JSON.stringify({
    event: "ready", url: `http://127.0.0.1:${server.port}/mcp`,
    // This invented per-run value is the expected answer, not a credential.
    // Do not give it to the host: retrieve it through get_records instead.
    expectedMarker: probe.marker,
  }));
  const stop = () => {
    console.log(JSON.stringify({ event: "stopped", writes: probe.writeCount() }));
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
