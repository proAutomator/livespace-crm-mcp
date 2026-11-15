import type {
  CompanyV2,
  DealV2,
  PersonV2,
  TaskV2,
} from "../../src/livespace/v2/records.js";
import { syntheticId } from "./v2.js";

/**
 * Synthetic API v2 records for tests: the upstream rows as the draft contract
 * and the live probes describe them (`raw*`), and the mapped records the tools
 * work with. Every value is invented (AGENTS.md): ids are UUID-shaped zeros,
 * names start with SYNTHETIC.
 */

type Raw = Record<string, unknown>;

const ref = (n: number, name: string): Raw => ({ id: syntheticId(n), name });

export const SYNTHETIC_URL = "https://synthetic.livespace.io/SYNTHETIC/record";

function rawCommunication(): Raw {
  return {
    phoneMobile: ["+48 500 000 001"],
    phoneLandline: ["+48 22 000 00 01"],
    fax: [],
    email: ["synthetic.person@example.test"],
    facebook: [],
    linkedin: [],
    goldenline: [],
    instagram: [],
    website: ["https://example.test"],
  };
}

function rawAddress(): Raw {
  return {
    name: "SYNTHETIC office",
    streetLines: ["SYNTHETIC Street 1", "floor 2"],
    region: null,
    city: "SYNTHETIC City",
    postcode: "00-001",
    country: "PL",
    isMain: true,
    additionalFields: [],
  };
}

