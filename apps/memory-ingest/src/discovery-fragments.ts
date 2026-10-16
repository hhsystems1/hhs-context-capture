import { deterministicId, sha256 } from "@hhs/memory-schema";
import type { DiscoveryEvidence } from "./understanding-discovery.js";

/** Derived processing views. Offsets are JavaScript UTF-16 slice offsets. */
export interface EvidenceFragmentProof {
  parent_evidence_ref: string;
  start_offset: number;
  end_offset: number;
  fragment_sha256: string;
}
export interface EvidenceFragment extends EvidenceFragmentProof {
  fragment_ref: string;
  fragment_text: string;
}
function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);
}
export function fragmentIdentity(parent: DiscoveryEvidence, proof: EvidenceFragmentProof): string {
  return deterministicId("evidence_fragment", parent.evidence_ref, {
    parent_sha256: parent.representation_sha256, start_offset: proof.start_offset,
    end_offset: proof.end_offset, fragment_sha256: proof.fragment_sha256
  });
}
export function createEvidenceFragment(parent: DiscoveryEvidence, start: number, end: number): EvidenceFragment {
  const fragment_text = parent.text.slice(start, end);
  const proof = { parent_evidence_ref: parent.evidence_ref, start_offset: start,
    end_offset: end, fragment_sha256: sha256(fragment_text) };
  return { ...proof, fragment_ref: fragmentIdentity(parent, proof), fragment_text };
}
export function fragmentMatchesEvidence(parent: DiscoveryEvidence, value: unknown, descriptor = false): value is EvidenceFragmentProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const f = value as EvidenceFragment;
  if (f.parent_evidence_ref !== parent.evidence_ref
    || !Number.isSafeInteger(f.start_offset) || !Number.isSafeInteger(f.end_offset)
    || f.start_offset < 0 || f.end_offset <= f.start_offset || f.end_offset > parent.text.length
    || splitsSurrogate(parent.text, f.start_offset) || splitsSurrogate(parent.text, f.end_offset)
    || sha256(parent.text) !== parent.representation_sha256 || !parent.resolution_exact
    || parent.resolution_expected_sha256 !== parent.representation_sha256
    || parent.resolution_observed_sha256 !== parent.representation_sha256
    || f.fragment_sha256 !== sha256(parent.text.slice(f.start_offset, f.end_offset))) return false;
  return !descriptor || (f.fragment_ref === fragmentIdentity(parent, f)
    && f.fragment_text === parent.text.slice(f.start_offset, f.end_offset));
}
export function fragmentProof(f: EvidenceFragmentProof): EvidenceFragmentProof {
  return { parent_evidence_ref: f.parent_evidence_ref, start_offset: f.start_offset,
    end_offset: f.end_offset, fragment_sha256: f.fragment_sha256 };
}
