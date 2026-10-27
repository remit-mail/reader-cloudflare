import type { QueueKind, QueueMessage, QueueProducerOf } from "@remit/data-ports";
import type { Env } from "../env";
import { refuseQuota } from "../error-kind";
import { currentCorrelationId } from "../log";
import {
  envelopeOf,
  FAMILY_OF,
  type QueueEnvelope,
  type QueueFamily,
  type ReaderEvent,
} from "./routing";

const bindingFor = (env: Env, family: QueueFamily): Queue<QueueEnvelope> => {
  switch (family) {
    case "sync":
      return env.SYNC;
    case "body":
      return env.BODY_QUEUE;
    case "mutation":
      return env.MUTATION_QUEUE;
    case "smtp":
      return env.SMTP_QUEUE;
    case "fanout":
      return env.FANOUT_QUEUE;
  }
};

const byFamily = <E extends ReaderEvent>(
  messages: readonly QueueMessage<E>[],
): ReadonlyMap<QueueFamily, readonly QueueMessage<E>[]> => {
  const groups = new Map<QueueFamily, QueueMessage<E>[]>();
  for (const message of messages) {
    const family = FAMILY_OF[message.body.type];
    groups.set(family, [...(groups.get(family) ?? []), message]);
  }
  return groups;
};

export const queueProducer = <K extends QueueKind, E extends ReaderEvent>(
  kind: K,
  env: Env,
  tenantId: string,
): QueueProducerOf<K, QueueMessage<E>> => {
  const stamped = (event: E): QueueEnvelope =>
    envelopeOf({ tenantId, correlationId: currentCorrelationId() }, event);
  return {
    kind,
    send: async (message) => {
      await bindingFor(env, FAMILY_OF[message.body.type])
        .send(stamped(message.body))
        .catch(refuseQuota);
    },
    sendBatch: async (messages) => {
      for (const [family, group] of byFamily(messages)) {
        await bindingFor(env, family)
          .sendBatch(group.map((message) => ({ body: stamped(message.body) })))
          .catch(refuseQuota);
      }
      return { refused: new Set<number>() };
    },
  };
};
