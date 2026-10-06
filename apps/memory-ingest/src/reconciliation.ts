import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import type { DbClient } from "./db.js";

export const RECONCILIATION_PIPELINE_VERSION = "memory-reconciliation/0.1.0";
export const RECONCILIATION_INPUT_SCHEMA = "hhs-reconciliation-input/0.1.0";
export const RECONCILIATION_OUTPUT_SCHEMA = "hhs-reconciliation-output/0.1.0";

export type ReconciliationKind =
  | "claim"
  | "idea"
  | "entity"
  | "relationship"
  | "use_case"
  | "decision"
  | "task"
  | "sop";

export type ReconciliationRelation =
  | "supports"
  | "contradicts"
  | "refines"
  | "supersedes"
  | "duplicates"
  | "context";

export type BrainType = "personal" | "organization" | "project";

export type ReconciliationAuthority =
  | "user"
  | "company"
  | "assistant"
  | "source"
  | "mixed"
  | "unresolved";

export type ReconciliationTemporalStatus =
  | "current"
  | "historical"
  | "superseded"
  | "rejected"
  | "unknown";

export interface ReconciliationInputObservation {
  observation_id: string;
  pipeline_version: string;
  observation_kind: string;
  statement: string;
  attribution: {
    subject: "user" | "assistant" | "other" | "unresolved";
    claim_type: string;
  };
  created_at: string;
  evidence_roles: string[];
  record_sha256: string;
}

export interface ReconciliationInput {
  schema_version: typeof RECONCILIATION_INPUT_SCHEMA;
  pipeline_version: typeof RECONCILIATION_PIPELINE_VERSION;
  source_workspace_id: string;
  observations: ReconciliationInputObservation[];
}

export interface ReconciliationObservationReference {
  observation_id: string;
  relation: ReconciliationRelation;
}

export interface ReconciliationDestination {
  brain_type: BrainType;
  target_ref: string;
}

export interface ReconciliationOutputItem {
  reconciliation_ref: string;
  kind: ReconciliationKind;
  statement: string;
  authority: ReconciliationAuthority;
  temporal_status: ReconciliationTemporalStatus;
  destination: ReconciliationDestination;
  observations: ReconciliationObservationReference[];
}

export interface ReconciliationOutput {
  schema_version: typeof RECONCILIATION_OUTPUT_SCHEMA;
  source_workspace_id: string;
  reconciliations: ReconciliationOutputItem[];
}

export interface ReconciliationValidationIssue {
  record_ref: string;
  problem: string;
}

export interface ValidatedReconciliationOutput {
  output: ReconciliationOutput;
  reconciliations: ReconciliationOutputItem[];
  trusted_observations: ReconciliationInputObservation[];
}

export interface ReconciliationValidationResult {
  valid?: ValidatedReconciliationOutput;
  issues: ReconciliationValidationIssue[];
}

const KINDS = new Set<ReconciliationKind>([
  "claim",
  "idea",
  "entity",
  "relationship",
  "use_case",
  "decision",
  "task",
  "sop"
]);

const RELATIONS = new Set<ReconciliationRelation>([
  "supports",
  "contradicts",
  "refines",
  "supersedes",
  "duplicates",
  "context"
]);

const BRAIN_TYPES = new Set<BrainType>([
  "personal",
  "organization",
  "project"
]);

const AUTHORITIES = new Set<ReconciliationAuthority>([
  "user",
  "company",
  "assistant",
  "source",
  "mixed",
  "unresolved"
]);

const TEMPORAL_STATUSES = new Set<ReconciliationTemporalStatus>([
  "current",
  "historical",
  "superseded",
  "rejected",
  "unknown"
]);

