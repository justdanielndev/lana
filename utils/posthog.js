const { PostHog } = require('posthog-node');
const crypto = require('crypto');

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';

let client = null;

if (POSTHOG_API_KEY) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST });
}

function captureAIGeneration({
    distinctId,
    traceId,
    sessionId,
    spanId,
    spanName,
    parentId,
    model,
    provider,
    input,
    inputTokens,
    outputChoices,
    outputTokens,
    latency,
    isError,
    error,
    tools,
    httpStatus,
}) {
    if (!client) return;

    const properties = {
        $ai_trace_id: traceId || crypto.randomUUID(),
        $ai_model: model,
        $ai_provider: provider || 'hackclub-proxy',
        $ai_input: input,
        $ai_output_choices: outputChoices,
    };

    if (sessionId) properties.$ai_session_id = sessionId;
    if (spanId) properties.$ai_span_id = spanId;
    if (spanName) properties.$ai_span_name = spanName;
    if (parentId) properties.$ai_parent_id = parentId;
    if (inputTokens != null) properties.$ai_input_tokens = inputTokens;
    if (outputTokens != null) properties.$ai_output_tokens = outputTokens;
    if (latency != null) properties.$ai_latency = latency;
    if (isError != null) properties.$ai_is_error = isError;
    if (error) properties.$ai_error = error;
    if (httpStatus != null) properties.$ai_http_status = httpStatus;
    if (tools) properties.$ai_tools = tools;

    client.capture({
        distinctId: distinctId || 'zoebot',
        event: '$ai_generation',
        properties,
    });
}

function captureAITrace({
    distinctId,
    traceId,
    sessionId,
    spanName,
    inputState,
    outputState,
    latency,
    isError,
    error,
}) {
    if (!client) return;

    const properties = {
        $ai_trace_id: traceId,
    };

    if (sessionId) properties.$ai_session_id = sessionId;
    if (spanName) properties.$ai_span_name = spanName;
    if (inputState) properties.$ai_input_state = inputState;
    if (outputState) properties.$ai_output_state = outputState;
    if (latency != null) properties.$ai_latency = latency;
    if (isError != null) properties.$ai_is_error = isError;
    if (error) properties.$ai_error = error;

    client.capture({
        distinctId: distinctId || 'zoebot',
        event: '$ai_trace',
        properties,
    });
}

function captureAISpan({
    distinctId,
    traceId,
    sessionId,
    spanId,
    spanName,
    parentId,
    inputState,
    outputState,
    latency,
    isError,
    error,
}) {
    if (!client) return;

    const properties = {
        $ai_trace_id: traceId,
    };

    if (sessionId) properties.$ai_session_id = sessionId;
    if (spanId) properties.$ai_span_id = spanId;
    if (spanName) properties.$ai_span_name = spanName;
    if (parentId) properties.$ai_parent_id = parentId;
    if (inputState) properties.$ai_input_state = inputState;
    if (outputState) properties.$ai_output_state = outputState;
    if (latency != null) properties.$ai_latency = latency;
    if (isError != null) properties.$ai_is_error = isError;
    if (error) properties.$ai_error = error;

    client.capture({
        distinctId: distinctId || 'zoebot',
        event: '$ai_span',
        properties,
    });
}

function captureAIEmbedding({
    distinctId,
    traceId,
    sessionId,
    spanId,
    spanName,
    parentId,
    model,
    provider,
    input,
    inputTokens,
    latency,
    isError,
    error,
    httpStatus,
}) {
    if (!client) return;

    const properties = {
        $ai_trace_id: traceId || crypto.randomUUID(),
        $ai_model: model,
        $ai_provider: provider || 'hackclub-proxy',
        $ai_input: input,
    };

    if (sessionId) properties.$ai_session_id = sessionId;
    if (spanId) properties.$ai_span_id = spanId;
    if (spanName) properties.$ai_span_name = spanName;
    if (parentId) properties.$ai_parent_id = parentId;
    if (inputTokens != null) properties.$ai_input_tokens = inputTokens;
    if (latency != null) properties.$ai_latency = latency;
    if (isError != null) properties.$ai_is_error = isError;
    if (error) properties.$ai_error = error;
    if (httpStatus != null) properties.$ai_http_status = httpStatus;

    client.capture({
        distinctId: distinctId || 'zoebot',
        event: '$ai_embedding',
        properties,
    });
}

function shutdownPosthog() {
    if (client) return client.shutdown();
}

module.exports = {
    captureAIGeneration,
    captureAITrace,
    captureAISpan,
    captureAIEmbedding,
    shutdownPosthog,
};
