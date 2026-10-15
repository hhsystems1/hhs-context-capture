import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { reconstructionProgress } from './reconstruction-progress.js';

it('reads scoped cached-chunk progress without exposing source text or file paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconstruction-progress-'));
  try {
    const receipt = { workspace: 'workspace_a', operation_id: 'operation_a', progress_updated_at: new Date().toISOString(),
      current_source: { source_conversation_id: 'source_a', title: 'Sample', priority_rank: 1, mode: 'chunks', stage: 'generating' } };
    const directory = path.join(root, '.runtime/reconstruction/oversized-runs/priority-0001-source_a');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ source_conversation_id: 'source_a', chunk_count: 2, chunks: [{ chunk_number: 1 }, { chunk_number: 2 }] }));
    fs.writeFileSync(path.join(directory, 'chunk-001-model.json'), JSON.stringify({ validated: true, secret: 'private credential' }));
    fs.writeFileSync(path.join(directory, 'chunk-001-output.json'), 'private original text');
    const progress = reconstructionProgress(root, 'workspace_a', 'operation_a', receipt);
    expect(progress).toMatchObject({ stage: 'generating', chunks_total: 2, chunks_validated: 1, activity: 'recent' });
    expect(JSON.stringify(progress)).not.toMatch(/private|reconstruction-progress-/);
    fs.writeFileSync(path.join(directory, 'chunk-002-model.json'), '{"validated":true}');
    fs.writeFileSync(path.join(directory, 'chunk-002-output.json'), '{}');
    expect(reconstructionProgress(root, 'workspace_a', 'operation_a', receipt)?.stage).toBe('linking');
    expect(() => reconstructionProgress(root, 'workspace_b', 'operation_a', receipt)).toThrow();
    expect(() => reconstructionProgress(root, 'workspace_a', 'operation_b', receipt)).toThrow();
    expect(() => reconstructionProgress(root, 'workspace_a', 'operation_a', { ...receipt, current_source: { ...receipt.current_source, source_conversation_id: '../outside' } })).toThrow();
    expect(reconstructionProgress(root, 'workspace_a', 'operation_a', { workspace: 'workspace_a', operation_id: 'operation_a' })).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
