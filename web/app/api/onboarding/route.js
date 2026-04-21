import { buildForwardHeaders, proxyBackend } from '../../../lib/backend';

export async function GET(request) {
  return proxyBackend('/api/onboarding', {
    method: 'GET',
    headers: buildForwardHeaders(request),
  });
}

export async function POST(request) {
  const body = await request.text();
  return proxyBackend('/api/onboarding', {
    method: 'POST',
    headers: buildForwardHeaders(request, { includeJson: true }),
    body,
  });
}
