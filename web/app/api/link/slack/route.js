import { buildForwardHeaders, proxyBackend } from '../../../../lib/backend';

export async function GET(request) {
  return proxyBackend('/api/link/slack', {
    method: 'GET',
    headers: buildForwardHeaders(request),
  });
}

export async function POST(request) {
  return proxyBackend('/api/link/slack', {
    method: 'POST',
    headers: buildForwardHeaders(request),
  });
}
