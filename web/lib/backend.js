import { NextResponse } from 'next/server';

const BACKEND_BASE_URL = process.env.BOT_API_BASE_URL || 'http://127.0.0.1:3001';

function buildUrl(pathname) {
  const cleanedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${BACKEND_BASE_URL}${cleanedPath}`;
}

export function buildForwardHeaders(request, { includeJson = false } = {}) {
  const headers = {};
  const authorization = request.headers.get('authorization');
  if (authorization) {
    headers.Authorization = authorization;
  }

  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

export async function proxyBackend(pathname, { method = 'GET', headers = {}, body } = {}) {
  try {
    const response = await fetch(buildUrl(pathname), {
      method,
      headers,
      body,
      cache: 'no-store',
    });

    const text = await response.text();
    let payload;

    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_) {
      payload = { success: false, message: text || 'Invalid backend response.' };
    }

    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to reach bot backend API.',
        error: error.message,
      },
      { status: 502 }
    );
  }
}
