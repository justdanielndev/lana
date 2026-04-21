import { buildForwardHeaders, proxyBackend } from '../../../../../lib/backend';

async function resolveConversationId(params) {
  const resolvedParams = await Promise.resolve(params);
  return encodeURIComponent(resolvedParams?.conversationId || '');
}

export async function GET(request, { params }) {
  const conversationId = await resolveConversationId(params);
  return proxyBackend(`/api/conversations/${conversationId}/messages`, {
    method: 'GET',
    headers: buildForwardHeaders(request),
  });
}

export async function POST(request, { params }) {
  const conversationId = await resolveConversationId(params);
  const body = await request.text();
  return proxyBackend(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: buildForwardHeaders(request, { includeJson: true }),
    body,
  });
}
