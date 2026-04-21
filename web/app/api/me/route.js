import { buildForwardHeaders, proxyBackend } from '../../../lib/backend';

export async function GET(request) {
  return proxyBackend('/api/me', {
    method: 'GET',
    headers: buildForwardHeaders(request),
  });
}
