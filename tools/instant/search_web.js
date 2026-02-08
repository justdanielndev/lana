const DEFAULT_SEARCH_BASE_URL = 'https://search.hackclub.com/res/v1';

const ENDPOINTS = {
    web: 'web/search',
    images: 'images/search',
    videos: 'videos/search',
    news: 'news/search',
    suggest: 'suggest/search'
};

const COUNT_LIMITS = {
    web: 20,
    images: 200,
    videos: 50,
    news: 50,
    suggest: 20
};

const declaration = {
    type: "function",
    function: {
        name: "search_web",
        description: "Search the web with Hack Club Search (Brave proxy). Supports web, news, images, videos, and suggestions.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search query text."
                },
                type: {
                    type: "string",
                    description: "Search type: web, news, images, videos, or suggest. Defaults to web."
                },
                count: {
                    type: "number",
                    description: "How many results to return. Max depends on type."
                },
                offset: {
                    type: "number",
                    description: "Pagination offset (0-9)."
                },
                country: {
                    type: "string",
                    description: "Country code (for example US, ES)."
                },
                search_lang: {
                    type: "string",
                    description: "Search language (for example en)."
                },
                ui_lang: {
                    type: "string",
                    description: "UI language (mostly used by news/videos)."
                },
                safesearch: {
                    type: "string",
                    description: "Safe search mode: off, moderate, strict."
                },
                freshness: {
                    type: "string",
                    description: "Freshness window: pd, pw, pm, py."
                },
                extra_snippets: {
                    type: "boolean",
                    description: "For web/news: include extra snippets."
                },
                result_filter: {
                    type: "string",
                    description: "For web: comma-delimited result types to include."
                },
                rich: {
                    type: "boolean",
                    description: "For suggest: enhance with rich results."
                }
            },
            required: ["query"]
        }
    }
};

function clampNumber(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function extractResults(data, type) {
    if (Array.isArray(data?.results)) return data.results;
    if (Array.isArray(data?.[type]?.results)) return data[type].results;

    if (type === 'web' && Array.isArray(data?.web?.results)) return data.web.results;
    if (type === 'news' && Array.isArray(data?.news?.results)) return data.news.results;
    if (type === 'images' && Array.isArray(data?.images?.results)) return data.images.results;
    if (type === 'videos' && Array.isArray(data?.videos?.results)) return data.videos.results;
    if (type === 'suggest' && Array.isArray(data?.suggest?.results)) return data.suggest.results;

    return [];
}

function normalizeResult(result, index) {
    const normalized = { rank: index + 1 };

    if (typeof result?.query === 'string') normalized.query = result.query;
    if (typeof result?.title === 'string') normalized.title = result.title;

    if (typeof result?.url === 'string') {
        normalized.url = result.url;
    } else if (typeof result?.page_url === 'string') {
        normalized.url = result.page_url;
    }

    if (typeof result?.description === 'string') {
        normalized.description = result.description;
    } else if (Array.isArray(result?.extra_snippets) && result.extra_snippets.length > 0) {
        normalized.description = result.extra_snippets.join(' ');
    }

    if (typeof result?.age === 'string') normalized.age = result.age;
    if (typeof result?.meta_url?.hostname === 'string') normalized.source = result.meta_url.hostname;
    if (typeof result?.profile?.name === 'string') normalized.source = result.profile.name;
    if (typeof result?.thumbnail?.src === 'string') normalized.thumbnail = result.thumbnail.src;
    if (typeof result?.video?.duration === 'string') normalized.duration = result.video.duration;
    if (typeof result?.video?.views === 'number') normalized.views = result.video.views;

    return normalized;
}

async function run({ toolInput, deps }) {
    const apiKey = deps.SEARCH_API_KEY || process.env.SEARCH_API_KEY;
    if (!apiKey) {
        return {
            success: false,
            message: "SEARCH_API_KEY is not set. Please add it to environment variables."
        };
    }

    const query = String(toolInput.query || '').trim();
    if (!query) {
        return { success: false, message: "Query is required." };
    }

    const requestedType = String(toolInput.type || 'web').toLowerCase();
    const type = ENDPOINTS[requestedType] ? requestedType : 'web';
    const endpoint = ENDPOINTS[type];
    const maxCount = COUNT_LIMITS[type];
    const defaultCount = type === 'images' ? 20 : (type === 'suggest' ? 5 : 10);
    const count = clampNumber(toolInput.count ?? defaultCount, 1, maxCount) ?? defaultCount;
    const offset = clampNumber(toolInput.offset ?? 0, 0, 9) ?? 0;

    const params = {
        q: query,
        count
    };

    if (offset) params.offset = offset;
    if (typeof toolInput.country === 'string' && toolInput.country.trim()) {
        params.country = toolInput.country.trim();
    }
    if (typeof toolInput.search_lang === 'string' && toolInput.search_lang.trim()) {
        params.search_lang = toolInput.search_lang.trim();
    }
    if (typeof toolInput.ui_lang === 'string' && toolInput.ui_lang.trim()) {
        params.ui_lang = toolInput.ui_lang.trim();
    }
    if (typeof toolInput.safesearch === 'string' && toolInput.safesearch.trim()) {
        params.safesearch = toolInput.safesearch.trim();
    }
    if (typeof toolInput.freshness === 'string' && toolInput.freshness.trim()) {
        params.freshness = toolInput.freshness.trim();
    }
    if (typeof toolInput.extra_snippets === 'boolean') {
        params.extra_snippets = toolInput.extra_snippets;
    }
    if (typeof toolInput.result_filter === 'string' && toolInput.result_filter.trim()) {
        params.result_filter = toolInput.result_filter.trim();
    }
    if (typeof toolInput.rich === 'boolean') {
        params.rich = toolInput.rich;
    }

    const baseUrl = (deps.SEARCH_API_BASE_URL || process.env.SEARCH_API_BASE_URL || DEFAULT_SEARCH_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/${endpoint}`;

    try {
        const response = await deps.axios.get(url, {
            params,
            headers: {
                Authorization: `Bearer ${apiKey}`
            }
        });

        const data = response.data || {};
        const rawResults = extractResults(data, type).slice(0, count);
        const results = rawResults.map(normalizeResult);

        return {
            success: true,
            type,
            query,
            count: results.length,
            results
        };
    } catch (error) {
        const status = error.response?.status;
        const apiError = error.response?.data?.error;
        const message = apiError || error.message || 'Unknown search error';

        return {
            success: false,
            message: status ? `Search API error (${status}): ${message}` : `Search request failed: ${message}`
        };
    }
}

module.exports = {
    declaration,
    run
};
