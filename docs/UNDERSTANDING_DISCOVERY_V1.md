# Understanding Discovery V1

This layer sits between immutable evidence and approved knowledge:

`evidence -> observations -> observation links -> later synthesis/review -> approved knowledge`

It is provider-neutral. A model process never needs PostgreSQL credentials,
never supplies database IDs or hashes, and is not trusted to identify its own
provider/model runtime.

## Pipeline and lifecycle

- Pipeline: `memory-understanding-discovery/0.2.0`
- New observations are persisted as `proposed`, emergent, and unapproved.
- `observation_kind` and `link_kind` are non-empty free text.
- Persistence never writes `knowledge_candidates` or `approved_knowledge`.

## Input exchange

`scripts/understanding-discovery.ts export` emits
`hhs-understanding-input/0.2.0` JSON containing:

- selected conversation metadata;
- exact text evidence and local `evidence_ref` aliases;
- message role, sequence, active-path state, block kind, and source family;
- logical/source/capture version identity;
- immutable locators and source/container/manifest hashes;
- observed and expected exact hash resolutions.

The exchange ID and evidence SHA-256 are derived locally. A maximum of 50
conversations may be placed in one exchange.

## Model output

The model returns `hhs-understanding-output/0.2.0` JSON. Its semantic job is to
choose observations, attribution, confidence, and supporting `evidence_ref`
aliases. It may include a short `excerpt` for human readability, but that text
is untrusted and is never canonical evidence:

```json
{
  "schema_version": "hhs-understanding-output/0.2.0",
  "exchange_id": "copy-from-input",
  "observations": [
    {
      "observation_ref": "local-o1",
      "source_conversation_id": "uuid-from-input",
      "observation_kind": "free text chosen from evidence",
      "statement": "A concise evidence-grounded statement.",
      "payload": {
        "themes": ["optional"],
        "aliases": [],
        "temporal_references": [],
        "unresolved_questions": []
      },
      "attribution": { "subject": "user", "claim_type": "preference" },
      "confidence": 0.8,
      "evidence": [
        { "evidence_ref": "evidence_ref-from-input", "excerpt": "optional short display text" }
      ]
    }
  ],
  "links": [
    {
      "from_observation_ref": "local-o1",
      "to_observation_ref": "local-o2",
      "link_kind": "free text chosen from evidence",
      "payload": { "rationale": "optional" },
      "confidence": 0.6
    }
  ]
}
```

`observation_ref` values are exchange-local aliases used by links. They are not
database IDs. `links` is optional.

## Trusted validation and persistence

Validation requires:

- every `evidence_ref` resolves in the exact immutable exchange;
- each resolved evidence row belongs to the observation's selected source
  conversation;
- representation, expected, and observed SHA-256 values agree;
- every source belongs to the selected verified-clean exchange;
- attribution and confidence are explicit;
- any claimed user decision, requirement, preference, instruction, or
  commitment has at least one user-role citation;
- every link endpoint resolves to a validated observation.

Trusted local code takes the canonical representation text and SHA-256 directly
from the resolved exchange row. It retains any model excerpt only as
`untrusted_model_excerpt`. Provider, model, optional model version, and runner
version come from trusted CLI configuration, not model output. Any model-supplied
`model` property is ignored.

The `persist` command reloads the evidence through the report-reader path and
compares the exchange/evidence hashes before opening the writer transaction.
Only then does it derive deterministic observation, link, and provenance IDs.

## Future pilot procedure (do not run as part of implementation)

1. Inspect metadata and a deterministic diverse suggestion:

   ```bash
   npx tsx --env-file=.env.memory-v1.local scripts/understanding-discovery.ts select --limit 20
   ```

2. Human-confirm the UUIDs, then export only those UUIDs using one
   `--conversation UUID` flag per selection:

   ```bash
   npx tsx --env-file=.env.memory-v1.local scripts/understanding-discovery.ts export \
     --conversation UUID_1 --conversation UUID_2 > .runtime/discovery/hermes-pilot-input.json
   ```

3. Give `hermes-pilot-input.json` to the chosen Hermes/Nemotron runtime. The
   model receives no database URL or database role. Save only its JSON response
   as `.runtime/discovery/hermes-pilot-output.json`.

4. Validate without writing:

   ```bash
   npx tsx --env-file=.env.memory-v1.local scripts/understanding-discovery.ts validate \
     --exchange .runtime/discovery/hermes-pilot-input.json \
     --output .runtime/discovery/hermes-pilot-output.json \
     --provider local-runner --model Hermes-Nemotron \
     --model-version RUNTIME_VERSION
   ```

5. Inspect validation results. Only after separate authorization, persist the
   unchanged exchange/output pair:

   ```bash
   npx tsx --env-file=.env.memory-v1.local scripts/understanding-discovery.ts persist \
     --exchange .runtime/discovery/hermes-pilot-input.json \
     --output .runtime/discovery/hermes-pilot-output.json \
     --provider local-runner --model Hermes-Nemotron \
     --model-version RUNTIME_VERSION
   ```
