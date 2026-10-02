# Minimal Canonical Conversation Schema

The versioned JSON Schema in `packages/canonical-schema/schemas/capture-bundle.schema.json` is authoritative for the first vertical slice. Shared fields are platform-neutral; adapter-only observations remain in `platform_metadata`.

Every message has an accumulated identity, role, ordering evidence, representations, content blocks, and evidence locators. Representation values remain separate and are individually hashed. The canonical transcript is constructed from the accumulated message graph, never only from the final DOM.

The schema will be refined after the first real capture, while old archived schema versions remain readable.