export function rawPerson(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(101),
    firstName: "SYNTHETIC",
    lastName: "Person",
    company: ref(201, "SYNTHETIC Company"),
    createdBy: ref(901, "SYNTHETIC Creator"),
    updatedBy: null,
    createdAt: "2026-01-10T09:00:00Z",
    updatedAt: "2026-02-11T10:30:00Z",
    description: "SYNTHETIC person description",
    source: ref(701, "SYNTHETIC Source"),
    position: ref(702, "SYNTHETIC Position"),
    owner: ref(801, "SYNTHETIC Owner"),
    owners: { users: [ref(801, "SYNTHETIC Owner")], teams: [] },
    lastActivity: "2026-02-12T08:00:00Z",
    visibility: "public",
    groups: [ref(703, "SYNTHETIC Group")],
    tags: ["synthetic-tag"],
    communication: rawCommunication(),
    addresses: [rawAddress()],
    relations: [],
    additionalFields: [
      {
        id: syntheticId(601),
        group: ref(600, "SYNTHETIC Field Group"),
        name: "SYNTHETIC text field",
        type: "text",
        value: "SYNTHETIC answer",
      },
    ],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

/** A person row under the minimal media type. */
export function rawPersonMinimal(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(101),
    firstName: "SYNTHETIC",
    lastName: "Person",
    company: ref(201, "SYNTHETIC Company"),
    visibility: "public",
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function rawCompany(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(201),
    name: "SYNTHETIC Company",
    taxId: "0000000000",
    regon: "000000000",
    createdBy: ref(901, "SYNTHETIC Creator"),
    updatedBy: null,
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-02-06T10:30:00Z",
    description: "SYNTHETIC company description",
    source: ref(701, "SYNTHETIC Source"),
    owner: ref(801, "SYNTHETIC Owner"),
    owners: { users: [ref(801, "SYNTHETIC Owner")], teams: [] },
    lastActivity: "2026-02-07T08:00:00Z",
    visibility: "public",
    groups: [ref(703, "SYNTHETIC Group")],
    tags: ["synthetic-tag"],
    communication: rawCommunication(),
    addresses: [rawAddress()],
    relations: [],
    additionalFields: [],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function rawCompanyMinimal(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(201),
    name: "SYNTHETIC Company",
    visibility: "public",
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function rawDeal(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(301),
    name: "SYNTHETIC Deal",
    status: "open",
    number: "1/2026",
    description: "SYNTHETIC deal description",
    createdAt: "2026-01-02T09:00:00Z",
    createdBy: ref(901, "SYNTHETIC Creator"),
    updatedAt: "2026-02-03T10:30:00Z",
    updatedBy: null,
    lastActivity: "2026-02-04T08:00:00Z",
    lastActiveBy: null,
    statusChangedAt: null,
    stageChangedAt: "2026-01-20T12:00:00Z",
    expectedCloseDate: "2026-03-31",
    autoCloseDate: null,
    visibility: "public",
    company: ref(201, "SYNTHETIC Company"),
    person: ref(101, "SYNTHETIC Person"),
    owner: ref(801, "SYNTHETIC Owner"),
    owners: { users: [ref(801, "SYNTHETIC Owner")], teams: [] },
    budget: { value: 12000, cost: 0, currency: "PLN" },
    source: ref(701, "SYNTHETIC Source"),
    process: ref(401, "SYNTHETIC Process"),
    currentStage: ref(411, "SYNTHETIC Stage"),
    wonReason: null,
    lostReason: null,
    outdatedReason: null,
    groups: [ref(704, "SYNTHETIC Deal Group")],
    tags: ["synthetic-tag"],
    relations: [],
    additionalFields: [],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function rawDealMinimal(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(301),
    name: "SYNTHETIC Deal",
    status: "open",
    process: ref(401, "SYNTHETIC Process"),
    currentStage: ref(411, "SYNTHETIC Stage"),
    createdAt: "2026-01-02T09:00:00Z",
    createdBy: ref(901, "SYNTHETIC Creator"),
    updatedAt: "2026-02-03T10:30:00Z",
    updatedBy: null,
    owner: ref(801, "SYNTHETIC Owner"),
    visibility: "public",
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function rawTask(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(501),
    title: "SYNTHETIC Task",
    description: "SYNTHETIC task description",
    completed: false,
    completedAt: null,
    priority: "high",
    dueType: "scheduled",
    startsAt: "2026-03-01T09:00:00Z",
    endsAt: "2026-03-01T10:00:00Z",
    allDay: false,
    type: ref(711, "SYNTHETIC Task Type"),
    status: null,
    private: false,
    recurring: false,
    recurrence: null,
    assignees: { users: [ref(801, "SYNTHETIC Owner")], teams: [] },
    members: { users: [], teams: [] },
    createdBy: ref(901, "SYNTHETIC Creator"),
    createdAt: "2026-02-20T09:00:00Z",
    updatedBy: null,
    updatedAt: "2026-02-21T09:00:00Z",
    people: [{ id: syntheticId(101), name: "SYNTHETIC Person" }],
    companies: [],
    deals: [{ id: syntheticId(301), name: "SYNTHETIC Deal" }],
    spaces: [],
    contacts: { people: [], emails: [] },
    additionalFields: [],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function rawTaskMinimal(overrides: Raw = {}): Raw {
  return {
    id: syntheticId(501),
    title: "SYNTHETIC Task",
    completed: false,
    dueType: "scheduled",
    startsAt: "2026-03-01T09:00:00Z",
    allDay: false,
    private: false,
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

// Mapped records, as the reader hands them to the tools.

const mappedRef = (n: number, name: string) => ({ id: syntheticId(n), name });

export function personV2(overrides: Partial<PersonV2> = {}): PersonV2 {
  return {
    id: syntheticId(101),
    name: "SYNTHETIC Person",
    firstName: "SYNTHETIC",
    lastName: "Person",
    company: mappedRef(201, "SYNTHETIC Company"),
    position: mappedRef(702, "SYNTHETIC Position"),
    owner: mappedRef(801, "SYNTHETIC Owner"),
    owners: [mappedRef(801, "SYNTHETIC Owner")],
    emails: ["synthetic.person@example.test"],
    phones: ["+48 500 000 001", "+48 22 000 00 01"],
    tags: ["synthetic-tag"],
    groups: [mappedRef(703, "SYNTHETIC Group")],
    source: mappedRef(701, "SYNTHETIC Source"),
    description: "SYNTHETIC person description",
    visibility: "public",
    lastActivity: "2026-02-12T08:00:00Z",
    createdAt: "2026-01-10T09:00:00Z",
    updatedAt: "2026-02-11T10:30:00Z",
    addresses: [
      {
        name: "SYNTHETIC office",
        street: "SYNTHETIC Street 1, floor 2",
        city: "SYNTHETIC City",
        postcode: "00-001",
        region: null,
        country: "PL",
        isMain: true,
      },
    ],
    customFields: [
      {
        id: syntheticId(601),
        name: "SYNTHETIC text field",
        type: "text",
        value: "SYNTHETIC answer",
      },
    ],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function companyV2(overrides: Partial<CompanyV2> = {}): CompanyV2 {
  return {
    id: syntheticId(201),
    name: "SYNTHETIC Company",
    taxId: "0000000000",
    regon: "000000000",
    owner: mappedRef(801, "SYNTHETIC Owner"),
    owners: [mappedRef(801, "SYNTHETIC Owner")],
    emails: ["synthetic.person@example.test"],
    phones: ["+48 500 000 001", "+48 22 000 00 01"],
    websites: ["https://example.test"],
    tags: ["synthetic-tag"],
    groups: [mappedRef(703, "SYNTHETIC Group")],
    source: mappedRef(701, "SYNTHETIC Source"),
    description: "SYNTHETIC company description",
    visibility: "public",
    lastActivity: "2026-02-07T08:00:00Z",
    createdAt: "2026-01-05T09:00:00Z",
    updatedAt: "2026-02-06T10:30:00Z",
    addresses: [
      {
        name: "SYNTHETIC office",
        street: "SYNTHETIC Street 1, floor 2",
        city: "SYNTHETIC City",
        postcode: "00-001",
        region: null,
        country: "PL",
        isMain: true,
      },
    ],
    customFields: [],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function dealV2(overrides: Partial<DealV2> = {}): DealV2 {
  return {
    id: syntheticId(301),
    name: "SYNTHETIC Deal",
    number: "1/2026",
    status: "open",
    value: 12000,
    currency: "PLN",
    process: mappedRef(401, "SYNTHETIC Process"),
    stage: mappedRef(411, "SYNTHETIC Stage"),
    owner: mappedRef(801, "SYNTHETIC Owner"),
    owners: [mappedRef(801, "SYNTHETIC Owner")],
    company: mappedRef(201, "SYNTHETIC Company"),
    person: mappedRef(101, "SYNTHETIC Person"),
    expectedCloseDate: "2026-03-31",
    statusChangedAt: null,
    stageChangedAt: "2026-01-20T12:00:00Z",
    lastActivity: "2026-02-04T08:00:00Z",
    createdAt: "2026-01-02T09:00:00Z",
    updatedAt: "2026-02-03T10:30:00Z",
    tags: ["synthetic-tag"],
    groups: [mappedRef(704, "SYNTHETIC Deal Group")],
    source: mappedRef(701, "SYNTHETIC Source"),
    description: "SYNTHETIC deal description",
    visibility: "public",
    reason: null,
    probability: null,
    customFields: [],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}

export function taskV2(overrides: Partial<TaskV2> = {}): TaskV2 {
  return {
    id: syntheticId(501),
    title: "SYNTHETIC Task",
    description: "SYNTHETIC task description",
    completed: false,
    completedAt: null,
    priority: "high",
    dueType: "scheduled",
    startsAt: "2026-03-01T09:00:00Z",
    endsAt: "2026-03-01T10:00:00Z",
    allDay: false,
    type: mappedRef(711, "SYNTHETIC Task Type"),
    status: null,
    private: false,
    recurring: false,
    assignees: [mappedRef(801, "SYNTHETIC Owner")],
    links: [
      { kind: "person", id: syntheticId(101), name: "SYNTHETIC Person" },
      { kind: "deal", id: syntheticId(301), name: "SYNTHETIC Deal" },
    ],
    createdAt: "2026-02-20T09:00:00Z",
    updatedAt: "2026-02-21T09:00:00Z",
    customFields: [],
    url: SYNTHETIC_URL,
    ...overrides,
  };
}
