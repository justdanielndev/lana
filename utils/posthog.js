const { PostHog } = require('posthog-node');
const crypto = require('crypto');

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

let client = null;

if (POSTHOG_API_KEY) {
    client = new PostHog(POSTHOG_API_KEY, {
        host: POSTHOG_HOST,
        enableExceptionAutocapture: IS_PRODUCTION,
    });
}

function safelySerialize(value, fallback = '[unserializable]') {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return fallback;
    }
}

function captureServerLog({
    distinctId = 'zoebot',
    level = 'info',
    message,
    context,
}) {
    if (!client) return;

    const properties = {
        level,
        message: typeof message === 'string' ? message : String(message),
        environment: NODE_ENV,
    };

    if (context !== undefined) {
        properties.context = safelySerialize(context);
    }

    client.capture({
        distinctId,
        event: 'server_log',
        properties,
    });
}

function captureServerError(error, context, distinctId = 'zoebot') {
    if (!client) return;

    if (typeof client.captureException === 'function' && error instanceof Error) {
        client.captureException(error, distinctId, {
            environment: NODE_ENV,
            context: safelySerialize(context),
        });
        return;
    }

    captureServerLog({
        distinctId,
        level: 'error',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        context: {
            ...safelySerialize(context, {}),
            stack: error instanceof Error ? error.stack : undefined,
        },
    });
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
    IS_PRODUCTION,
    captureAIGeneration,
    captureAITrace,
    captureAISpan,
    captureAIEmbedding,
    captureServerLog,
    captureServerError,
    shutdownPosthog,
};
