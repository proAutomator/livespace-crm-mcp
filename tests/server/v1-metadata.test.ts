import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../src/livespace/errors.js";
import { createV1MetadataService } from "../../src/server/v1-metadata.js";

// The v1 dictionary service behind the tools that still run on the
// signed-session API. Its tool-level tests moved with crm_metadata to API v2.

function fixedClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function fakeClient(responses: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      call: (async (module: string, method: string) => {
        const key = `${module}/${method}`;
        calls.push(key);
        if (!(key in responses)) {
          throw new LivespaceError(
            "UPSTREAM_ERROR",
            `no synthetic response for ${key}`,
            "fixture gap",
          );
        }
        const canned = responses[key];
        if (canned instanceof LivespaceError) throw canned;
        return canned;
      }) as never,
    },
  };
}

describe("createV1MetadataService", () => {
  test("caches per section and fetches each section separately", async () => {
    const clock = fixedClock();
    const { client, calls } = fakeClient({
      "Todo/getTypes": { "tt-synthetic-1": "Synthetic Task Type" },
      "Default/User_getAll": [
        {
          id: "user-synthetic-1",
          name: "Synthetic User",
          email: "synthetic.user@example.invalid",
        },
      ],
    });
    const service = createV1MetadataService(client, {
      now: clock.now,
      jitter: () => 0.5,
    });

    const first = await service.get("taskTypes");
    const second = await service.get("taskTypes");
    expect(calls.filter((key) => key === "Todo/getTypes")).toHaveLength(1);
    expect(second.asOf).toBe(first.asOf);
    expect(second.data).toEqual([{ id: "tt-synthetic-1", name: "Synthetic Task Type" }]);

    const users = await service.get("users");
    expect(calls).toContain("Default/User_getAll");
    expect(users.data).toEqual([
      {
        id: "user-synthetic-1",
        name: "Synthetic User",
        email: "synthetic.user@example.invalid",
        teams: [],
      },
    ]);
  });

  const CURRENT_USER_INFO = {
    name: "Synthetic User One",
    email: "one@synthetic.example",
    position: "Synthetic Position",
    app_settings: { permission: { contact_add: true } },
  };

  const USER_LIST = [
    { id: "user-synthetic-9", name: "Synthetic Other", email: "other@synthetic.example" },
    { id: "user-synthetic-1", name: "Synthetic User One", email: "one@synthetic.example" },
  ];

  test("currentUser gets its id from the cached user list", async () => {
    const { client } = fakeClient({
      "Default/User_getInfo": CURRENT_USER_INFO,
      "Default/User_getAll": USER_LIST,
    });
    const service = createV1MetadataService(client);

    const current = await service.get("currentUser");
    expect(current.data.id).toBe("user-synthetic-1");
    expect(current.data.name).toBe("Synthetic User One");
  });

  test("currentUser keeps a null id when no user matches the email", async () => {
    const { client } = fakeClient({
      "Default/User_getInfo": CURRENT_USER_INFO,
      "Default/User_getAll": [USER_LIST[0]],
    });
    const service = createV1MetadataService(client);

    expect((await service.get("currentUser")).data.id).toBeNull();
  });

  test("a failing user list still yields currentUser with a null id", async () => {
    const { client } = fakeClient({
      "Default/User_getInfo": CURRENT_USER_INFO,
      "Default/User_getAll": new LivespaceError(
        "PERMISSION_DENIED",
        "The API key's user lacks permission for this record or action (540).",
        "Use a record the key's user can access.",
        540,
      ),
    });
    const service = createV1MetadataService(client);

    const current = await service.get("currentUser");
    expect(current.data.id).toBeNull();
    expect(current.data.name).toBe("Synthetic User One");
  });

  test("currentUser and users share a single User_getAll per ttl", async () => {
    const { client, calls } = fakeClient({
      "Default/User_getInfo": CURRENT_USER_INFO,
      "Default/User_getAll": USER_LIST,
    });
    const service = createV1MetadataService(client);

    await service.get("currentUser");
    await service.get("users");

    expect(calls.filter((key) => key === "Default/User_getAll")).toHaveLength(1);
  });

  test("serves stale data when a refresh fails", async () => {
    const clock = fixedClock();
    const responses: Record<string, unknown> = {
      "Todo/getTypes": { "tt-synthetic-1": "Synthetic Task Type" },
    };
    const { client } = fakeClient(responses);
    const service = createV1MetadataService(client, {
      now: clock.now,
      jitter: () => 0.5,
    });

    const fresh = await service.get("taskTypes");
    expect(fresh.stale).toBe(false);

    clock.advance(5 * 60_000 + 1);
    responses["Todo/getTypes"] = new LivespaceError(
      "UPSTREAM_ERROR",
      "Livespace reported a general API error (500).",
      "Retry once; if it persists, reduce the request size.",
    );

    const stale = await service.get("taskTypes");
    expect(stale.stale).toBe(true);
    expect(stale.asOf).toBe(fresh.asOf);
    expect(stale.data).toEqual([{ id: "tt-synthetic-1", name: "Synthetic Task Type" }]);
  });
});
