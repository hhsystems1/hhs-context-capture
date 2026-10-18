import type { MessageRole } from '@hhs/canonical-schema';

export interface ChatGptMessageNode {
  element: HTMLElement;
  role: MessageRole;
  platformId?: string;
  roleSource: string;
  identitySource: string;
  layout: 'legacy' | 'business_turn';
  turnKey?: string;
}
export interface ChatGptTurnObservation {
  key: string;
  users: string[];
  assistants: string[];
  // A simultaneous source observation supplies the pair's order; isolated halves do not.
  pair?: [string, string];
}
export interface ChatGptPageSummary {
  layout: 'legacy' | 'business_turn' | 'mixed' | 'unrecognized';
  messages: number; users: number; assistants: number; unknown_roles: number;
  turns: number; missing_ids: number; loading: boolean; issues: string[];
  ready: boolean; completeness: 'not_established';
}

export function inspectChatGptPage(root?: Document): ChatGptPageSummary;
export function inspectChatGptPage(root: Document, includeNodes: true): { summary: ChatGptPageSummary; nodes: ChatGptMessageNode[]; turns: ChatGptTurnObservation[] };
/** Self-contained so the popup can inject a SUMMARY probe under activeTab without reading text. */
export function inspectChatGptPage(root: Document = document, includeNodes = false) {
  const nodes: ChatGptMessageNode[] = [], issues: string[] = [];
  const turnObservations: ChatGptTurnObservation[] = [], turnKeys = new Set<string>();
  const conversationId = /\/c\/([^/?#]+)/.exec(new URL(root.URL).pathname)?.[1];
  const region = root.querySelector('[aria-label="Conversation"]') ?? root.querySelector('main');
  const turns = [...(region?.querySelectorAll<HTMLElement>('[data-turn-key]') ?? [])];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const issue = (code: string) => { if (!issues.includes(code)) issues.push(code); };
  for (const turn of turns) {
    if (turn.parentElement?.closest('[data-turn-key]')) { issue('nested_turn_boundaries'); continue; }
    const users = [...turn.querySelectorAll<HTMLElement>('[data-user-message-bubble]')].filter(node => node.closest('[data-turn-key]') === turn);
    const assistants = [...turn.querySelectorAll<HTMLElement>('[data-chatgpt-selection-message-id]')].filter(node => node.closest('[data-turn-key]') === turn);
    const key = turn.getAttribute('data-turn-key') ?? '';
    // Image-only native user turns have no text bubble. The separate provider heading,
    // native user-unit namespace and turn-bound UUID must all agree; never infer a
    // speaker from an arbitrary image, a loading placeholder or quoted assistant HTML.
    const attachmentUsers = new Set<HTMLElement>();
    for (const unit of turn.querySelectorAll<HTMLElement>('[data-chatgpt-search-message-ids]')) {
      if (unit.closest('[data-turn-key]') !== turn || !unit.classList.contains('group/user-message')
        || unit.querySelector('[data-user-message-bubble]') || !unit.querySelector('img[src]')
        || unit.closest('[data-chatgpt-selection-message-id], [data-user-message-bubble]')) continue;
      const headings = [...(unit.parentElement?.querySelectorAll(':scope > h4') ?? [])];
      const id = unit.getAttribute('data-chatgpt-search-message-ids') ?? '';
      const trusted = uuid.test(id) && id === key && headings.length === 1
        && headings[0]?.textContent?.trim() === 'You said:'
        && !unit.querySelector('[data-chatgpt-selection-message-id], [data-conversation-role="assistant"]');
      if (trusted) { users.push(unit); attachmentUsers.add(unit); }
      else issue('unverified_attachment_user');
    }
    if (!key || turnKeys.has(key)) issue('missing_or_duplicate_turn_identity');
    turnKeys.add(key);
    if (users.length > 1 || assistants.length > 1) issue('ambiguous_turn');
    else if (users.length !== 1 || assistants.length !== 1) issue('incomplete_turn');
    const firstNode = nodes.length;
    for (const element of users) {
      const unit = attachmentUsers.has(element) ? element : element.closest('[data-chatgpt-search-message-ids]');
      const sourceId = unit?.getAttribute('data-chatgpt-search-message-ids') ?? '';
      const trustedRole = attachmentUsers.has(element) || element.getAttribute('data-user-message-bubble') === 'true'
        && unit?.closest('[data-turn-key]') === turn
        && !unit.querySelector('[data-conversation-role="assistant"], [data-chatgpt-selection-message-id]');
      if (!trustedRole) issue('ambiguous_authorship');
      if (!uuid.test(sourceId)) issue('missing_or_ambiguous_native_identity');
      nodes.push({element,role:trustedRole?'user':'unknown',...(uuid.test(sourceId)?{platformId:sourceId}:{}),roleSource:attachmentUsers.has(element)?'native image user unit with separate provider user heading':'data-user-message-bubble=true',identitySource:attachmentUsers.has(element)?'single native UUID bound to user turn key':'data-chatgpt-search-message-ids (single UUID)',layout:'business_turn',turnKey:key});
    }
    for (const element of assistants) {
      const unit = element.closest('[data-chatgpt-search-message-ids]');
      const headings = [...(unit?.querySelectorAll('h4[data-conversation-role]') ?? [])].filter(node => !element.contains(node));
      const nested = [...element.querySelectorAll('[data-dil-message-id]')];
      const sourceId = element.getAttribute('data-chatgpt-selection-message-id') ?? '';
      const trustedRole = unit?.closest('[data-turn-key]') === turn && headings.length === 1
        && headings[0]?.getAttribute('data-conversation-role') === 'assistant'
        && !unit.querySelector('[data-user-message-bubble]') && !element.closest('[data-user-message-bubble]');
      const selectionConversation = element.getAttribute('data-chatgpt-selection-conversation-id');
      const conversationMatches = Boolean(conversationId && uuid.test(conversationId) && selectionConversation === conversationId);
      const nestedMatches = nested.length === 1 && nested[0]?.getAttribute('data-dil-message-id') === sourceId;
      // Older rendered replies have no DIL child. Require the independently observed native
      // conversation binding for that variant; conflicting or multiple DIL IDs never fall back.
      const trustedIdentity = uuid.test(sourceId) && (selectionConversation === null || conversationMatches)
        && (nested.length === 0 ? conversationMatches : nestedMatches);
      if (!trustedRole) issue('ambiguous_authorship');
      if (!trustedIdentity) issue('missing_or_ambiguous_native_identity');
      nodes.push({element,role:trustedRole?'assistant':'unknown',...(trustedIdentity?{platformId:sourceId}:{}),roleSource:'h4[data-conversation-role=assistant] in the same source unit',identitySource:nested.length===0?'data-chatgpt-selection-message-id bound to current native conversation':'data-chatgpt-selection-message-id matched data-dil-message-id',layout:'business_turn',turnKey:key});
    }
    const observed = nodes.slice(firstNode);
    const userIds = observed.filter(node => node.role === 'user' && node.platformId).map(node => node.platformId!);
    const assistantIds = observed.filter(node => node.role === 'assistant' && node.platformId).map(node => node.platformId!);
    const orderedPair = users.length === 1 && assistants.length === 1
      && Boolean(users[0]!.compareDocumentPosition(assistants[0]!) & 4);
    if (users.length === 1 && assistants.length === 1 && !orderedPair) issue('conflicting_turn_order');
    turnObservations.push({key,users:userIds,assistants:assistantIds,
      ...(orderedPair && userIds.length === 1 && assistantIds.length === 1 ? {pair:[userIds[0]!,assistantIds[0]!] as [string,string]} : {})});
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
  const summary:ChatGptPageSummary={layout:modern&&old?'mixed':modern?'business_turn':old?'legacy':'unrecognized',messages:nodes.length,users:nodes.filter(node=>node.role==='user').length,assistants:nodes.filter(node=>node.role==='assistant').length,unknown_roles:nodes.filter(node=>node.role==='unknown').length,turns:turns.length,missing_ids:nodes.filter(node=>!node.platformId).length,loading,issues,ready:nodes.length>0&&!loading&&issues.every(code=>code==='incomplete_turn'),completeness:'not_established'};
  return includeNodes?{summary,nodes,turns:turnObservations}:summary;
}
