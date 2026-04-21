import { buildForwardHeaders } from '../../../../../lib/backend';

export async function GET(request, { params }) {
  const resolvedParams = await Promise.resolve(params);
  const conversationId = encodeURIComponent(resolvedParams?.conversationId || '');
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const backendBaseUrl = process.env.BOT_API_BASE_URL || 'http://127.0.0.1:3001';
  const backendUrl = `${backendBaseUrl}/api/conversations/${conversationId}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const response = await fetch(backendUrl, {
    method: 'GET',
    headers: buildForwardHeaders(request),
    cache: 'no-store',
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
