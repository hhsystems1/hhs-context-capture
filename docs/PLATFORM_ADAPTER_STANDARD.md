# Minimal Platform Adapter Standard

Adapters detect, load, observe, and verify a platform UI. They do not write archives or set the final verification status. ChatGPT selectors and assumptions are confined to `adapters/chatgpt`.

Adapters must accumulate observations during scrolling so virtualized messages remain captured after leaving the DOM. Unsupported or uncertain capabilities are explicit; an empty result must not ambiguously mean both “none exist” and “not checked.”

