import type { SidebarInventoryPort, SidebarRowSnapshot, SidebarSnapshot } from "../../src/inventory-adapter.js";

export class SyntheticVirtualizedSidebar implements SidebarInventoryPort {
  readonly rowHeight = 100;
  readonly clientHeight = 500;
  scrollTop: number;
  restoreBlocked = false;
  movementBlocked = false;
  conflictingIdentity?: string;
  private inspectionCount = 0;

  constructor(readonly items: Array<{ id: string; title: string; timestamp?: string }>, initialIndex = 0) {
    this.scrollTop = initialIndex * this.rowHeight;
  }

  inspect(): SidebarSnapshot {
    this.inspectionCount += 1;
    const start = Math.floor(this.scrollTop / this.rowHeight);
    const rows = this.items.slice(start, start + 5).map((item, viewportIndex): SidebarRowSnapshot => {
      const conflicting = item.id === this.conflictingIdentity && this.inspectionCount > 2;
      return {
        conversation_id: item.id,
        platform_conversation_id: item.id,
        title: conflicting ? `${item.title} conflicting` : item.title,
        source_url: `https://chatgpt.com/c/${item.id}`,
        ...(item.timestamp ? { accessible_timestamp: item.timestamp } : {}),
        sanitized_html: `<li><a href="/c/${item.id}">${item.title}</a></li>`,
        evidence_locator: `synthetic:sidebar:${item.id}`,
        order_hint: (start + viewportIndex) * this.rowHeight,
        platform_metadata: { synthetic: true }
      };
    });
    return { rows, scroll_top: this.scrollTop, scroll_height: this.items.length * this.rowHeight, client_height: this.clientHeight };
  }

  scrollTo(top: number): void {
    if (this.movementBlocked) return;
    if (this.restoreBlocked && top !== 0 && top < this.items.length * this.rowHeight - this.clientHeight) return;
    this.scrollTop = Math.max(0, Math.min(top, this.items.length * this.rowHeight - this.clientHeight));
  }

  async waitForSettled(): Promise<void> {}
}

export function syntheticSidebarItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `conversation-${String(index + 1).padStart(3, "0")}`,
    title: `Synthetic conversation ${index + 1}`,
    timestamp: `2026-07-${String(Math.max(1, 17 - Math.floor(index / 2))).padStart(2, "0")}T12:00:00Z`
  }));
}
