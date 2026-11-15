import type { RecordReader } from "../../src/livespace/v2/records.js";
import type { TimelineReader } from "../../src/livespace/v2/timeline.js";

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

/** The record timeline lists, loud on an unexpected call like the reader. */
export function fakeTimeline(overrides: Partial<TimelineReader> = {}): TimelineReader {
  return { recordEntries: unexpectedCall, ...overrides } as TimelineReader;
}
