import fs from 'node:fs';
import path from 'node:path';

type Source = { source_conversation_id: string; title: string; priority_rank: number; mode: 'standard' | 'chunks'; stage: 'preparing' | 'generating' | 'saving' | 'complete' };

export function reconstructionProgress(root: string, workspace: string, operation: string, receipt: Record<string, unknown>) {
  if (receipt.workspace !== workspace || receipt.operation_id !== operation) throw new Error('Progress scope mismatch');
  const source = receipt.current_source as Source | undefined;
  // Older receipts remain valid, without invented current-source information.
  if (!source) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(source.source_conversation_id)
    || !Number.isSafeInteger(source.priority_rank) || source.priority_rank < 1
    || typeof source.title !== 'string' || !['standard', 'chunks'].includes(source.mode)
    || !['preparing', 'generating', 'saving', 'complete'].includes(source.stage)
    || typeof receipt.progress_updated_at !== 'string' || !Number.isFinite(Date.parse(receipt.progress_updated_at))) throw new Error('Invalid source progress');
  let lastActivity = Date.parse(receipt.progress_updated_at);
  let stage: string = source.stage;
  let chunksTotal: number | undefined, chunksValidated: number | undefined;
  const prefix = `priority-${String(source.priority_rank).padStart(4, '0')}-${source.source_conversation_id}`;
  if (source.mode === 'chunks') {
    const directory = path.join(root, '.runtime/reconstruction/oversized-runs', prefix);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      if (manifest.source_conversation_id !== source.source_conversation_id || !Array.isArray(manifest.chunks)
        || manifest.chunks.length !== manifest.chunk_count || manifest.chunks.length > 10000) throw new Error('Invalid progress manifest');
      chunksTotal = manifest.chunks.length;
      chunksValidated = 0;
      const seen = new Set<number>();
      for (const chunk of manifest.chunks) {
        if (!Number.isSafeInteger(chunk.chunk_number) || chunk.chunk_number < 1 || seen.has(chunk.chunk_number)) throw new Error('Invalid chunk number');
        seen.add(chunk.chunk_number);
        const number = String(chunk.chunk_number).padStart(3, '0');
        const modelFile = path.join(directory, `chunk-${number}-model.json`);
        if (fs.existsSync(modelFile) && fs.existsSync(path.join(directory, `chunk-${number}-output.json`))) {
          const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
          if (model.validated === true) chunksValidated++;
        }
      }
      for (const name of fs.readdirSync(directory)) {
        if (/^(?:chunk-\d+-(?:model|output|attempt-\d+-(?:error|output|openrouter-raw))|parent-(?:output|model|link-attempt-\d+-(?:raw|output|error)))\.json$/.test(name)) {
          lastActivity = Math.max(lastActivity, fs.statSync(path.join(directory, name)).mtimeMs);
        }
      }
      if (stage === 'generating' && chunksTotal !== undefined && chunksTotal > 0 && chunksValidated === chunksTotal) stage = 'linking';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || source.stage !== 'preparing') throw error;
    }
  } else {
    const directory = path.join(root, '.runtime/reconstruction/priority-runs');
    for (const suffix of ['-input.json', '-output.json', '-openrouter-raw.json']) {
      try { lastActivity = Math.max(lastActivity, fs.statSync(path.join(directory, prefix + suffix)).mtimeMs); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return { source_conversation_id: source.source_conversation_id, title: source.title.slice(0, 160), mode: source.mode, stage,
    ...(chunksTotal === undefined ? {} : { chunks_total: chunksTotal, chunks_validated: chunksValidated }),
    last_activity_at: new Date(lastActivity).toISOString(), activity: Date.now() - lastActivity > 6 * 60 * 1000 ? 'quiet' : 'recent' };
}
