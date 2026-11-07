import { openAppDb } from "../db/client";
import { deadLetters } from "../db/schema";
import type { QueueEnvelope } from "./routing";

const ID_FIELD = /Ids?$/;

const idsOf = (envelope: QueueEnvelope): Record<string, unknown> => ({
  correlationId: envelope.correlationId,
  ...Object.fromEntries(Object.entries(envelope.event).filter(([key]) => ID_FIELD.test(key))),
});

export const parkDeadLetter = async (
  binding: D1Database,
  deadLetterId: string,
  attempts: number,
  envelope: QueueEnvelope,
): Promise<void> => {
  await openAppDb(binding)
    .insert(deadLetters)
    .values({
      deadLetterId,
      tenantId: envelope.tenantId,
      type: envelope.event.type,
      attempts,
      body: JSON.stringify(idsOf(envelope)),
    })
    .onConflictDoNothing();
};
