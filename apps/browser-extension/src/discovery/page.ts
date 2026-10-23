/** A structural hint is not an extraction contract, identity, or completeness claim. */
export function inspectRenderedPage(root:Document=document,sourceUrl:string=location.href){
  const url=new URL(sourceUrl),count=(selector:string)=>root.querySelectorAll(selector).length;
  const counts={conversation_regions:count('[aria-label="Conversation"]'),legacy_messages:count('[data-message-author-role],article[data-testid^="conversation-turn-"]'),business_turns:count('[aria-label="Conversation"] [data-turn-key]'),articles:count('main article'),documents:count('main [role="document"]'),email_semantics:count('[itemtype="https://schema.org/EmailMessage"]'),editable_regions:count('main [contenteditable="true"]'),busy:count('main [aria-busy="true"]')};
  const conversationPath=/^\/(?:g\/[^/]+\/)?c\/[^/?#]+/.test(url.pathname);
  const kind=counts.conversation_regions||counts.legacy_messages?'conversation_candidate':counts.email_semantics?'email_thread_candidate':counts.articles?'article_candidate':counts.documents?'document_candidate':'unknown';
  return {host:url.hostname,protocol:url.protocol,conversation_path:conversationPath,kind,counts,document_ready:root.readyState,persisted:false as const,completeness:'not_established' as const};
}
export type PageInspection=ReturnType<typeof inspectRenderedPage>;
