import type { RecordReader } from "../../src/livespace/v2/records.js";

function unexpectedCall(): never {
  throw new Error("record reader not configured for this test");
}

/**
 * A synthetic API v2 record reader for wire tests. Only the members a test
 * overrides answer; everything else throws, so an unexpected upstream call is
 * loud rather than silently empty.
 */
export function fakeRecordReader(overrides: Partial<RecordReader> = {}): RecordReader {
  return {
    search: unexpectedCall,
    phrase: unexpectedCall,
    get: unexpectedCall,
    dealProcess: unexpectedCall,
    dealLines: unexpectedCall,
    dealBudget: unexpectedCall,
    ...overrides,
  } as RecordReader;
}
