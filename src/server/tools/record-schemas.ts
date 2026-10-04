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
