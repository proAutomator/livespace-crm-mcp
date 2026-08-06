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
 * Detail projection never changes a shape: a projected-away field carries its
 * empty value, so the same schema fits `minimal`, `standard` and `full`.
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
  email: z.string(),
  phone: z.string(),
  companyName: z.string(),
  companyId: z.string().nullable(),
  ownerName: z.string(),
  ownerId: z.string().nullable(),
  tags: z.array(z.string()),
  source: z.string(),
  note: z.string(),
  created: z.string(),
  modified: z.string(),
  lastActiveDate: z.string(),
  dealCount: dealCountSchema,
  cell: z.string(),
  www: z.string(),
  address: z.string(),
  groups: z.array(z.string()),
});

export const companySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  nip: z.string(),
  email: z.string(),
  phone: z.string(),
  ownerName: z.string(),
  ownerId: z.string().nullable(),
  tags: z.array(z.string()),
  source: z.string(),
  note: z.string(),
  created: z.string(),
  modified: z.string(),
  dealCount: dealCountSchema,
  www: z.string(),
  address: z.string(),
  groups: z.array(z.string()),
});

export const dealSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  value: z.number().nullable(),
  currency: z.string(),
  probability: z.number().nullable(),
  processId: z.string(),
  processName: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  substageId: z.string(),
  substageName: z.string(),
  companyId: z.string().nullable(),
  companyName: z.string(),
  contactId: z.string().nullable(),
  contactName: z.string(),
  ownerId: z.string().nullable(),
  ownerName: z.string(),
  dateEnd: z.string(),
  created: z.string(),
  modified: z.string(),
  lastActiveDate: z.string(),
  tags: z.array(z.string()),
  source: z.string(),
  note: z.string(),
  groups: z.array(z.string()),
  creatorName: z.string(),
  statusChangeDate: z.string(),
});

export const taskSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  typeId: z.string(),
  typeName: z.string(),
  statusId: z.string().nullable(),
  statusName: z.string(),
  isCompleted: z.boolean(),
  isPrivate: z.boolean(),
  priority: z.number(),
  dateFrom: z.string(),
  dateTo: z.string(),
  isAllDay: z.boolean(),
  linkedRecords: z.array(
    z.strictObject({ kind: z.string(), id: z.string(), name: z.string() }),
  ),
  created: z.string(),
  modified: z.string(),
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
