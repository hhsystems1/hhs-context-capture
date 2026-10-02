# Lossless Preservation Standard

The capture target is the **exact accessible rendered transcript**. Captured wording, repetition, contradictions, corrections, rejected outputs, and failed attempts are historical evidence.

The engine must not summarize, rewrite, correct, deduplicate, merge, infer, or silently normalize captured content. When exposed by the interface, it preserves `innerText`, `textContent`, sanitized structural HTML, and deterministic canonical text independently, with method, locator, and SHA-256 hash for every representation.

Sanitized DOM evidence is evidence from the rendered interface, not an untouched original server response. Rendered HTML may not expose original Markdown source. The engine must not claim that it does.

Unavailable or unverified information is reported as uncertainty. Hidden reasoning, hidden instructions, deleted messages, inaccessible branches, and server-only information are never claimed as captured.

