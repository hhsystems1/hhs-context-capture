import type { ContentBlock, MessageRole, PreservedRepresentation } from '@hhs/canonical-schema';
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
// Preserve the existing semantic blocks; add a lossless original-message projection
// when plain div text outside those elements would otherwise be omitted.
export async function preserveOriginalUserText(blocks: ContentBlock[], representations: PreservedRepresentation[], locator: string, role: MessageRole): Promise<ContentBlock[]> {
  const text = representations.find(item => item.kind === 'canonical_text')?.value ?? '';
  if (role !== 'user' || !text.trim()) return blocks;
  const parts = blocks.map(block => block.representations.find(item => item.kind === 'canonical_text')?.value ?? '');
  if (parts.some(part => normalized(part) === normalized(text)) || normalized(parts.join('\n')) === normalized(text)) return blocks;
  const id = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(locator + '\0original-user-text-v1'));
  return [...blocks, { block_id: [...new Uint8Array(id)].map(x => x.toString(16).padStart(2, '0')).join(''), type: 'unknown', sequence: blocks.length,
    representations: structuredClone(representations), attributes: {},
    platform_metadata: { projection: 'complete_original_user_text_v1', derived_from: 'message_representations', semantic_blocks_preserved: true } }];
}
