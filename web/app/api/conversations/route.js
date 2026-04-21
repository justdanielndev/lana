import { buildForwardHeaders, proxyBackend } from '../../../lib/backend';

export async function GET(request) {
  return proxyBackend('/api/conversations', {
    method: 'GET',
    headers: buildForwardHeaders(request),
  });
}

export async function POST(request) {
  const body = await request.text();
  return proxyBackend('/api/conversations', {
    method: 'POST',
    headers: buildForwardHeaders(request, { includeJson: true }),
    body,
  });
}
