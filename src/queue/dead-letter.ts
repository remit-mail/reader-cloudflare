import { openAppDb } from "../db/client";
import { deadLetters } from "../db/schema";
import { FAMILY_OF, type QueueEnvelope } from "./routing";

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
      family: FAMILY_OF[envelope.event.type],
      type: envelope.event.type,
      correlationId: envelope.correlationId,
      attempts,
      body: JSON.stringify(envelope),
    })
    .onConflictDoNothing();
};

export const bodyBytesOf = (body: unknown): number =>
  new TextEncoder().encode(JSON.stringify(body) ?? "").byteLength;
