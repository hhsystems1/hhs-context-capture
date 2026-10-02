import { createPool, readOnlyTransaction } from "../apps/memory-ingest/src/db.js";

const workspaceId = flag("workspace") ?? process.env.MEMORY_WORKSPACE_ID;
if (!workspaceId) throw new Error("--workspace or MEMORY_WORKSPACE_ID is required.");

const pool = createPool("reader");
try {
  const report = await readOnlyTransaction(pool, workspaceId, async (client) => {
    const counts = await client.query(`select
      (select count(*)::int from memory_v1.observations where workspace_id=$1) observations,
      (select count(*)::int from memory_v1.observation_links where workspace_id=$1) links,
      (select count(*)::int from memory_v1.provenance_edges where workspace_id=$1 and target_record_type='observation') provenance_edges`, [workspaceId]);
    const missingProvenance = await client.query(`select count(*)::int count
      from memory_v1.observations o
      where o.workspace_id=$1 and not exists (
        select 1 from memory_v1.provenance_edges p
        where p.workspace_id=o.workspace_id and p.target_record_type='observation'
          and p.target_record_id=o.observation_id
      )`, [workspaceId]);
    const duplicateStatements = await client.query(`select
        lower(regexp_replace(trim(payload->>'statement'),'\\s+',' ','g')) normalized_statement,
        count(*)::int count,
        array_agg(observation_id order by observation_id) observation_ids
      from memory_v1.observations
      where workspace_id=$1 and nullif(trim(payload->>'statement'),'') is not null
      group by lower(regexp_replace(trim(payload->>'statement'),'\\s+',' ','g'))
      having count(*) > 1
      order by count(*) desc`, [workspaceId]);
    const authorityRisks = await client.query(`select observation_id, observation_kind,
        payload->>'statement' statement,
        payload->'attribution' attribution
      from memory_v1.observations o
      where o.workspace_id=$1
        and (o.payload->'attribution'->>'subject'='user'
          or observation_kind ~* 'decision|requirement|preference|instruction|commitment')
        and not exists (
          select 1
          from memory_v1.provenance_edges p
          join memory_v1.messages m
            on m.workspace_id=p.workspace_id and m.message_id=p.message_id
          where p.workspace_id=o.workspace_id
            and p.target_record_type='observation'
            and p.target_record_id=o.observation_id
            and m.role='user'
        )
      order by observation_id`, [workspaceId]);
    return {
      schema_version: "hhs-reconstruction-quality-audit/0.1.0",
      generated_at: new Date().toISOString(),
      mode: "read_only",
      workspace: workspaceId,
      counts: counts.rows[0],
      missing_provenance: Number(missingProvenance.rows[0].count),
      exact_duplicate_statement_groups: duplicateStatements.rows,
      user_authority_risks: authorityRisks.rows,
      structural_pass:
        Number(missingProvenance.rows[0].count) === 0
        && authorityRisks.rows.length === 0
    };
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