export function validateReconciliationOutput(
  input: ReconciliationInput,
  supplied: unknown
): ReconciliationValidationResult {
  const issues: ReconciliationValidationIssue[] = [];

  if (!isRecord(supplied)) {
    return {
      issues: [{ record_ref: "output", problem: "reconciliation output must be an object" }]
    };
  }

  if (supplied.schema_version !== RECONCILIATION_OUTPUT_SCHEMA) {
    issues.push({
      record_ref: "output",
      problem: `schema_version must be ${RECONCILIATION_OUTPUT_SCHEMA}`
    });
  }

  if (supplied.source_workspace_id !== input.source_workspace_id) {
    issues.push({
      record_ref: "output",
      problem: "source_workspace_id does not match trusted input"
    });
  }

  if (!Array.isArray(supplied.reconciliations)) {
    issues.push({
      record_ref: "output",
      problem: "reconciliations must be an array"
    });
    return { issues };
  }

  const observationsById = new Map(
    input.observations.map((observation) => [observation.observation_id, observation])
  );

  const seenRefs = new Set<string>();
  const validItems: ReconciliationOutputItem[] = [];

  for (const [index, raw] of supplied.reconciliations.entries()) {
    const recordRef = `reconciliation[${index}]`;
    const local: string[] = [];

    if (!isRecord(raw)) {
      issues.push({
        record_ref: recordRef,
        problem: "reconciliation must be an object"
      });
      continue;
    }

    const reconciliationRef =
      typeof raw.reconciliation_ref === "string"
        ? raw.reconciliation_ref.trim()
        : "";

    if (!reconciliationRef) {
      local.push("reconciliation_ref must be non-empty");
    } else if (seenRefs.has(reconciliationRef)) {
      local.push(`duplicate reconciliation_ref ${reconciliationRef}`);
    } else {
      seenRefs.add(reconciliationRef);
    }

    const kind = String(raw.kind ?? "") as ReconciliationKind;
    if (!KINDS.has(kind)) {
      local.push(`invalid reconciliation kind '${String(raw.kind ?? "")}'`);
    }

    const statement =
      typeof raw.statement === "string"
        ? raw.statement.trim()
        : "";

    if (!statement) {
      local.push("statement must be non-empty");
    }

    const authority =
      String(raw.authority ?? "") as ReconciliationAuthority;

    if (!AUTHORITIES.has(authority)) {
      local.push(`invalid authority '${String(raw.authority ?? "")}'`);
    }

    const temporalStatus =
      String(raw.temporal_status ?? "") as ReconciliationTemporalStatus;

    if (!TEMPORAL_STATUSES.has(temporalStatus)) {
      local.push(
        `invalid temporal_status '${String(raw.temporal_status ?? "")}'`
      );
    }

    let destination: ReconciliationDestination | undefined;

    if (!isRecord(raw.destination)) {
      local.push("destination must be an object");
    } else {
      const brainType = String(
        raw.destination.brain_type ?? ""
      ) as BrainType;

      const targetRef =
        typeof raw.destination.target_ref === "string"
          ? raw.destination.target_ref.trim()
          : "";

      if (!BRAIN_TYPES.has(brainType)) {
        local.push(
          `invalid destination brain_type '${String(
            raw.destination.brain_type ?? ""
          )}'`
        );
      }

      if (!targetRef) {
        local.push("destination target_ref must be non-empty");
      }

      if (BRAIN_TYPES.has(brainType) && targetRef) {
        destination = {
          brain_type: brainType,
          target_ref: targetRef
        };
      }
    }

    const observationReferences: ReconciliationObservationReference[] = [];
    const citedObservations: ReconciliationInputObservation[] = [];

    if (!Array.isArray(raw.observations) || raw.observations.length === 0) {
      local.push("reconciliation requires at least one observation");
    } else {
      const seenObservationIds = new Set<string>();

      for (const [observationIndex, reference] of raw.observations.entries()) {
        if (!isRecord(reference)) {
          local.push(
            `observation[${observationIndex}] must be an object`
          );
          continue;
        }

        const observationId =
          typeof reference.observation_id === "string"
            ? reference.observation_id.trim()
            : "";

        const relation =
          String(reference.relation ?? "") as ReconciliationRelation;

        if (!observationId) {
          local.push(
            `observation[${observationIndex}] requires observation_id`
          );
          continue;
        }

        if (seenObservationIds.has(observationId)) {
          local.push(`duplicate observation_id ${observationId}`);
          continue;
        }
        seenObservationIds.add(observationId);

        const trustedObservation = observationsById.get(observationId);
        if (!trustedObservation) {
          local.push(`unknown observation_id ${observationId}`);
        } else {
          citedObservations.push(trustedObservation);
        }

        if (!RELATIONS.has(relation)) {
          local.push(
            `invalid observation relation '${String(reference.relation ?? "")}'`
          );
        }

        if (trustedObservation && RELATIONS.has(relation)) {
          observationReferences.push({
            observation_id: observationId,
            relation
          });
        }
      }
    }

    if (
      authority === "user" &&
      !citedObservations.some((observation) =>
        observation.evidence_roles.includes("user")
      )
    ) {
      local.push("user authority requires user-authored evidence");
    }

    if (local.length > 0) {
      issues.push(
        ...local.map((problem) => ({
          record_ref: recordRef,
          problem
        }))
      );
      continue;
    }

    validItems.push({
      reconciliation_ref: reconciliationRef,
      kind,
      statement,
      authority,
      temporal_status: temporalStatus,
      destination: destination!,
      observations: observationReferences
    });
  }

  if (issues.length > 0) {
    return { issues };
  }

  const output: ReconciliationOutput = {
    schema_version: RECONCILIATION_OUTPUT_SCHEMA,
    source_workspace_id: input.source_workspace_id,
    reconciliations: validItems
  };

  return {
    valid: {
      output,
      reconciliations: validItems,
      trusted_observations: input.observations
    },
    issues: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export interface ReconciliationPersistResult {
  reconciliations_inserted: number;
  reconciliation_observations_inserted: number;
  replay: boolean;
  reconciliation_ids: Record<string, string>;
}

/**
 * Loads the trusted reconciliation input directly from persisted observations
 * and their exact provenance. Evidence roles are derived from messages reached
 * through observation provenance; they are never trusted from observation
 * payloads or model output.
 */
export async function prepareReconciliationInputFromClient(
  client: DbClient,
  workspaceId: string,
  observationIds: string[]
): Promise<ReconciliationInput> {
  const requested = [
    ...new Set(
      observationIds
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ];

  if (requested.length === 0) {
    throw new Error("Select at least one observation.");
  }

  const result = await client.query(
    `select
       o.observation_id,
       o.pipeline_version,
       o.observation_kind,
       o.payload,
       o.created_at,
       o.record_sha256,
       coalesce(
         array_agg(distinct m.role) filter (where m.role is not null),
         array[]::text[]
       ) as evidence_roles
     from memory_v1.observations o
     left join memory_v1.provenance_edges p
       on (p.workspace_id,p.target_record_id,p.pipeline_version) =
          (o.workspace_id,o.observation_id,o.pipeline_version)
      and p.target_record_type='observation'
     left join memory_v1.messages m
       on m.workspace_id=p.workspace_id
      and m.message_id=p.message_id
     where o.workspace_id=$1
       and o.observation_id = any($2::text[])
     group by
       o.observation_id,
       o.pipeline_version,
       o.observation_kind,
       o.payload,
       o.created_at,
       o.record_sha256`,
    [workspaceId, requested]
  );

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    byId.set(String(row.observation_id), row);
  }

  const missing = requested.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Unknown observation_id: ${missing.join(", ")}`
    );
  }

  const observations = requested.map((observationId) => {
    const row = byId.get(observationId)!;
    const payload = row.payload;

    if (!isRecord(payload)) {
      throw new Error(
        `Observation ${observationId} has invalid payload.`
      );
    }

    const statement =
      typeof payload.statement === "string"
        ? payload.statement.trim()
        : "";

    if (!statement) {
      throw new Error(
        `Observation ${observationId} has no trusted statement.`
      );
    }

    const rawAttribution = payload.attribution;
    if (!isRecord(rawAttribution)) {
      throw new Error(
        `Observation ${observationId} has invalid attribution.`
      );
    }

    const subject = String(rawAttribution.subject ?? "");
    if (!["user", "assistant", "other", "unresolved"].includes(subject)) {
      throw new Error(
        `Observation ${observationId} has invalid attribution subject.`
      );
    }

    const claimType =
      typeof rawAttribution.claim_type === "string"
        ? rawAttribution.claim_type.trim()
        : "";

    if (!claimType) {
      throw new Error(
        `Observation ${observationId} has invalid attribution claim_type.`
      );
    }

    const roles = Array.isArray(row.evidence_roles)
      ? row.evidence_roles.map(String).sort()
      : [];

    return {
      observation_id: observationId,
      pipeline_version: String(row.pipeline_version),
      observation_kind: String(row.observation_kind),
      statement,
      attribution: {
        subject: subject as ReconciliationInputObservation["attribution"]["subject"],
        claim_type: claimType
      },
      created_at: dbIso(row.created_at),
      evidence_roles: roles,
      record_sha256: String(row.record_sha256)
    };
  });

  return {
    schema_version: RECONCILIATION_INPUT_SCHEMA,
    pipeline_version: RECONCILIATION_PIPELINE_VERSION,
    source_workspace_id: workspaceId,
    observations
  };
}

/**
 * Persists only already-validated reconciliation output. Identities and hashes
 * are derived locally. Replaying identical trusted input is idempotent; changing
 * content behind the same reconciliation_ref creates an immutable collision.
 */
export async function persistValidatedReconciliation(
  client: DbClient,
  workspaceId: string,
  validated: ValidatedReconciliationOutput
): Promise<ReconciliationPersistResult> {
  if (validated.output.source_workspace_id !== workspaceId) {
    throw new Error(
      "Validated reconciliation workspace does not match persistence workspace."
    );
  }

  const trustedById = new Map(
    validated.trusted_observations.map((observation) => [
      observation.observation_id,
      observation
    ])
  );

  const result: ReconciliationPersistResult = {
    reconciliations_inserted: 0,
    reconciliation_observations_inserted: 0,
    replay: false,
    reconciliation_ids: {}
  };

  for (const item of validated.reconciliations) {
    const cited = item.observations.map((reference) => {
      const observation = trustedById.get(reference.observation_id);
      if (!observation) {
        throw new Error(
          `Validated reconciliation references unavailable trusted observation ${reference.observation_id}.`
        );
      }
      return { reference, observation };
    });

    const createdAt = cited
      .map(({ observation }) => observation.created_at)
      .sort()
      .at(-1)!;

    const natural = [
      RECONCILIATION_PIPELINE_VERSION,
      item.reconciliation_ref
    ];

    const reconciliationId = deterministicId(
      "reconciliation",
      workspaceId,
      natural
    );

    result.reconciliation_ids[item.reconciliation_ref] =
      reconciliationId;

    const payload = {
      statement: item.statement,
      authority: item.authority,
      temporal_status: item.temporal_status,
      destination: item.destination
    };

    const reconciliationRow = reconciliationImmutableRow(
      "reconciliation",
      workspaceId,
      natural,
      {
        workspace_id: workspaceId,
        reconciliation_id: reconciliationId,
        pipeline_version: RECONCILIATION_PIPELINE_VERSION,
        kind: item.kind,
        payload,
        payload_sha256: sha256(payload),
        created_at: createdAt
      }
    );

    if (
      await reconciliationImmutableInsert(
        client,
        "reconciliations",
        "reconciliation_id",
        reconciliationRow
      ) === "inserted"
    ) {
      result.reconciliations_inserted += 1;
    }

    for (const { reference, observation } of cited) {
      const linkNatural = [
        RECONCILIATION_PIPELINE_VERSION,
        reconciliationId,
        observation.observation_id,
        observation.pipeline_version,
        reference.relation
      ];

      const linkRow = reconciliationImmutableRow(
        "reconciliation_observation",
        workspaceId,
        linkNatural,
        {
          workspace_id: workspaceId,
          reconciliation_observation_id: deterministicId(
            "reconciliation_observation",
            workspaceId,
            linkNatural
          ),
          pipeline_version: RECONCILIATION_PIPELINE_VERSION,
          reconciliation_id: reconciliationId,
          observation_id: observation.observation_id,
          observation_pipeline_version: observation.pipeline_version,
          relation: reference.relation,
          payload: {},
          created_at: createdAt
        }
      );

      if (
        await reconciliationImmutableInsert(
          client,
          "reconciliation_observations",
          "reconciliation_observation_id",
          linkRow
        ) === "inserted"
      ) {
        result.reconciliation_observations_inserted += 1;
      }
    }
  }

  result.replay =
    result.reconciliations_inserted === 0 &&
    result.reconciliation_observations_inserted === 0;

  return result;
}

async function reconciliationImmutableInsert(
  client: DbClient,
  table: string,
  idColumn: string,
  row: Record<string, unknown>
): Promise<"inserted" | "existing"> {
  const workspaceId = String(row.workspace_id);
  const id = String(row[idColumn]);
  const expectedHash = String(row.record_sha256);

  const prior = await client.query(
    `select record_sha256
     from memory_v1.${table}
     where workspace_id=$1 and ${idColumn}=$2`,
    [workspaceId, id]
  );

  if (prior.rowCount) {
    if (String(prior.rows[0]?.record_sha256) !== expectedHash) {
      throw new Error(
        `Immutable idempotency collision in ${table} for ${id}.`
      );
    }
    return "existing";
  }

  const columns = Object.keys(row);
  const values = columns.map((column) =>
    Array.isArray(row[column])
      ? JSON.stringify(row[column])
      : row[column]
  );
  const placeholders = columns
    .map((_, index) => `$${index + 1}`)
    .join(",");

  await client.query(
    `insert into memory_v1.${table}
     (${columns.join(",")})
     values (${placeholders})`,
    values
  );

  return "inserted";
}

function reconciliationImmutableRow(
  kind: string,
  workspaceId: string,
  natural: unknown,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const body = {
    ...fields,
    idempotency_key: idempotencyKey(
      kind,
      workspaceId,
      natural
    )
  };

  return {
    ...body,
    record_sha256: sha256(body)
  };
}

function dbIso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : String(value);
}
