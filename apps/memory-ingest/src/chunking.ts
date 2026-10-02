import { sha256 } from "@hhs/memory-schema";
import type { CapturedMessage } from "./archive.js";

export const MESSAGE_RANGE_SIZE = 5;
export interface MessageRange { start: number; end: number; messages: CapturedMessage[]; sha256: string }

export function deterministicMessageRanges(messages: CapturedMessage[], size = MESSAGE_RANGE_SIZE): MessageRange[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("Message range size must be a positive integer.");
  const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
  const ranges: MessageRange[] = [];
  for (let index = 0; index < ordered.length; index += size) {
    const members = ordered.slice(index, index + size);
    const first = members[0]; const last = members.at(-1);
    if (!first || !last) continue;
    ranges.push({ start: first.sequence, end: last.sequence, messages: members, sha256: sha256(members.map((message) => ({ message_id: message.message_id, sequence: message.sequence, representations: message.representations.map((item) => item.sha256) }))) });
  }
  return ranges;
}
