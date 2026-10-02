import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isVerifiedCompleteDiscovery, validateDiscoveryIntegrity } from "@hhs/discovery-schema";
import { runDiscovery } from "@hhs/discovery-engine";
import { SyntheticVirtualizedSidebar, syntheticSidebarItems } from "../test/fixtures/synthetic-sidebar.js";
import type { SidebarInventoryPort, SidebarSnapshot } from "./inventory-adapter.js";
import { ACCOUNT_ROOT_CONTAINER, ChatGptDiscoveryAdapter, projectReference } from "./discovery-adapter.js";

const hash = (value: string): Promise<string> => Promise.resolve(createHash("sha256").update(value, "utf8").digest("hex"));
const context = { host: "chatgpt.com", url: "https://chatgpt.com/" };

function discover(port: SidebarInventoryPort) {
  return runDiscovery(new ChatGptDiscoveryAdapter(() => port), context, {
    opaqueAccountReference: "opaque-account-fixture",
    hash,
    now: () => "2026-08-12T12:00:00.000Z"
  });
}

/** A sidebar whose conversations live inside ChatGPT projects. */
class ProjectSidebar implements SidebarInventoryPort {
  scrollTop = 0;
  constructor(private readonly rows: Array<{ id: string; title: string; path: string }>) {}

  inspect(): SidebarSnapshot {
    return {
      rows: this.rows.map((row, index) => ({
        conversation_id: row.id,
        platform_conversation_id: row.id,
        title: row.title,
        source_url: `https://chatgpt.com${row.path}`,
        sanitized_html: `<li><a href="${row.path}">${row.title}</a></li>`,
        evidence_locator: `synthetic:sidebar:${row.id}`,
        order_hint: index * 100,
        platform_metadata: { synthetic: true }
      })),
      scroll_top: this.scrollTop,
      scroll_height: 500,
      client_height: 500
    };
  }

  scrollTo(top: number): void { this.scrollTop = Math.max(0, Math.min(top, 0)); }
  async waitForSettled(): Promise<void> {}
}

describe("ChatGPT sidebar discovery adapter", () => {
  it("identifies only ChatGPT hosts", () => {
    const adapter = new ChatGptDiscoveryAdapter(() => new SyntheticVirtualizedSidebar(syntheticSidebarItems(1)));

    expect(adapter.identify({ host: "chatgpt.com", url: "https://chatgpt.com/" }).detected).toBe(true);
    expect(adapter.identify({ host: "chat.openai.com", url: "https://chat.openai.com/" }).detected).toBe(true);
    expect(adapter.identify({ host: "notebooklm.google.com", url: "https://notebooklm.google.com/" }).detected).toBe(false);
    expect(adapter.identify({ host: "chatgpt.com.evil.example", url: "https://chatgpt.com.evil.example/" }).detected).toBe(false);
  });

  it("maps a virtualized sidebar into one account root container and its conversations", async () => {
    const result = await discover(new SyntheticVirtualizedSidebar(syntheticSidebarItems(25), 7));

    expect(result.source.source_kind).toBe("chatgpt");
    expect(result.source.transport).toBe("browser_dom");
    expect(result.items).toHaveLength(25);
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0]!.container_kind).toBe("account_root");
    expect(result.containers[0]!.observed_item_count).toBe(25);
    expect(result.items[0]!.source_native_id).toBe("conversation-001");
    expect(result.items.at(-1)!.source_native_id).toBe("conversation-025");
    expect(result.items.every((item) => item.item_kind === "conversation")).toBe(true);
    expect(result.items.every((item) => item.evidence_class === "original_evidence")).toBe(true);
    expect(validateDiscoveryIntegrity(result)).toEqual([]);
    expect(isVerifiedCompleteDiscovery(result)).toBe(true);
  });

  it("preserves conversation identity, title, and any accessible timestamp", async () => {
    const result = await discover(new SyntheticVirtualizedSidebar(syntheticSidebarItems(3)));
    const first = result.items[0]!;

    expect(first.source_native_id).toBe("conversation-001");
    expect(first.title).toBe("Synthetic conversation 1");
    expect(first.source_url).toBe("https://chatgpt.com/c/conversation-001");
    expect(first.capture_feasibility).toBe("capturable");
    // The sidebar's accessible timestamp is preserved as declared metadata, not invented.
    expect(first.declared.modified_at).toBe("2026-07-17T12:00:00Z");
    expect(first.declared.message_count).toBeUndefined();
  });

  it("derives project containers from conversation URLs and assigns items to them", async () => {
    const result = await discover(new ProjectSidebar([
      { id: "conv-a", title: "Loose chat", path: "/c/conv-a" },
      { id: "conv-b", title: "Project chat", path: "/g/g-p-69b34dc26534819189cef5dfa0f33fc8-openclaw/c/conv-b" },
      { id: "conv-c", title: "Another project chat", path: "/g/g-p-69b34dc26534819189cef5dfa0f33fc8-openclaw/c/conv-c" }
    ]));

    const project = result.containers.find((container) => container.container_kind === "project_inferred")!;
    const root = result.containers.find((container) => container.container_kind === "account_root")!;

    expect(project.title).toBe("openclaw");
    expect(project.source_native_id).toBe("g-p-69b34dc26534819189cef5dfa0f33fc8-openclaw");
    expect(project.observed_item_count).toBe(2);
    expect(root.observed_item_count).toBe(1);
    expect(validateDiscoveryIntegrity(result)).toEqual([]);
  });

  it("declares project enumeration as unknown rather than supported", async () => {
    const result = await discover(new SyntheticVirtualizedSidebar(syntheticSidebarItems(2)));

    // An empty project is invisible from the sidebar, so absence of projects is never a claim.
    expect(result.capabilities.projects).toBe("unknown");
    expect(result.capabilities.conversations).toBe("supported");
    expect(result.capabilities.message_counts).toBe("unsupported");
    expect(result.capabilities.branches).toBe("unsupported");
    expect(result.capabilities.conversation_completeness).toBe("unsupported");
  });

  it("reads a project reference only from the URL", () => {
    expect(projectReference("https://chatgpt.com/g/g-p-abc123-openclaw/c/x")).toMatchObject({
      id: "g-p-abc123-openclaw",
      title: "openclaw"
    });
    expect(projectReference("https://chatgpt.com/c/x")).toBeUndefined();
    expect(projectReference(undefined)).toBeUndefined();
    expect(projectReference("not a url")).toBeUndefined();
  });

  it("routes conflicting sidebar identities to needs_review", async () => {
    const port = new SyntheticVirtualizedSidebar(syntheticSidebarItems(10));
    port.conflictingIdentity = "conversation-004";
    const result = await discover(port);

    expect(result.status).toBe("needs_review");
    expect(result.warnings.some((warning) => warning.startsWith("identity_collisions:"))).toBe(true);
    expect(validateDiscoveryIntegrity(result)).toEqual([]);
  });

  it("always emits the account root container even with no conversations", async () => {
    const result = await discover(new ProjectSidebar([]));

    expect(result.containers).toHaveLength(1);
    expect(result.containers[0]!.source_native_id).toBe(ACCOUNT_ROOT_CONTAINER);
    // Zero items is reported as an explicit warning, never as a silent empty success.
    expect(result.warnings).toContain("no_items_observed");
    expect(result.status).toBe("needs_review");
  });
});
