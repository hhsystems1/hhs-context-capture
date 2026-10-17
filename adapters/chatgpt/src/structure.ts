import type { MessageRole } from '@hhs/canonical-schema';

export interface ChatGptMessageNode {
  element: HTMLElement;
  role: MessageRole;
  platformId?: string;
  roleSource: string;
  identitySource: string;
  layout: 'legacy' | 'business_turn';
}
export interface ChatGptPageSummary {
  layout: 'legacy' | 'business_turn' | 'mixed' | 'unrecognized';
  messages: number; users: number; assistants: number; unknown_roles: number;
  turns: number; missing_ids: number; loading: boolean; issues: string[];
  ready: boolean; completeness: 'not_established';
}

export function inspectChatGptPage(root?: Document): ChatGptPageSummary;
export function inspectChatGptPage(root: Document, includeNodes: true): { summary: ChatGptPageSummary; nodes: ChatGptMessageNode[] };
/** Self-contained so the popup can inject a SUMMARY probe under activeTab without reading text. */
export function inspectChatGptPage(root: Document = document, includeNodes = false) {
  const nodes: ChatGptMessageNode[] = [], issues: string[] = [];
  const region = root.querySelector('[aria-label="Conversation"]') ?? root.querySelector('main');
  const turns = [...(region?.querySelectorAll<HTMLElement>('[data-turn-key]') ?? [])];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const issue = (code: string) => { if (!issues.includes(code)) issues.push(code); };
  for (const turn of turns) {
    if (turn.parentElement?.closest('[data-turn-key]')) { issue('nested_turn_boundaries'); continue; }
    const users = [...turn.querySelectorAll<HTMLElement>('[data-user-message-bubble]')].filter(node => node.closest('[data-turn-key]') === turn);
    const assistants = [...turn.querySelectorAll<HTMLElement>('[data-chatgpt-selection-message-id]')].filter(node => node.closest('[data-turn-key]') === turn);
    if (users.length !== 1 || assistants.length !== 1) issue('incomplete_or_ambiguous_turn');
    for (const element of users) {
      const unit = element.closest('[data-chatgpt-search-message-ids]');
      const sourceId = unit?.getAttribute('data-chatgpt-search-message-ids') ?? '';
      const trustedRole = element.getAttribute('data-user-message-bubble') === 'true'
        && unit?.closest('[data-turn-key]') === turn
        && !unit.querySelector('[data-conversation-role="assistant"], [data-chatgpt-selection-message-id]');
      if (!trustedRole) issue('ambiguous_authorship');
      if (!uuid.test(sourceId)) issue('missing_or_ambiguous_native_identity');
      nodes.push({element,role:trustedRole?'user':'unknown',...(uuid.test(sourceId)?{platformId:sourceId}:{}),roleSource:'data-user-message-bubble=true',identitySource:'data-chatgpt-search-message-ids (single UUID)',layout:'business_turn'});
    }
    for (const element of assistants) {
      const unit = element.closest('[data-chatgpt-search-message-ids]');
      const headings = [...(unit?.querySelectorAll('h4[data-conversation-role]') ?? [])].filter(node => !element.contains(node));
      const nested = [...element.querySelectorAll('[data-dil-message-id]')];
      const sourceId = element.getAttribute('data-chatgpt-selection-message-id') ?? '';
      const trustedRole = unit?.closest('[data-turn-key]') === turn && headings.length === 1
        && headings[0]?.getAttribute('data-conversation-role') === 'assistant'
        && !unit.querySelector('[data-user-message-bubble]') && !element.closest('[data-user-message-bubble]');
      const trustedIdentity = uuid.test(sourceId) && nested.length === 1 && nested[0]?.getAttribute('data-dil-message-id') === sourceId;
      if (!trustedRole) issue('ambiguous_authorship');
      if (!trustedIdentity) issue('missing_or_ambiguous_native_identity');
      nodes.push({element,role:trustedRole?'assistant':'unknown',...(trustedIdentity?{platformId:sourceId}:{}),roleSource:'h4[data-conversation-role=assistant] in the same source unit',identitySource:'data-chatgpt-selection-message-id matched data-dil-message-id',layout:'business_turn'});
    }
  }
  // Keep existing layouts; do not interpret rendered quotations inside a new-layout turn as messages.
  const roleNodes=[...root.querySelectorAll<HTMLElement>('[data-message-author-role]')].filter(node=>!node.closest('[data-turn-key]'));
  const articles=[...root.querySelectorAll<HTMLElement>('article[data-testid^="conversation-turn-"]')].filter(node=>!node.closest('[data-turn-key]')&&!roleNodes.some(role=>node.contains(role)));
  const legacy=[...roleNodes,...articles].filter(node=>!roleNodes.some(parent=>parent!==node&&parent.contains(node)));
  for(const element of legacy){
    const declared=[element,...element.querySelectorAll('[data-message-author-role]')].map(node=>node.getAttribute('data-message-author-role')).filter((role):role is string=>Boolean(role));
    const unique=[...new Set(declared)];
    const testId=element.getAttribute('data-testid')??'';
    const fallback=/^conversation-turn-(user|assistant)(?:-|$)/.exec(testId)?.[1];
    const value=unique.length===1?unique[0]:unique.length===0?fallback:undefined;
    const role:MessageRole=value==='user'||value==='assistant'||value==='tool'?value:'unknown';
    const ids=[element,...element.querySelectorAll('[data-message-id]')].map(node=>node.getAttribute('data-message-id')).filter((id):id is string=>Boolean(id));
    const distinct=[...new Set(ids)];const platformId=distinct.length===1?distinct[0]:undefined;
    if(role==='unknown')issue('ambiguous_authorship');
    if(distinct.length>1)issue('missing_or_ambiguous_native_identity');
    nodes.push({element,role,...(platformId?{platformId}:{}),roleSource:unique.length?'data-message-author-role':'legacy role-specific test id',identitySource:platformId?'data-message-id':'derived observation fingerprint; native identity unavailable',layout:'legacy'});
  }
  nodes.sort((left,right)=>left.element===right.element?0:left.element.compareDocumentPosition(right.element)&2?1:-1);
  const nativeIds=nodes.flatMap(node=>node.platformId?[node.platformId]:[]);
  if(new Set(nativeIds).size!==nativeIds.length)issue('duplicate_native_identity');
  const loading=root.readyState==='loading'||Boolean(root.querySelector('main[aria-busy="true"], main [aria-busy="true"], [aria-label="Conversation"][aria-busy="true"], button[data-testid="stop-button"]'));
  const modern=nodes.some(node=>node.layout==='business_turn'),old=nodes.some(node=>node.layout==='legacy');
  const summary:ChatGptPageSummary={layout:modern&&old?'mixed':modern?'business_turn':old?'legacy':'unrecognized',messages:nodes.length,users:nodes.filter(node=>node.role==='user').length,assistants:nodes.filter(node=>node.role==='assistant').length,unknown_roles:nodes.filter(node=>node.role==='unknown').length,turns:turns.length,missing_ids:nodes.filter(node=>!node.platformId).length,loading,issues,ready:nodes.length>0&&!loading&&issues.length===0,completeness:'not_established'};
  return includeNodes?{summary,nodes}:summary;
}
