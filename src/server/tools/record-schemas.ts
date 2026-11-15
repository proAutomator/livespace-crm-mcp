import * as z from "zod/v4";

/**
 * The zod mirrors of the record and wall shapes in `src/livespace/records.ts`
 * and `src/livespace/activity.ts`, shared by every read tool that returns them.
 *
 * They are written field-for-field against those interfaces on purpose. A
 * looser schema (passthrough, or a union of look-alike shapes) would let one
 * kind validate as another and silently strip the fields it does not know - the
 * M3 lesson that keeps every schema here strict and per-kind.
 *
 * Only the identifying core (`id` plus the display name) is required. Every
 * other field is optional because `detail` omits what it does not include.
 * An empty or null returned value supplies no value; it does not establish
 * whether the CRM field is empty or access is restricted. Deal value and
 * probability preserve numeric zero separately from null. Some counters and
 * flags use zero or false as normalization defaults. The schemas stay strict,
 * so an unknown key is still rejected.
 */

const dealCountSchema = z
  .strictObject({
    all: z.number(),
    open: z.number(),
    won: z.number(),
    lost: z.number(),
  })
  .nullable();

export const personSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  companyName: z.string().optional(),
  companyId: z.string().nullable().optional(),
  ownerName: z.string().optional(),
  ownerId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  note: z.string().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
  lastActiveDate: z.string().optional(),
  dealCount: dealCountSchema.optional(),
  cell: z.string().optional(),
  www: z.string().optional(),
  address: z.string().optional(),
  groups: z.array(z.string()).optional(),
  url: z.string().optional(),
});

export const companySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  nip: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  ownerName: z.string().optional(),
  ownerId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  note: z.string().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
  dealCount: dealCountSchema.optional(),
  www: z.string().optional(),
  address: z.string().optional(),
  groups: z.array(z.string()).optional(),
  url: z.string().optional(),
});

export const dealSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(),
  value: z.number().nullable().optional(),
  currency: z.string().optional(),
  probability: z.number().nullable().optional(),
  processId: z.string().optional(),
  processName: z.string().optional(),
  stageId: z.string().optional(),
  stageName: z.string().optional(),
  substageId: z.string().optional(),
  substageName: z.string().optional(),
  companyId: z.string().nullable().optional(),
  companyName: z.string().optional(),
  contactId: z.string().nullable().optional(),
  contactName: z.string().optional(),
  ownerId: z.string().nullable().optional(),
  ownerName: z.string().optional(),
  dateEnd: z.string().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
  lastActiveDate: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  note: z.string().optional(),
  groups: z.array(z.string()).optional(),
  creatorName: z.string().optional(),
  statusChangeDate: z.string().optional(),
  checkedSteps: z
    .array(
      z.strictObject({
        stageId: z.string(),
        stageName: z.string(),
        stepId: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
  wonReasonName: z.string().optional(),
  wonReasonNote: z.string().optional(),
  lostReasonName: z.string().optional(),
  lostReasonNote: z.string().optional(),
  outdatedReasonName: z.string().optional(),
  outdatedReasonNote: z.string().optional(),
  url: z.string().optional(),
});

export const taskSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  typeId: z.string().optional(),
  typeName: z.string().optional(),
  statusId: z.string().nullable().optional(),
  statusName: z.string().optional(),
  isCompleted: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
  priority: z.number().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  isAllDay: z.boolean().optional(),
  linkedRecords: z
    .array(z.strictObject({ kind: z.string(), id: z.string(), name: z.string() }))
    .optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
});

export const wallEntrySchema = z.strictObject({
  type: z.string(),
  text: z.string(),
  textTruncated: z.boolean(),
  date: z.string(),
  authorName: z.string(),
  isPublic: z.boolean(),
  commentCount: z.number(),
  objectName: z.string(),
  objectType: z.string(),
});

// --- API v2 records (`src/livespace/v2/records.ts`) -------------------------
//
// The same rules as above: strict, per kind, only the identifying core
// required. A nested reference is `{id, name}` or null; null means this
// answer supplies no value.

export const refSchema = z.strictObject({ id: z.string(), name: z.string() });

const nullableRef = refSchema.nullable();

const customFieldValueSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).nullable(),
});

const addressSchema = z.strictObject({
  name: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  postcode: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  isMain: z.boolean(),
});

export const personV2Schema = z.strictObject({
  id: z.string(),
  name: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: nullableRef.optional(),
  position: nullableRef.optional(),
  owner: nullableRef.optional(),
  owners: z.array(refSchema).optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  groups: z.array(refSchema).optional(),
  source: nullableRef.optional(),
  description: z.string().nullable().optional(),
  visibility: z.string().optional(),
  lastActivity: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  addresses: z.array(addressSchema).optional(),
  customFields: z.array(customFieldValueSchema).optional(),
  url: z.string().optional(),
});

export const companyV2Schema = z.strictObject({
  id: z.string(),
  name: z.string(),
  taxId: z.string().nullable().optional(),
  regon: z.string().nullable().optional(),
  owner: nullableRef.optional(),
  owners: z.array(refSchema).optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  websites: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  groups: z.array(refSchema).optional(),
  source: nullableRef.optional(),
  description: z.string().nullable().optional(),
  visibility: z.string().optional(),
  lastActivity: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  addresses: z.array(addressSchema).optional(),
  customFields: z.array(customFieldValueSchema).optional(),
  url: z.string().optional(),
});

export const dealV2Schema = z.strictObject({
  id: z.string(),
  name: z.string(),
  number: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  value: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  process: nullableRef.optional(),
  stage: nullableRef.optional(),
  owner: nullableRef.optional(),
  owners: z.array(refSchema).optional(),
  company: nullableRef.optional(),
  person: nullableRef.optional(),
  expectedCloseDate: z.string().nullable().optional(),
  statusChangedAt: z.string().nullable().optional(),
  stageChangedAt: z.string().nullable().optional(),
  lastActivity: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  groups: z.array(refSchema).optional(),
  source: nullableRef.optional(),
  description: z.string().nullable().optional(),
  visibility: z.string().optional(),
  reason: z
    .strictObject({
      kind: z.enum(["won", "lost", "outdated"]),
      name: z.string(),
      note: z.string().nullable(),
    })
    .nullable()
    .optional(),
  probability: z.number().nullable().optional(),
  customFields: z.array(customFieldValueSchema).optional(),
  url: z.string().optional(),
});

export const taskV2Schema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  completed: z.boolean().optional(),
  completedAt: z.string().nullable().optional(),
  priority: z.enum(["normal", "high"]).optional(),
  dueType: z.string().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  allDay: z.boolean().nullable().optional(),
  type: nullableRef.optional(),
  status: nullableRef.optional(),
  private: z.boolean().optional(),
  recurring: z.boolean().optional(),
  assignees: z.array(refSchema).optional(),
  links: z
    .array(
      z.strictObject({
        kind: z.enum(["person", "company", "deal"]),
        id: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  customFields: z.array(customFieldValueSchema).optional(),
  url: z.string().optional(),
});
