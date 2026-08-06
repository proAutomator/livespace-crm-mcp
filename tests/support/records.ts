import type { WallEntry } from "../../src/livespace/activity.js";
import type {
  CompanyRecord,
  DealRecord,
  PersonRecord,
  TaskRecord,
} from "../../src/livespace/records.js";

/**
 * Synthetic record builders shared by the tool tests.
 *
 * Every value below is invented. No CRM data, no sandbox values (AGENTS.md).
 * One copy so a field added to a record shape is added once and every tool test
 * fails until it is filled in - four drifting copies used to hide that.
 *
 * Each builder returns a FULL record. Tests that need a projection ask for it
 * explicitly, so nothing here silently stands in for a `detail` cut.
 */

export function person(overrides: Partial<PersonRecord> = {}): PersonRecord {
  return {
    id: "person-synthetic-001",
    name: "Synthetic Person One",
    email: "person.one@synthetic.example",
    phone: "+00 000 000 001",
    emails: ["person.one@synthetic.example"],
    phones: ["+00 000 000 001"],
    companyName: "Synthetic Company Alpha",
    companyId: "company-synthetic-101",
    ownerName: "Synthetic Owner",
    ownerId: "user-synthetic-201",
    tags: ["alpha"],
    source: "Synthetic Source",
    note: "Synthetic note text",
    created: "2025-10-08 15:19:13+02",
    modified: "2025-11-02 09:00:00+02",
    lastActiveDate: "2025-11-03 12:30:00+02",
    dealCount: { all: 4, open: 2, won: 1, lost: 1 },
    cell: "+00 000 000 002",
    www: "https://alpha.synthetic.example",
    address: "Synthetic Street 1, Synthetic City",
    groups: ["Group One"],
    url: "https://synthetic.livespace.io/Contact/contact/details/api_id/person-synthetic-001",
    ...overrides,
  };
}

export function company(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    id: "company-synthetic-101",
    name: "Synthetic Company Alpha",
    nip: "0000000000",
    email: "office@alpha.synthetic.example",
    phone: "+00 000 000 003",
    ownerName: "Synthetic Owner",
    ownerId: "user-synthetic-201",
    tags: ["gamma"],
    source: "Synthetic Source",
    note: "Synthetic company note",
    created: "2025-09-01 08:00:00+02",
    modified: "2025-11-04 10:15:00+02",
    dealCount: { all: 7, open: 3, won: 2, lost: 2 },
    www: "https://alpha.synthetic.example",
    address: "Synthetic Avenue 9, Synthetic City",
    groups: ["Group Three"],
    url: "https://synthetic.livespace.io/Contact/company/details/api_id/company-synthetic-101",
    ...overrides,
  };
}

export function deal(overrides: Partial<DealRecord> = {}): DealRecord {
  return {
    id: "deal-synthetic-401",
    name: "Synthetic Deal One",
    status: "open",
    value: 1234.5,
    currency: "PLN",
    probability: 5,
    processId: "process-synthetic-501",
    processName: "Synthetic Process",
    stageId: "stage-synthetic-601",
    stageName: "Synthetic Stage",
    substageId: "substage-synthetic-701",
    substageName: "Synthetic Substage",
    companyId: "company-synthetic-101",
    companyName: "Synthetic Company Alpha",
    contactId: "person-synthetic-001",
    contactName: "Synthetic Person One",
    ownerId: "user-synthetic-201",
    ownerName: "Synthetic Owner",
    dateEnd: "2025-12-13",
    created: "2025-10-01 11:00:00+02",
    modified: "2025-11-05 16:45:00+02",
    lastActiveDate: "2025-11-06 08:10:00+02",
    tags: ["delta"],
    source: "Synthetic Source",
    note: "Synthetic deal note",
    groups: ["Group Four"],
    creatorName: "Synthetic Creator",
    statusChangeDate: "2025-11-05 16:45:00+02",
    url: "https://synthetic.livespace.io/Deal/deal/details/api_id/deal-synthetic-401",
    ...overrides,
  };
}

export function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-synthetic-801",
    title: "Synthetic Task One",
    description: "Synthetic task description",
    typeId: "type-synthetic-901",
    typeName: "Synthetic Type",
    statusId: "status-synthetic-911",
    statusName: "Synthetic Status",
    isCompleted: false,
    isPrivate: false,
    priority: 2,
    dateFrom: "2025-11-10 09:00:00+02",
    dateTo: "2025-11-10 10:00:00+02",
    isAllDay: false,
    linkedRecords: [
      { kind: "deal", id: "deal-synthetic-401", name: "Synthetic Deal One" },
    ],
    created: "2025-11-01 08:00:00+02",
    modified: "2025-11-02 08:00:00+02",
    ...overrides,
  };
}

export function wallEntry(overrides: Partial<WallEntry> = {}): WallEntry {
  return {
    type: "activity",
    text: "Synthetic wall text",
    textTruncated: false,
    date: "2025-11-05 16:45:00+02",
    authorName: "Synthetic Owner",
    isPublic: true,
    commentCount: 0,
    objectName: "",
    objectType: "",
    ...overrides,
  };
}
