import { describe, expect, test } from "bun:test";
import { projectRecord, type DetailLevel } from "../../../src/livespace/v2/records.js";
import {
  companyV2Schema,
  dealV2Schema,
  personV2Schema,
  taskV2Schema,
} from "../../../src/server/tools/record-schemas.js";
import { companyV2, dealV2, personV2, taskV2 } from "../../support/v2-records.js";

const LEVELS: DetailLevel[] = ["minimal", "standard", "full"];

describe("API v2 record schemas", () => {
  test("every kind validates at every detail level and keeps every key", () => {
    for (const detail of LEVELS) {
      const cases = [
        [personV2Schema, projectRecord("person", personV2(), detail)],
        [companyV2Schema, projectRecord("company", companyV2(), detail)],
        [
          dealV2Schema,
          projectRecord(
            "deal",
            dealV2({ status: "won", reason: { kind: "won", name: "SYNTHETIC reason", note: null } }),
            detail,
          ),
        ],
        [taskV2Schema, projectRecord("task", taskV2(), detail)],
      ] as const;
      for (const [schema, record] of cases) {
        // Strict schemas: a key the schema does not know fails the parse, and
        // a key it dropped would fail the equality.
        expect(schema.parse(record)).toEqual(record as never);
      }
    }
  });

  test("the schemas are strict: one kind does not validate as another", () => {
    expect(personV2Schema.safeParse(dealV2()).success).toBe(false);
    expect(dealV2Schema.safeParse(taskV2()).success).toBe(false);
    expect(companyV2Schema.safeParse({ ...companyV2(), unknown: 1 }).success).toBe(false);
    expect(taskV2Schema.safeParse(personV2()).success).toBe(false);
  });
});
