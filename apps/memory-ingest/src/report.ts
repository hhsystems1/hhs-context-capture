import { createPool, readOnlyTransaction } from "./db.js";

export async function readOnlyReport(workspaceId: string): Promise<Record<string, unknown>> {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspaceId, async (client) => {
      const report = await client.query("select * from memory_v1.import_report where workspace_id=$1 order by pipeline_version", [workspaceId]);
      const provenance = await client.query(`select workspace_id,pipeline_version,
      count(*) as edge_count,
      count(*) filter (where exists (
        select 1 from memory_v1.content_blocks b
        where b.workspace_id=p.workspace_id and b.content_block_id=p.content_block_id
          and b.representations @> jsonb_build_array(jsonb_build_object('representation_kind',p.representation_kind,'sha256',p.representation_sha256))
      )) as resolved_edge_count
      from memory_v1.trusted_provenance_edges p where workspace_id=$1 group by workspace_id,pipeline_version`, [workspaceId]);
      const statuses = await client.query("select workspace_id,pipeline_version,status,count(*) as count from memory_v1.trusted_knowledge_candidates where workspace_id=$1 group by workspace_id,pipeline_version,status order by pipeline_version,status", [workspaceId]);
      return { generated_at: new Date().toISOString(), mode: "read_only", trust_scope: "attested_generations_only", imports: report.rows, provenance: provenance.rows, candidate_statuses: statuses.rows };
    });
  } finally { await pool.end(); }
}
