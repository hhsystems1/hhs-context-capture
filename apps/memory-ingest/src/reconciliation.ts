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
      reconciliations: validItems
    },
    issues: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
