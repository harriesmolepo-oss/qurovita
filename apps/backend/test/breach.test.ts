import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkFhirAccess } from "../src/popia/breach.js";
import type { Pool, QueryResult } from "pg";

// Minimal mock pool — only implements .query()
function makeMockPool() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (text: string, values?: unknown[]): Promise<QueryResult> => {
      calls.push({ text, values: values ?? [] });
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
    }),
    _calls: calls,
  } as unknown as Pool & { _calls: typeof calls };
  return pool;
}

describe("checkFhirAccess — POPIA breach detection", () => {
  let mockPool: ReturnType<typeof makeMockPool>;

  beforeEach(() => {
    mockPool = makeMockPool();
  });

  it("does NOT insert a breach_candidates row when actor owns the data", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    await checkFhirAccess(
      { actorId: userId, actorKind: "patient", targetUserId: userId, resourceType: "Observation" },
      mockPool,
    );
    expect(mockPool._calls).toHaveLength(0);
  });

  it("inserts a breach_candidates row when actor reads another user's FHIR data", async () => {
    const actorId  = "aaaaaaaa-0000-0000-0000-000000000000";
    const targetId = "bbbbbbbb-0000-0000-0000-000000000000";

    await checkFhirAccess(
      { actorId, actorKind: "provider", targetUserId: targetId, resourceType: "Condition" },
      mockPool,
    );

    expect(mockPool._calls).toHaveLength(1);
    const call = mockPool._calls[0];
    expect(call.text).toMatch(/insert into breach_candidates/i);
    // $1 = actorId, $2 = actorKind, $3 = targetUserId
    expect(call.values[0]).toBe(actorId);
    expect(call.values[1]).toBe("provider");
    expect(call.values[2]).toBe(targetId);
  });

  it("records the resource type in query_context", async () => {
    const actorId  = "aaaaaaaa-0000-0000-0000-000000000000";
    const targetId = "cccccccc-0000-0000-0000-000000000000";

    await checkFhirAccess(
      { actorId, actorKind: "system", targetUserId: targetId, resourceType: "MedicationStatement" },
      mockPool,
    );

    const queryContext = JSON.parse(mockPool._calls[0].values[3] as string) as {
      resourceType: string;
    };
    expect(queryContext.resourceType).toBe("MedicationStatement");
  });
});
