const { App } = require('@slack/bolt');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const axios = require('axios');
const appwrite = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');
const cron = require('node-cron');
const { Index } = require('@upstash/vector');
const {
    IS_PRODUCTION,
    captureAIGeneration,
    captureAITrace,
    captureAISpan,
    captureAIEmbedding,
    captureServerLog,
    captureServerError,
    shutdownPosthog,
} = require('./utils/posthog');

function serializeLogValue(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }

    if (typeof value === 'string') return value;

    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return String(value);
    }
}

function formatLogMessage(args) {
    return args
        .map((arg) => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
            try {
                return JSON.stringify(arg);
            } catch (_) {
                return String(arg);
            }
        })
        .join(' ');
}

if (IS_PRODUCTION) {
    const rawConsole = {
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    console.log = () => {};
    console.debug = () => {};

    console.info = (...args) => {
        captureServerLog({
            level: 'info',
            message: formatLogMessage(args),
            context: { args: args.map(serializeLogValue) },
        });
    };

    console.warn = (...args) => {
        const context = { args: args.map(serializeLogValue) };
        rawConsole.warn(...args);
        captureServerLog({
            level: 'warn',
            message: formatLogMessage(args),
            context,
        });
    };

    console.error = (...args) => {
        const errorArg = args.find((arg) => arg instanceof Error);
        const context = { args: args.map(serializeLogValue) };
        rawConsole.error(...args);

        if (errorArg) {
            captureServerError(errorArg, {
                ...context,
                message: formatLogMessage(args),
            });
            return;
        }

        captureServerLog({
            level: 'error',
            message: formatLogMessage(args),
            context,
        });
    };

    process.on('unhandledRejection', (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        captureServerError(error, { origin: 'unhandledRejection' });
    });

    process.on('uncaughtException', (error) => {
        captureServerError(error, { origin: 'uncaughtException' });
    });
}

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});

const USER_ID = process.env.USER_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const START_NOTIFS_CHANNEL_ID = process.env.START_NOTIFS_CHANNEL_ID;
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_MEMORY_COLLECTION_ID = process.env.APPWRITE_MEMORY_COLLECTION_ID || 'memory-items';
const APPWRITE_SETTINGS_COLLECTION_ID = process.env.APPWRITE_SETTINGS_COLLECTION_ID || 'settings';
const APPWRITE_REMINDERS_COLLECTION_ID = process.env.APPWRITE_REMINDERS_COLLECTION_ID || 'reminders';
const APPWRITE_CONVERSATIONS_COLLECTION_ID = process.env.APPWRITE_CONVERSATIONS_COLLECTION_ID || 'conversations';
const APPWRITE_CONVERSATION_MESSAGES_COLLECTION_ID = process.env.APPWRITE_CONVERSATION_MESSAGES_COLLECTION_ID || 'conversation-messages';
const WEB_UI_ENABLED = process.env.WEB_UI_ENABLED !== 'false';
const WEB_UI_HOST = process.env.WEB_UI_HOST || '0.0.0.0';
const webUiPortEnv = Number(process.env.WEB_UI_PORT || 3001);
const WEB_UI_PORT = Number.isInteger(webUiPortEnv) && webUiPortEnv > 0 ? webUiPortEnv : 3001;

const client = new appwrite.Client();
client
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

const storage = new appwrite.Storage(client);
const databases = new appwrite.Databases(client);

const vectorIndex = new Index({
    url: process.env.UPSTASH_VECTOR_URL,
    token: process.env.UPSTASH_VECTOR_TOKEN,
});

const HC_API_KEY = process.env.HC_API_KEY;
const HC_CHAT_URL = 'https://ai.hackclub.com/proxy/v1/chat/completions';
const HC_EMBEDDINGS_URL = 'https://ai.hackclub.com/proxy/v1/embeddings';
const DEFAULT_HC_CHAT_MODEL = process.env.HC_CHAT_MODEL || 'google/gemini-3-flash-preview';
const HACKATIME_API_KEY = process.env.HACKATIME_API_KEY;
const HACKATIME_BASE_URL = 'https://hackatime.hackclub.com/api/v1';
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USERNAME = process.env.LASTFM_USERNAME;
const LASTFM_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const SEARCH_API_KEY = process.env.SEARCH_API_KEY;
const SEARCH_API_BASE_URL = process.env.SEARCH_API_BASE_URL || 'https://search.hackclub.com/res/v1';
const SPANISH_TIME_ZONE = 'Europe/Madrid';


let settingsCache = {
    prompt: null,
    model: null,
    disabledTools: new Set(),
    lastFetched: null
};

async function getSetting(settingId) {
    try {
        const docs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_SETTINGS_COLLECTION_ID,
            [appwrite.Query.equal('settingId', settingId)]
        );
        return docs.documents.length > 0 ? docs.documents[0].settingValue : null;
    } catch (error) {
        console.error(`Error fetching setting ${settingId}:`, error.message);
        return null;
    }
}

async function setSetting(settingId, settingValue) {
    try {
        const docs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_SETTINGS_COLLECTION_ID,
            [appwrite.Query.equal('settingId', settingId)]
        );
        
        if (docs.documents.length > 0) {
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_SETTINGS_COLLECTION_ID,
                docs.documents[0].$id,
                { settingValue }
            );
        } else {
            await databases.createDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_SETTINGS_COLLECTION_ID,
                appwrite.ID.unique(),
                { settingId, settingValue }
            );
        }
        return true;
    } catch (error) {
        console.error(`Error setting ${settingId}:`, error.message);
        return false;
    }
}

async function deleteSetting(settingId) {
    try {
        const docs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_SETTINGS_COLLECTION_ID,
            [appwrite.Query.equal('settingId', settingId)]
        );
        
        if (docs.documents.length > 0) {
            await databases.deleteDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_SETTINGS_COLLECTION_ID,
                docs.documents[0].$id
            );
        }
        return true;
    } catch (error) {
        console.error(`Error deleting setting ${settingId}:`, error.message);
        return false;
    }
}

async function refreshSettings() {
    try {
        const docs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_SETTINGS_COLLECTION_ID,
            [appwrite.Query.limit(100)]
        );
        
        settingsCache.prompt = null;
        settingsCache.model = null;
        settingsCache.disabledTools = new Set();
        
        for (const doc of docs.documents) {
            if (doc.settingId === 'prompt') {
                settingsCache.prompt = doc.settingValue;
            } else if (doc.settingId === 'model') {
                settingsCache.model = doc.settingValue;
            } else if (doc.settingId.startsWith('tool-') && doc.settingValue === 'disabled') {
                const toolId = doc.settingId.replace('tool-', '');
                settingsCache.disabledTools.add(toolId);
            }
        }
        
        settingsCache.lastFetched = new Date();
    } catch (error) {
        console.error('Error refreshing settings:', error.message);
    }
}

function getActiveModel() {
    return settingsCache.model || DEFAULT_HC_CHAT_MODEL;
}

function getActivePrompt() {
    return settingsCache.prompt || 'You are a helpful assistant.';
}

async function fetchAvailableModels() {
    try {
        const response = await axios.get('https://ai.hackclub.com/proxy/v1/models', {
            headers: {
                'Authorization': `Bearer ${HC_API_KEY}`
            }
        });
        return response.data.data.map(m => m.id).sort();
    } catch (error) {
        console.error('Error fetching models:', error.message);
        return [DEFAULT_HC_CHAT_MODEL];
    }
}

let pendingUploads = {};
let lastSyncTime = null;
let toolQueue = [];
let isProcessingQueue = false;
let isProcessingReminders = false;

const REFUSAL_MESSAGES = [
    "Can't talk here, nice try tho :loll: If you want to reply to a yap, pls do that in the channel.",
    "Can't talk to you :sadge: If you want to reply to a yap, pls do that in the channel.",
    "You're not allowed to talk to me here :shrug: If you want to reply to a yap, pls do that in the channel.",
    "Sorry bestie, this chat's for Zoe only :3 If you want to reply to a yap, pls do that in the channel.",
];

function getRandomRefusal() {
    return REFUSAL_MESSAGES[Math.floor(Math.random() * REFUSAL_MESSAGES.length)];
}

function loadToolsFromDisk() {
    const toolRoot = path.join(__dirname, 'tools');
    const folderToExecutionType = {
        instant: 'instant',
        async: 'async'
    };

    const allToolDeclarations = [];
    const instantToolNames = [];
    const asyncToolNames = [];
    const toolHandlers = new Map();
    const seenToolNames = new Set();

    for (const [folderName, executionType] of Object.entries(folderToExecutionType)) {
        const folderPath = path.join(toolRoot, folderName);

        if (!fs.existsSync(folderPath)) {
            continue;
        }

        const files = fs.readdirSync(folderPath)
            .filter((fileName) => fileName.endsWith('.js'))
            .sort();

        for (const fileName of files) {
            const filePath = path.join(folderPath, fileName);
            delete require.cache[require.resolve(filePath)];
            const toolModule = require(filePath);
            const declaration = toolModule.declaration || toolModule;
            const toolName = declaration?.function?.name;
            const run = toolModule.run;

            if (!toolName) {
                throw new Error(`Tool declaration missing function.name: ${filePath}`);
            }
            if (typeof run !== 'function') {
                throw new Error(`Tool module missing run() handler: ${filePath}`);
            }
            if (seenToolNames.has(toolName)) {
                throw new Error(`Duplicate tool name "${toolName}" found in ${filePath}`);
            }

            seenToolNames.add(toolName);
            allToolDeclarations.push(declaration);
            toolHandlers.set(toolName, { run, executionType });

            if (executionType === 'instant') {
                instantToolNames.push(toolName);
            } else {
                asyncToolNames.push(toolName);
            }
        }
    }

    return {
        allToolDeclarations,
        instantToolNames,
        asyncToolNames,
        toolHandlers
    };
}

const {
    allToolDeclarations: ALL_TOOL_DECLARATIONS,
    instantToolNames: ALL_INSTANT_TOOLS,
    asyncToolNames: ALL_ASYNC_TOOLS,
    toolHandlers: TOOL_HANDLERS
} = loadToolsFromDisk();
const WEB_SOURCE_BLOCKED_TOOLS = new Set();
const ZOE_TOOL_NAMES = new Set(['yap', 'cdn_upload', 'cdn_delete', 'cdn_rename']);

function getActiveTools() {
    const disabledTools = settingsCache.disabledTools;
    return ALL_TOOL_DECLARATIONS.filter(t => !disabledTools.has(t.function.name));
}

function getActiveInstantTools() {
    const disabledTools = settingsCache.disabledTools;
    return ALL_INSTANT_TOOLS.filter(t => !disabledTools.has(t));
}

function getActiveAsyncTools() {
    const disabledTools = settingsCache.disabledTools;
    return ALL_ASYNC_TOOLS.filter(t => !disabledTools.has(t));
}

function getAllToolNames() {
    return ALL_TOOL_DECLARATIONS.map(t => t.function.name).sort();
}

function canUseZoeTools(context = {}) {
    if (!USER_ID || !CHANNEL_ID) {
        return false;
    }

    const contextUserId = typeof context?.userId === 'string' ? context.userId : null;
    const contextChannelId = typeof context?.channelId === 'string' ? context.channelId : null;
    return contextUserId === USER_ID && contextChannelId === CHANNEL_ID;
}

function getSourceBlockedTools(source = 'slack', context = {}) {
    const blocked = new Set();

    if (source === 'web') {
        for (const toolName of WEB_SOURCE_BLOCKED_TOOLS) {
            blocked.add(toolName);
        }
    }

    if (!canUseZoeTools(context)) {
        for (const toolName of ZOE_TOOL_NAMES) {
            blocked.add(toolName);
        }
    }

    return blocked;
}

function getActiveToolset(source = 'slack', context = {}) {
    const disabledTools = settingsCache.disabledTools;
    const sourceBlockedTools = getSourceBlockedTools(source, context);
    const isEnabled = (toolName) =>
        !disabledTools.has(toolName) &&
        !sourceBlockedTools.has(toolName);

    return {
        declarations: ALL_TOOL_DECLARATIONS.filter((tool) => isEnabled(tool.function.name)),
        instantNames: ALL_INSTANT_TOOLS.filter(isEnabled),
        asyncNames: ALL_ASYNC_TOOLS.filter(isEnabled)
    };
}

function looksLikeToolArtifactMessage(content) {
    if (typeof content !== 'string') return false;
    const normalized = content.toLowerCase();
    return (
        normalized.includes('unknown or disabled tool') ||
        normalized.includes('default_api:tool_') ||
        /<ctrl\d+>/.test(content)
    );
}

function formatDateTimeInSpanishTime(dateInput) {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const datePart = new Intl.DateTimeFormat('sv-SE', {
        timeZone: SPANISH_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);

    const timePart = new Intl.DateTimeFormat('sv-SE', {
        timeZone: SPANISH_TIME_ZONE,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).format(date);

    return `${datePart}T${timePart} (${SPANISH_TIME_ZONE})`;
}

function getCurrentSpanishDateTimeString() {
    return formatDateTimeInSpanishTime(new Date().toISOString());
}

function getOrdinalNumberLabel(number) {
    const mod100 = number % 100;
    if (mod100 >= 11 && mod100 <= 13) {
        return `${number}th`;
    }
    const mod10 = number % 10;
    if (mod10 === 1) return `${number}st`;
    if (mod10 === 2) return `${number}nd`;
    if (mod10 === 3) return `${number}rd`;
    return `${number}th`;
}

function parseReminderContent(content) {
    try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
            return {
                message: typeof parsed.message === 'string' ? parsed.message : '',
                userId: typeof parsed.userId === 'string' ? parsed.userId : null,
                channelId: typeof parsed.channelId === 'string' ? parsed.channelId : null,
                threadTs: typeof parsed.threadTs === 'string' ? parsed.threadTs : null,
                status: parsed.status === 'read' ? 'read' : 'unread',
                repeatCount: Number.isInteger(parsed.repeatCount) && parsed.repeatCount >= 0 ? parsed.repeatCount : 0,
                createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
                lastNotifiedAt: typeof parsed.lastNotifiedAt === 'string' ? parsed.lastNotifiedAt : null
            };
        }
    } catch (_) {
    }

    return {
        message: typeof content === 'string' ? content : '',
        userId: USER_ID || null,
        channelId: USER_ID || null,
        threadTs: null,
        status: 'unread',
        repeatCount: 0,
        createdAt: null,
        updatedAt: null,
        lastNotifiedAt: null
    };
}

function serializeReminderContent(state) {
    return JSON.stringify({
        message: state.message,
        userId: state.userId,
        channelId: state.channelId,
        threadTs: state.threadTs,
        status: state.status,
        repeatCount: state.repeatCount,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        lastNotifiedAt: state.lastNotifiedAt
    });
}

function normalizeReminderDoc(doc) {
    const state = parseReminderContent(doc.content);
    return {
        id: doc.$id,
        notifyDateTime: formatDateTimeInSpanishTime(doc.notifydatetime) || doc.notifydatetime,
        notifyDateTimeUtc: doc.notifydatetime,
        content: state.message,
        status: state.status,
        repeatCount: state.repeatCount,
        userId: state.userId,
        channelId: state.channelId,
        threadTs: state.threadTs,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        lastNotifiedAt: state.lastNotifiedAt
    };
}

async function createReminder({ userId, channelId, threadTs = null, content, notifyDateTime }) {
    const now = new Date().toISOString();
    const state = {
        message: content,
        userId,
        channelId: channelId || userId,
        threadTs,
        status: 'unread',
        repeatCount: 0,
        createdAt: now,
        updatedAt: now,
        lastNotifiedAt: null
    };

    const reminderDoc = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_REMINDERS_COLLECTION_ID,
        appwrite.ID.unique(),
        {
            notifydatetime: notifyDateTime,
            content: serializeReminderContent(state)
        }
    );

    return normalizeReminderDoc(reminderDoc);
}

async function listReminders(userId, { includeRead = false } = {}) {
    const docs = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_REMINDERS_COLLECTION_ID,
        [
            appwrite.Query.orderDesc('$createdAt'),
            appwrite.Query.limit(200)
        ]
    );

    return docs.documents
        .map(normalizeReminderDoc)
        .filter((reminder) => reminder.userId === userId)
        .filter((reminder) => includeRead || reminder.status !== 'read');
}

async function editReminder(reminderId, userId, updates = {}) {
    const reminderDoc = await databases.getDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_REMINDERS_COLLECTION_ID,
        reminderId
    );

    const state = parseReminderContent(reminderDoc.content);
    if (state.userId !== userId) {
        return { success: false, message: "That reminder doesn't belong to you." };
    }

    const now = new Date().toISOString();
    let nextNotifyDateTime = reminderDoc.notifydatetime;

    if (typeof updates.content === 'string' && updates.content.trim()) {
        state.message = updates.content.trim();
    }

    if (typeof updates.notifyDateTime === 'string') {
        const parsed = new Date(updates.notifyDateTime);
        if (Number.isNaN(parsed.getTime())) {
            return { success: false, message: "Invalid notify datetime." };
        }
        nextNotifyDateTime = parsed.toISOString();
    }

    if (updates.markAsRead === true) {
        state.status = 'read';
    }

    if (updates.markAsRead === false) {
        state.status = 'unread';
    }

    if (updates.resetRepeats === true) {
        state.repeatCount = 0;
        state.lastNotifiedAt = null;
    }

    state.updatedAt = now;

    const updatedDoc = await databases.updateDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_REMINDERS_COLLECTION_ID,
        reminderId,
        {
            notifydatetime: nextNotifyDateTime,
            content: serializeReminderContent(state)
        }
    );

    return { success: true, reminder: normalizeReminderDoc(updatedDoc) };
}

async function processPendingReminders() {
    if (isProcessingReminders) return;
    isProcessingReminders = true;

    try {
        const now = new Date();
        const nowIso = now.toISOString();
        const allReminderDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_REMINDERS_COLLECTION_ID,
            [
                appwrite.Query.orderDesc('$createdAt'),
                appwrite.Query.limit(200)
            ]
        );

        for (const reminderDoc of allReminderDocs.documents) {
            try {
                const notifyDate = new Date(reminderDoc.notifydatetime);
                if (Number.isNaN(notifyDate.getTime())) {
                    console.error(`Skipping reminder ${reminderDoc.$id}: invalid notifydatetime "${reminderDoc.notifydatetime}"`);
                    continue;
                }
                if (notifyDate > now) {
                    continue;
                }

                const state = parseReminderContent(reminderDoc.content);
                if (state.status === 'read') {
                    continue;
                }
                if (!state.message || !state.userId) {
                    continue;
                }

                const reminderNumber = state.repeatCount + 1;
                const reminderText = reminderNumber === 1
                    ? `${state.message}`
                    : `(${getOrdinalNumberLabel(reminderNumber)} reminder) ${state.message}`;

                await app.client.chat.postMessage({
                    channel: state.channelId || state.userId,
                    text: reminderText,
                    thread_ts: state.threadTs || undefined
                });

                state.repeatCount += 1;
                state.lastNotifiedAt = nowIso;
                state.updatedAt = nowIso;

                const nextNotificationDate = new Date(now.getTime() + (30 * 60 * 1000)).toISOString();

                await databases.updateDocument(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_REMINDERS_COLLECTION_ID,
                    reminderDoc.$id,
                    {
                        notifydatetime: nextNotificationDate,
                        content: serializeReminderContent(state)
                    }
                );
            } catch (error) {
                console.error('Error processing reminder:', error);
            }
        }
    } catch (error) {
        console.error('Error processing pending reminders:', error);
    } finally {
        isProcessingReminders = false;
    }
}

async function getCodingStats(startDate = null, endDate = null) {
    try {
        let url = `${HACKATIME_BASE_URL}/users/my/stats?features=projects`;
        
        if (startDate) url += `&start_date=${startDate}`;
        if (endDate) url += `&end_date=${endDate}`;
                
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${HACKATIME_API_KEY}`
            }
        });
                
        return response.data.data;
    } catch (error) {
        console.error('Error fetching Hackatime stats:', error.response?.data || error.message);
        throw new Error(`Failed to fetch coding stats: ${error.message}`);
    }
}

async function getLastFmTracksToday() {
    if (!LASTFM_API_KEY || !LASTFM_USERNAME) return [];
    try {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        const from = Math.floor(startOfDay.getTime() / 1000);
        const response = await axios.get(LASTFM_BASE_URL, {
            params: {
                method: 'user.getrecenttracks',
                user: LASTFM_USERNAME,
                api_key: LASTFM_API_KEY,
                from,
                limit: 200,
                format: 'json',
            },
        });
        const raw = response.data?.recenttracks?.track || [];
        return raw.filter(t => t.date);
    } catch (error) {
        console.error('Error fetching Last.fm tracks:', error.response?.data || error.message);
        throw new Error(`Failed to fetch Last.fm tracks: ${error.message}`);
    }
}

async function getEmbedding(text, { traceId, sessionId, parentId } = {}) {
    const startTime = Date.now();
    let isError = false;
    let errorMsg = null;

    try {
        const response = await axios.post(
            HC_EMBEDDINGS_URL,
            {
                input: text,
                model: 'openai/text-embedding-3-small'
            },
            {
                headers: {
                    'Authorization': `Bearer ${HC_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const latency = (Date.now() - startTime) / 1000;
        const usage = response.data.usage;

        captureAIEmbedding({
            distinctId: USER_ID,
            traceId,
            sessionId,
            spanName: 'getEmbedding',
            parentId,
            model: 'openai/text-embedding-3-small',
            input: text,
            inputTokens: usage?.prompt_tokens || usage?.total_tokens,
            latency,
        });

        return response.data.data[0].embedding;
    } catch (error) {
        captureAIEmbedding({
            distinctId: USER_ID,
            traceId,
            sessionId,
            spanName: 'getEmbedding',
            parentId,
            model: 'openai/text-embedding-3-small',
            input: text,
            latency: (Date.now() - startTime) / 1000,
            isError: true,
            error: error.message,
            httpStatus: error.response?.status,
        });
        throw error;
    }
}

async function addMemoryToAppwrite(content, category = 'general') {
    try {
        const existingDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_MEMORY_COLLECTION_ID,
            [appwrite.Query.equal('content', content)]
        );
        
        if (existingDocs.documents.length > 0) {
            return existingDocs.documents[0].$id;
        }
    } catch (e) {
        console.log('Could not check for duplicates:', e.message);
    }
    
    const docId = appwrite.ID.unique();
    const now = new Date().toISOString();
    
    await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_MEMORY_COLLECTION_ID,
        docId,
        {
            content: content,
            category: category,
            createdAt: now,
            synced: false
        }
    );
    
    return docId;
}

async function syncMemoriesToVector() {
    try {
        const unsyncedDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_MEMORY_COLLECTION_ID,
            [appwrite.Query.equal('synced', false)]
        );

        if (unsyncedDocs.documents.length === 0) {
        } else {
            for (const doc of unsyncedDocs.documents) {
                const embedding = await getEmbedding(doc.content);
                await vectorIndex.upsert({
                    id: doc.$id,
                    vector: embedding,
                    metadata: {
                        content: doc.content,
                        category: doc.category || 'general',
                        createdAt: doc.createdAt
                    }
                });

                await databases.updateDocument(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_MEMORY_COLLECTION_ID,
                    doc.$id,
                    { synced: true }
                );
            }
        }

        await syncDeletions();

        lastSyncTime = new Date();
    } catch (error) {
        console.error('[Sync] Error:', error);
    }
}

async function syncDeletions() {
    try {
        const allAppwriteDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_MEMORY_COLLECTION_ID,
            [appwrite.Query.limit(1000)]
        );
        const appwriteIds = new Set(allAppwriteDocs.documents.map(d => d.$id));

        const vectorResults = await vectorIndex.range({ cursor: 0, limit: 1000, includeMetadata: false });
        const vectorIds = vectorResults.vectors.map(v => v.id);

        const toDelete = vectorIds.filter(id => !appwriteIds.has(id));
        
        if (toDelete.length > 0) {
            await vectorIndex.delete(toDelete);
        } else {
        }
    } catch (error) {
        console.error('Error checking deletions:', error);
    }
}

async function queryMemories(query, topK = 5) {
    try {
        const queryEmbedding = await getEmbedding(query);
        
        const results = await vectorIndex.query({
            vector: queryEmbedding,
            topK: topK,
            includeMetadata: true
        });

        const memories = results.map(r => ({
            content: r.metadata?.content,
            category: r.metadata?.category,
            score: r.score
        })).filter(r => r.content);
                
        return memories;
    } catch (error) {
        console.error('[Query] Error:', error);
        return [];
    }
}

let currentMessageContext = {
    userId: null,
    channelId: null,
    messageTs: null,
    threadTs: null,
    history: [],
    source: 'slack',
    conversationId: null
};

function getToolDeps() {
    return {
        app,
        appwrite,
        storage,
        fs,
        path,
        axios,
        InputFile,
        rootDir: __dirname,
        CHANNEL_ID,
        USER_ID,
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
        APPWRITE_DATABASE_ID,
        APPWRITE_BUCKET_ID,
        APPWRITE_REMINDERS_COLLECTION_ID,
        databases,
        getCodingStats,
        addMemoryToAppwrite,
        syncMemoriesToVector,
        createReminder,
        listReminders,
        editReminder,
        processPendingReminders,
        addReactionToMessage,
        recordSlackReactionForWebMirror,
        SEARCH_API_KEY,
        SEARCH_API_BASE_URL
    };
}

async function executeImmediateTool(toolName, toolInput, context) {
    const handler = TOOL_HANDLERS.get(toolName);
    if (!handler || handler.executionType !== 'instant') {
        return { success: false, message: `Unknown immediate tool: ${toolName}` };
    }

    try {
        return await handler.run({
            toolInput,
            messageContext: context,
            deps: getToolDeps()
        });
    } catch (error) {
        return { success: false, message: `Error: ${error.message}` };
    }
}

async function executeToolCall(toolName, toolInput, context = null) {
    const handler = TOOL_HANDLERS.get(toolName);
    if (!handler || handler.executionType !== 'async') {
        console.log(`Unknown tool: ${toolName}`);
        return { success: false, message: `Unknown tool: ${toolName}` };
    }

    return handler.run({
        toolInput,
        messageContext: context,
        deps: getToolDeps()
    });
}

async function queueToolExecution(toolName, toolInput, userId, channelId, threadTs = null, source = 'slack') {
     return new Promise((resolve) => {
         toolQueue.push({
             toolName,
             toolInput,
             userId,
             channelId,
             threadTs,
             source,
             resolve,
             timestamp: Date.now()
         });
         processToolQueue();
     });
 }

async function processToolQueue() {
    if (isProcessingQueue || toolQueue.length === 0) return;
    
    isProcessingQueue = true;
    
    while (toolQueue.length > 0) {
        const job = toolQueue.shift();
        const { toolName, toolInput, userId, channelId, resolve, source } = job;
                
        try {
            const result = await executeToolCall(toolName, toolInput, {
                userId: job.userId,
                channelId: job.channelId,
                threadTs: job.threadTs,
                source: source || 'slack'
            });

            const silentTools = ['add_memory', 'send_message', 'react'];
            if (source === 'slack' && !silentTools.includes(toolName)) {
                const aiResponse = await processToolResultThroughAI(toolName, result);
                const targetChannel = channelId || userId;
                if (targetChannel) {
                    try {
                        await app.client.chat.postMessage({
                            channel: targetChannel,
                            text: aiResponse,
                            thread_ts: job.threadTs ? String(job.threadTs) : undefined
                        });
                    } catch (postError) {
                        console.error('Failed to post async tool result to Slack:', postError);
                    }
                }
            }
            
            resolve({ status: "completed", result });
        } catch (error) {
             console.error(`Error processing ${toolName}:`, error);
             
             const silentTools = ['add_memory'];
             if (source === 'slack' && !silentTools.includes(toolName)) {
                 const errorResponse = `Uh oh, something went wrong with ${toolName}: ${error.message} :heavysob:`;
                 const targetChannel = channelId || userId;
                 if (targetChannel) {
                    try {
                        await app.client.chat.postMessage({
                            channel: targetChannel,
                            text: errorResponse,
                            thread_ts: job.threadTs ? String(job.threadTs) : undefined
                        });
                    } catch (postError) {
                        console.error('Failed to post async tool error to Slack:', postError);
                    }
                 }
            }
            
            resolve({ status: "error", error: error.message });
        }
    }
    
    isProcessingQueue = false;
}

async function processToolResultThroughAI(toolName, toolResult) {
    const prompt = `A tool just completed. Tool: "${toolName}", Result: ${JSON.stringify(toolResult)}. 
Send a brief, natural response about what happened. Keep it short and use :3 if appropriate.
You're in Slack, so you need to use its markdown if you need to use formatting. Links for example are like <link|text>.`;
    
    const model = getActiveModel();
    const inputMessages = [
        { role: "system", content: "You're Lana, Zoe's AI assistant. Respond briefly to tool results." },
        { role: "user", content: prompt }
    ];

    const startTime = Date.now();
    const response = await axios.post(HC_CHAT_URL, {
        model,
        messages: inputMessages,
        max_tokens: 256
    }, {
        headers: {
            'Authorization': `Bearer ${HC_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });
    const latency = (Date.now() - startTime) / 1000;

    const usage = response.data.usage;
    const outputContent = response.data.choices[0].message.content || `Finished ${toolName}!`;

    captureAIGeneration({
        distinctId: USER_ID,
        spanName: 'processToolResultThroughAI',
        model,
        input: inputMessages,
        inputTokens: usage?.prompt_tokens,
        outputChoices: [{ role: 'assistant', content: outputContent }],
        outputTokens: usage?.completion_tokens,
        latency,
    });

    return outputContent;
}

async function getSlackHistory(channelId, limit = 20, threadTs = null) {
    try {
        if (!threadTs) {
            return [];
        }

        const threadResult = await app.client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: 200
        });

        const threadMessages = threadResult.messages.slice(-10);
        const messages = threadMessages
            .map(msg => ({
                role: msg.bot_id ? "assistant" : "user",
                content: msg.text || "",
                timestamp: msg.ts,
                type: "thread_reply"
            }));

        return messages.filter(msg => msg.content);
    } catch (error) {
        console.error('Error fetching Slack history:', error);
        return [];
    }
}

async function storeConversationHistory(userMessage, assistantResponse) {
    const timestamp = new Date().toISOString();
    const historyEntry = `[${timestamp}] User: ${userMessage}\n[${timestamp}] Assistant: ${assistantResponse}`;
    
    try {
        const existingDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_MEMORY_COLLECTION_ID,
            [appwrite.Query.equal('content', historyEntry)]
        );
        
        if (existingDocs.documents.length === 0) {
            await addMemoryToAppwrite(historyEntry, 'history');
        }
    } catch (error) {
        console.log('Could not check history for duplicates:', error.message);
    }
}

async function chat(userMessage, fileInfo = null, channelId = null, userId = null, messageTs = null, threadTs = null, options = {}) {
    const source = options?.source || 'slack';
    const traceId = crypto.randomUUID();
    const sessionId = options?.sessionId || threadTs || messageTs || null;
    const traceStartTime = Date.now();

     const memories = await queryMemories(userMessage, 50);
     let memoryContext = "";
     
     const actualMemories = memories.filter(m => m.category !== 'history' && m.score > 0.5).slice(0, 10);

     if (actualMemories.length > 0) {
         memoryContext += "\n\nRelevant memories:\n" + 
             actualMemories.map(m => `- [${m.category}] ${m.content}`).join("\n");
     }
     
     console.log('Memory context:', memoryContext);

    const promptTemplate = await getPromptForContext({
        source,
        userId,
        linkedAppwriteUserId: options?.linkedAppwriteUserId || null
    });
    const systemPrompt = promptTemplate
        .replace('{{CURRENT_DATETIME}}', getCurrentSpanishDateTimeString())
        .replace('{{MEMORY_CONTEXT}}', memoryContext) +
        `\n\nTime handling rule: unless the user explicitly provides another timezone, interpret times as ${SPANISH_TIME_ZONE}.`;

    let userContent = userMessage;
    if (fileInfo) {
        userContent += `\n\n[User attached a file: "${fileInfo.name}" - URL: ${fileInfo.url}]`;
    }

    const messages = [{ role: "system", content: systemPrompt }];
    
    let conversationHistory = [];
    if (Array.isArray(options?.history) && options.history.length > 0) {
        conversationHistory = options.history
            .filter((msg) => msg && typeof msg.content === 'string' && msg.content.trim().length > 0)
            .map((msg) => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content,
                timestamp: msg.timestamp || msg.createdAt || null,
                type: msg.type || 'conversation'
            }));
    } else if (channelId && threadTs) {
        conversationHistory = await getSlackHistory(channelId, 5, threadTs);
    }

    for (const msg of conversationHistory) {
        if (msg.timestamp === messageTs) {
            continue;
        }
        messages.push({ role: msg.role, content: msg.content });
    }
    
    messages.push({ role: "user", content: userContent });
    
    currentMessageContext = {
        userId,
        channelId,
        messageTs,
        threadTs,
        history: conversationHistory,
        source,
        conversationId: options?.conversationId || null,
        currentUserMessageId: options?.currentUserMessageId || null,
        linkedAppwriteUserId: options?.linkedAppwriteUserId || null
    };
        
    const activeModel = getActiveModel();
    const activeToolset = getActiveToolset(source, currentMessageContext);
    const activeTools = activeToolset.declarations;
    const activeInstantTools = activeToolset.instantNames;
    const activeAsyncTools = activeToolset.asyncNames;
    
    let response;
    let chatStartTime = Date.now();
    try {
        response = await axios.post(HC_CHAT_URL, {
            model: activeModel,
            messages: messages,
            tools: activeTools,
            max_tokens: 2048
        }, {
            headers: {
                'Authorization': `Bearer ${HC_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        console.error('Request size:', JSON.stringify({model: activeModel, messages: messages, tools: activeTools, max_tokens: 2048}).length, 'bytes');
        captureAIGeneration({
            distinctId: userId || USER_ID,
            traceId,
            sessionId,
            spanName: 'chat',
            model: activeModel,
            input: messages,
            isError: true,
            error: error.response?.data || error.message,
            httpStatus: error.response?.status,
            tools: activeTools,
            latency: (Date.now() - chatStartTime) / 1000,
        });
        throw error;
    }

    let chatLatency = (Date.now() - chatStartTime) / 1000;
    let usage = response.data.usage;
    let assistantMessage = response.data.choices[0].message;

    captureAIGeneration({
        distinctId: userId || USER_ID,
        traceId,
        sessionId,
        spanName: 'chat',
        model: activeModel,
        input: messages,
        inputTokens: usage?.prompt_tokens,
        outputChoices: [assistantMessage],
        outputTokens: usage?.completion_tokens,
        latency: chatLatency,
        tools: activeTools,
    });
    let usedSendMessage = false;
    const toolSendMessages = [];
    const webDirectMessages = [];
    const emitWebEvent = typeof options?.onWebEvent === 'function'
        ? (event) => {
            try {
                options.onWebEvent(event);
            } catch (_) {
            }
        }
        : null;

    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push(assistantMessage);

        for (const toolCall of assistantMessage.tool_calls) {
            const toolStartTime = Date.now();
            try {
                const args = JSON.parse(toolCall.function.arguments);
                let toolResult;
                
                console.log(`Executing tool: ${toolCall.function.name}`, args);
                
                if (toolCall.function.name === 'send_message') {
                    usedSendMessage = true;
                    if (typeof args?.message === 'string' && args.message.trim()) {
                        const directMessage = args.message.trim();
                        toolSendMessages.push(directMessage);
                        if (source === 'web' && emitWebEvent) {
                            emitWebEvent({
                                type: 'tool_message',
                                toolName: 'send_message',
                                messageId: `live-${crypto.randomUUID()}`,
                                content: directMessage
                            });
                        }
                    }
                }

                if (
                    ZOE_TOOL_NAMES.has(toolCall.function.name) &&
                    !canUseZoeTools(currentMessageContext)
                ) {
                    toolResult = {
                        success: false,
                        message: `The tool "${toolCall.function.name}" is a zoe tool and only works for the authorized user/channel.`
                    };
                } else if (activeInstantTools.includes(toolCall.function.name)) {
                     toolResult = await executeImmediateTool(toolCall.function.name, args, currentMessageContext);
                 } else if (activeAsyncTools.includes(toolCall.function.name)) {
                     if (source === 'web') {
                        toolResult = await executeToolCall(toolCall.function.name, args, currentMessageContext);
                     } else {
                        queueToolExecution(toolCall.function.name, args, userId, channelId, threadTs, source);
                        toolResult = { queued: true, message: `${toolCall.function.name} queued` };
                     }
                 } else {
                     toolResult = { success: false, message: `Unknown or disabled tool: ${toolCall.function.name}` };
                 }

                if (
                    source === 'web' &&
                    toolCall.function.name === 'send_message' &&
                    toolResult &&
                    typeof toolResult.directMessage === 'string' &&
                    toolResult.directMessage.trim().length > 0
                ) {
                    webDirectMessages.push(toolResult.directMessage.trim());
                }

                if (
                    source === 'web' &&
                    emitWebEvent &&
                    toolCall.function.name === 'react' &&
                    toolResult &&
                    toolResult.success
                ) {
                    const reactionName = String(toolResult.emoji || '').trim();
                    const targetMessageId = String(toolResult.targetMessageId || '').trim();
                    if (reactionName && targetMessageId) {
                        const reactions = Array.isArray(toolResult.reactions) ? toolResult.reactions : [reactionName];
                        emitWebEvent({
                            type: 'reaction',
                            toolName: 'react',
                            emoji: reactionName,
                            targetMessageId,
                            reactions
                        });
                    }
                }

                console.log(`Tool result:`, toolResult);

                captureAISpan({
                    distinctId: userId || USER_ID,
                    traceId,
                    sessionId,
                    spanId: toolCall.id,
                    spanName: toolCall.function.name,
                    parentId: traceId,
                    inputState: args,
                    outputState: toolResult,
                    latency: (Date.now() - toolStartTime) / 1000,
                });

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult)
                });
            } catch (error) {
                console.error(`Error processing tool:`, error);

                captureAISpan({
                    distinctId: userId || USER_ID,
                    traceId,
                    sessionId,
                    spanId: toolCall.id,
                    spanName: toolCall.function.name,
                    parentId: traceId,
                    inputState: toolCall.function.arguments,
                    latency: (Date.now() - toolStartTime) / 1000,
                    isError: true,
                    error: error.message,
                });

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ success: false, message: error.message })
                });
            }
        }

        chatStartTime = Date.now();
        try {
            response = await axios.post(HC_CHAT_URL, {
                model: activeModel,
                messages: messages,
                tools: activeTools,
                max_tokens: 2048
            }, {
                headers: {
                    'Authorization': `Bearer ${HC_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
        } catch (error) {
            console.error('AI API Error:', error.response?.data || error.message);
            console.error('Request size:', JSON.stringify({model: activeModel, messages: messages, tools: activeTools, max_tokens: 2048}).length, 'bytes');
            captureAIGeneration({
                distinctId: userId || USER_ID,
                traceId,
                sessionId,
                spanName: 'chat_tool_followup',
                model: activeModel,
                input: messages,
                isError: true,
                error: error.response?.data || error.message,
                httpStatus: error.response?.status,
                tools: activeTools,
                latency: (Date.now() - chatStartTime) / 1000,
            });
            throw error;
        }

        chatLatency = (Date.now() - chatStartTime) / 1000;
        usage = response.data.usage;
        assistantMessage = response.data.choices[0].message;

        captureAIGeneration({
            distinctId: userId || USER_ID,
            traceId,
            sessionId,
            spanName: 'chat_tool_followup',
            model: activeModel,
            input: messages,
            inputTokens: usage?.prompt_tokens,
            outputChoices: [assistantMessage],
            outputTokens: usage?.completion_tokens,
            latency: chatLatency,
            tools: activeTools,
        });
    }

    let finalOutput = usedSendMessage ? null : assistantMessage.content;
    const webDirectMessage = webDirectMessages.length > 0
        ? webDirectMessages.join('\n\n')
        : null;

    if (source === 'web' && looksLikeToolArtifactMessage(finalOutput) && webDirectMessage) {
        finalOutput = webDirectMessage;
    }

    if (!finalOutput && source === 'web' && webDirectMessage) {
        finalOutput = webDirectMessage;
    }
    if (!finalOutput && !usedSendMessage && source !== 'web') {
        finalOutput = "Huh... No response was generated.";
    }

    const assistantMessages = [];
    for (const message of toolSendMessages) {
        if (message) assistantMessages.push(message);
    }
    if (
        source !== 'web' &&
        typeof assistantMessage?.content === 'string' &&
        assistantMessage.content.trim() &&
        !looksLikeToolArtifactMessage(assistantMessage.content)
    ) {
        assistantMessages.push(assistantMessage.content.trim());
    }
    if (assistantMessages.length === 0 && finalOutput && source !== 'web') {
        assistantMessages.push(finalOutput);
    }

    captureAITrace({
        distinctId: userId || USER_ID,
        traceId,
        sessionId,
        spanName: 'chat',
        inputState: [{ role: 'user', content: userMessage }],
        outputState: finalOutput ? [{ role: 'assistant', content: finalOutput }] : null,
        latency: (Date.now() - traceStartTime) / 1000,
    });

    if (options?.returnDetailedOutput) {
        return {
            finalText: finalOutput,
            assistantMessages
        };
    }

    return finalOutput;
}

function normalizeConversationTitle(title) {
    const nextTitle = typeof title === 'string' ? title.trim() : '';
    if (!nextTitle) {
        return 'New conversation';
    }
    return nextTitle.slice(0, 120);
}

function buildConversationTitleFromMessage(message) {
    const collapsed = message
        .replace(/\s+/g, ' ')
        .trim();
    if (!collapsed) {
        return 'New conversation';
    }
    return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function normalizeWebConversationDoc(doc) {
    return {
        id: doc.$id,
        title: normalizeConversationTitle(doc.title),
        userId: doc.userId,
        createdAt: doc.$createdAt,
        updatedAt: doc.$updatedAt
    };
}

function normalizeWebConversationMessageDoc(doc) {
    return {
        id: doc.$id,
        conversationId: doc.conversationId,
        userId: doc.userId,
        role: doc.role === 'assistant' ? 'assistant' : 'user',
        content: doc.content || '',
        createdAt: doc.$createdAt
    };
}

async function getWebConversationById(conversationId) {
    try {
        const doc = await databases.getDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_CONVERSATIONS_COLLECTION_ID,
            conversationId
        );
        return normalizeWebConversationDoc(doc);
    } catch (error) {
        if (error?.code === 404) {
            return null;
        }
        throw error;
    }
}

async function getWebConversationForUser(conversationId, userId) {
    const conversation = await getWebConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
        return null;
    }
    return conversation;
}

async function listWebConversations(userId) {
    const docs = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_CONVERSATIONS_COLLECTION_ID,
        [
            appwrite.Query.equal('userId', userId),
            appwrite.Query.orderDesc('$updatedAt'),
            appwrite.Query.limit(100)
        ]
    );

    return docs.documents.map(normalizeWebConversationDoc);
}

async function createWebConversation(userId, title = 'New conversation') {
    const doc = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_CONVERSATIONS_COLLECTION_ID,
        appwrite.ID.unique(),
        {
            userId,
            title: normalizeConversationTitle(title)
        }
    );
    return normalizeWebConversationDoc(doc);
}

async function listWebConversationMessages(conversationId, limit = 200) {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const docs = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_CONVERSATION_MESSAGES_COLLECTION_ID,
        [
            appwrite.Query.equal('conversationId', conversationId),
            appwrite.Query.orderAsc('$createdAt'),
            appwrite.Query.limit(boundedLimit)
        ]
    );

    return docs.documents.map(normalizeWebConversationMessageDoc);
}

async function createWebConversationMessage({ conversationId, userId, role, content }) {
    const doc = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_CONVERSATION_MESSAGES_COLLECTION_ID,
        appwrite.ID.unique(),
        {
            conversationId,
            userId,
            role: role === 'assistant' ? 'assistant' : 'user',
            content
        }
    );

    return normalizeWebConversationMessageDoc(doc);
}

async function touchWebConversation(conversation, maybeNextTitle = null) {
    const nextTitle = normalizeConversationTitle(maybeNextTitle || conversation.title);
    const doc = await databases.updateDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_CONVERSATIONS_COLLECTION_ID,
        conversation.id,
        { title: nextTitle }
    );
    return normalizeWebConversationDoc(doc);
}

function mergeAssistantMessagesForModel(history = []) {
    const merged = [];

    for (const message of history) {
        if (!message || typeof message.content !== 'string') {
            continue;
        }

        const content = message.content.trim();
        if (!content) {
            continue;
        }

        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const last = merged[merged.length - 1];

        if (role === 'assistant' && last && last.role === 'assistant') {
            last.content = `${last.content}\n\n${content}`;
            continue;
        }

        merged.push({
            ...message,
            role,
            content
        });
    }

    return merged;
}

function buildSlackMirrorTitle(seedText = '') {
    const base = buildConversationTitleFromMessage(seedText || '');
    return normalizeConversationTitle(`Slack · ${base}`);
}

function buildSlackMirrorSettingId(appwriteUserId, channelId, threadTs) {
    return `slack-thread-${appwriteUserId}-${channelId}-${threadTs}`;
}

function buildSlackMessageMapSettingId(appwriteUserId, channelId, threadTs, messageTs) {
    return `slack-msg-map-${appwriteUserId}-${channelId}-${threadTs}-${messageTs}`;
}

function buildMessageReactionSettingId(conversationId, messageId) {
    return `reaction-${conversationId}-${messageId}`;
}

function buildSlackUserLinkSettingId(slackUserId) {
    return `slack-link-user-${slackUserId}`;
}

function buildAppwriteLinkSettingId(appwriteUserId) {
    return `slack-link-appwrite-${appwriteUserId}`;
}

function buildSlackLinkCodeSettingId(code) {
    return `slack-link-code-${code}`;
}

function buildWebOnboardingSettingId(appwriteUserId) {
    return `web-onboarding-${appwriteUserId}`;
}

function buildWebProfileSettingId(appwriteUserId) {
    return `web-profile-${appwriteUserId}`;
}

function sanitizeProfileText(value, fallback = '', maxLen = 160) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) return fallback;
    return normalized.slice(0, maxLen);
}

function buildLanaPromptFromProfile(profile = {}) {
    const ownerName = sanitizeProfileText(profile.ownerName, 'Zoe', 80);
    const lanaName = sanitizeProfileText(profile.lanaName, 'Lana', 80);
    const personality = sanitizeProfileText(
        profile.lanaPersonality,
        "friendly, helpful, and has a cute personality (use :3 and similar emoticons sometimes)",
        320
    );
    return `You are ${ownerName}'s personal AI assistant bot on Slack. Your name is ${lanaName}. You are ${personality}.

IMPORTANT: To reply to ${ownerName}, you MUST use the send_message tool. Any text you output outside of send_message will be ignored. Always use send_message for your responses.

You have access to long-term memory - information ${ownerName} has shared with you in past conversations. Use this context to provide personalized responses.

You can:
1. Remember things for ${ownerName} (use add_memory tool for important info)
2. Send messages (send_message tool - THIS IS HOW YOU REPLY, goes to thread, use send_to_channel=true to broadcast to main chat view too)
3. React to messages (react tool)
4. Search message history (search_messages tool)
5. Post yaps (messages) to ${ownerName}'s yapping channel (${ownerName} needs to provide the exact message to yap, or you can send ${ownerName} the exact text you're planning to yap, for approval first)
6. Manage CDN files (upload, rename, delete)
7. Get daily coding stats from HackaTime (get_coding_stats tool - shows projects breakdown, total time, and daily average)
8. Add/edit reminders. These notify on due date and once every 30 mins until mark as read/done.
9. Search the web/news/images/videos/suggestions (search_web tool)

About tools:
- send_message, react, search_messages, get_coding_stats, list_reminder, edit_reminder, search_web: Execute immediately
- add_memory, yap, create_reminder, cdn_*: These are queued async operations - tell the user you're queuing them EXCEPT for add_memory which is silent and happens in the background when you find it useful to remember something. You should NOT tell the user about add_memory usage unless they specifically ask you about it.

When ${ownerName} shares something important, use add_memory to save it.

Do NOT randomly react. At most run one react tool call per conversation, and only if it's really needed.

You can send multiple messages in one response - call send_message multiple times with different content.

You're in the Hack Club Slack workspace, and as such you can use workspace emojis. Here are some examples:
- :real:
- :heavysob:
- :yesyes:
- :no-no:
- :yay:
- :skulk:
- :upvote:
- :downvote:
- :this:
- :eyes_shaking:
- :loll:
- :same:
- :60fps-parrot:
- :leeks:

Use Slack formatting where appropriate (e.g., *bold*, _italic_, ~strikethrough~, \`code\`, \`\`\`code blocks\`\`\`, <links|with text>, etc).

Don't abuse emojis, but feel free to use them to express emotion and make your messages more fun. If reacting fails, no need to notify the user.

Profile context:
- Owner name: ${ownerName}
- Assistant name: ${lanaName}
- Assistant personality: ${personality}
- UI mode: forced dark mode

The current date and time is {{CURRENT_DATETIME}}.{{MEMORY_CONTEXT}}`;
}

function normalizeLinkCode(rawCode) {
    return String(rawCode || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 12);
}

async function getLinkedAppwriteUserIdForSlackUser(slackUserId) {
    if (!slackUserId) return null;
    const linked = await getSetting(buildSlackUserLinkSettingId(slackUserId));
    if (typeof linked !== 'string') return null;
    const normalized = linked.trim();
    return normalized || null;
}

async function getLinkedSlackUserIdForAppwriteUser(appwriteUserId) {
    if (!appwriteUserId) return null;
    const linked = await getSetting(buildAppwriteLinkSettingId(appwriteUserId));
    if (typeof linked !== 'string') return null;
    const normalized = linked.trim();
    return normalized || null;
}

async function isWebOnboardingCompleted(appwriteUserId) {
    if (!appwriteUserId) return false;
    const value = await getSetting(buildWebOnboardingSettingId(appwriteUserId));
    return value === 'completed';
}

async function markWebOnboardingCompleted(appwriteUserId) {
    if (!appwriteUserId) return false;
    return setSetting(buildWebOnboardingSettingId(appwriteUserId), 'completed');
}

async function getWebProfile(appwriteUserId) {
    if (!appwriteUserId) return null;
    const raw = await getSetting(buildWebProfileSettingId(appwriteUserId));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            ownerName: sanitizeProfileText(parsed.ownerName, 'Zoe', 80),
            lanaName: sanitizeProfileText(parsed.lanaName, 'Lana', 80),
            lanaPersonality: sanitizeProfileText(
                parsed.lanaPersonality,
                "friendly, helpful, and has a cute personality (use :3 and similar emoticons sometimes)",
                320
            ),
            slackReady: Boolean(parsed.slackReady),
            generatedPrompt: typeof parsed.generatedPrompt === 'string' ? parsed.generatedPrompt : null
        };
    } catch (_) {
        return null;
    }
}

async function saveWebProfile(appwriteUserId, profileInput = {}) {
    if (!appwriteUserId) return { success: false, message: 'Missing Appwrite user id.' };

    const profile = {
        ownerName: sanitizeProfileText(profileInput.ownerName, 'Zoe', 80),
        lanaName: sanitizeProfileText(profileInput.lanaName, 'Lana', 80),
        lanaPersonality: sanitizeProfileText(
            profileInput.lanaPersonality,
            "friendly, helpful, and has a cute personality (use :3 and similar emoticons sometimes)",
            320
        ),
        slackReady: Boolean(profileInput.slackReady)
    };
    const generatedPrompt = buildLanaPromptFromProfile(profile);
    const stored = await setSetting(
        buildWebProfileSettingId(appwriteUserId),
        JSON.stringify({
            ...profile,
            generatedPrompt
        })
    );

    if (!stored) {
        return { success: false, message: 'Failed to save profile settings.' };
    }

    return {
        success: true,
        profile: {
            ...profile,
            generatedPrompt
        }
    };
}

async function getPromptForContext({ source = 'slack', userId = null, linkedAppwriteUserId = null } = {}) {
    const appwriteUserId = source === 'web' ? userId : linkedAppwriteUserId;
    if (!appwriteUserId) {
        return getActivePrompt();
    }

    const profile = await getWebProfile(appwriteUserId);
    if (profile?.generatedPrompt) {
        return profile.generatedPrompt;
    }

    return getActivePrompt();
}

async function createSlackLinkCodeForAppwriteUser(appwriteUserId) {
    let code = '';
    for (let i = 0; i < 5; i += 1) {
        code = normalizeLinkCode(crypto.randomBytes(6).toString('base64url'));
        if (!code) continue;
        const exists = await getSetting(buildSlackLinkCodeSettingId(code));
        if (!exists) break;
    }

    if (!code) {
        throw new Error('Failed to generate link code.');
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await setSetting(
        buildSlackLinkCodeSettingId(code),
        JSON.stringify({ appwriteUserId, expiresAt })
    );

    return { code, expiresAt };
}

async function consumeSlackLinkCode(code, slackUserId) {
    const normalizedCode = normalizeLinkCode(code);
    if (!normalizedCode) {
        return { success: false, message: 'Invalid link code.' };
    }

    const settingId = buildSlackLinkCodeSettingId(normalizedCode);
    const rawPayload = await getSetting(settingId);
    if (!rawPayload) {
        return { success: false, message: 'Link code not found or already used.' };
    }

    let payload;
    try {
        payload = JSON.parse(rawPayload);
    } catch (_) {
        await deleteSetting(settingId);
        return { success: false, message: 'Link code payload is invalid.' };
    }

    const appwriteUserId = typeof payload?.appwriteUserId === 'string' ? payload.appwriteUserId.trim() : '';
    const expiresAt = typeof payload?.expiresAt === 'string' ? payload.expiresAt : null;
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;

    if (!appwriteUserId) {
        await deleteSetting(settingId);
        return { success: false, message: 'Link code is missing user identity.' };
    }

    if (!Number.isNaN(expiresAtMs) && Date.now() > expiresAtMs) {
        await deleteSetting(settingId);
        return { success: false, message: 'Link code expired. Generate a new one in web UI.' };
    }

    const existingSlackForAppwrite = await getLinkedSlackUserIdForAppwriteUser(appwriteUserId);
    if (existingSlackForAppwrite && existingSlackForAppwrite !== slackUserId) {
        await deleteSetting(buildSlackUserLinkSettingId(existingSlackForAppwrite));
    }

    const existingAppwriteForSlack = await getLinkedAppwriteUserIdForSlackUser(slackUserId);
    if (existingAppwriteForSlack && existingAppwriteForSlack !== appwriteUserId) {
        await deleteSetting(buildAppwriteLinkSettingId(existingAppwriteForSlack));
    }

    await setSetting(buildSlackUserLinkSettingId(slackUserId), appwriteUserId);
    await setSetting(buildAppwriteLinkSettingId(appwriteUserId), slackUserId);
    await deleteSetting(settingId);

    return { success: true, appwriteUserId };
}

async function ensureSlackMirrorConversation({ appwriteUserId, channelId, threadTs, titleSeed }) {
    if (!appwriteUserId || !channelId || !threadTs) {
        return null;
    }

    const settingId = buildSlackMirrorSettingId(appwriteUserId, channelId, threadTs);
    const existingConversationId = await getSetting(settingId);
    if (typeof existingConversationId === 'string' && existingConversationId.trim()) {
        const existingConversation = await getWebConversationById(existingConversationId.trim());
        if (existingConversation) {
            return existingConversation;
        }
    }

    const conversation = await createWebConversation(
        appwriteUserId,
        buildSlackMirrorTitle(titleSeed)
    );
    await setSetting(settingId, conversation.id);
    return conversation;
}

async function mirrorSlackThreadToWeb({
    appwriteUserId,
    channelId,
    threadTs,
    messageTs,
    userId,
    userText,
    assistantMessages = []
}) {
    const conversation = await ensureSlackMirrorConversation({
        appwriteUserId,
        channelId,
        threadTs,
        titleSeed: userText
    });
    if (!conversation) {
        return null;
    }

    const normalizedUserText = typeof userText === 'string' ? userText.trim() : '';
    if (normalizedUserText) {
        const userMessageDoc = await createWebConversationMessage({
            conversationId: conversation.id,
            userId: `slack:${userId || 'user'}`,
            role: 'user',
            content: normalizedUserText
        });
        if (messageTs) {
            await setSetting(
                buildSlackMessageMapSettingId(appwriteUserId, channelId, threadTs, messageTs),
                userMessageDoc.id
            );
        }
    }

    for (const assistantTextRaw of assistantMessages) {
        const assistantText = typeof assistantTextRaw === 'string' ? assistantTextRaw.trim() : '';
        if (!assistantText) continue;
        await createWebConversationMessage({
            conversationId: conversation.id,
            userId: 'slack:assistant',
            role: 'assistant',
            content: assistantText
        });
    }

    const shouldSetTitle = normalizeConversationTitle(conversation.title) === 'New conversation';
    const nextTitle = shouldSetTitle
        ? buildSlackMirrorTitle(userText)
        : conversation.title;
    return touchWebConversation(conversation, nextTitle);
}

async function listMessageReactions(conversationId, messageId) {
    const raw = await getSetting(buildMessageReactionSettingId(conversationId, messageId));
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    } catch (_) {
        return [];
    }
}

async function addReactionToMessage(conversationId, messageId, emoji) {
    const normalizedEmoji = String(emoji || '').trim();
    if (!conversationId || !messageId || !normalizedEmoji) {
        return [];
    }

    const existing = await listMessageReactions(conversationId, messageId);
    if (existing.includes(normalizedEmoji)) {
        return existing;
    }

    const next = [...existing, normalizedEmoji];
    await setSetting(
        buildMessageReactionSettingId(conversationId, messageId),
        JSON.stringify(next)
    );
    return next;
}

async function enrichMessagesWithReactions(conversationId, messages) {
    const enriched = [];
    for (const message of messages) {
        const reactions = await listMessageReactions(conversationId, message.id);
        enriched.push({
            ...message,
            reactions
        });
    }
    return enriched;
}

async function recordSlackReactionForWebMirror({
    linkedAppwriteUserId,
    channelId,
    threadTs,
    messageTs,
    emoji
}) {
    if (!linkedAppwriteUserId || !channelId || !threadTs || !messageTs || !emoji) {
        return { success: false };
    }

    const conversationId = await getSetting(
        buildSlackMirrorSettingId(linkedAppwriteUserId, channelId, threadTs)
    );
    if (!conversationId) {
        return { success: false };
    }

    const webMessageId = await getSetting(
        buildSlackMessageMapSettingId(linkedAppwriteUserId, channelId, threadTs, messageTs)
    );
    if (!webMessageId) {
        return { success: false };
    }

    const reactions = await addReactionToMessage(conversationId, webMessageId, emoji);
    publishWebConversationEvent(linkedAppwriteUserId, conversationId, {
        type: 'reaction',
        targetMessageId: webMessageId,
        emoji,
        reactions
    });
    return { success: true, conversationId, webMessageId, reactions };
}

async function verifyAppwriteJwt(jwt) {
    if (!jwt) {
        return null;
    }

    const userClient = new appwrite.Client();
    userClient
        .setEndpoint(APPWRITE_ENDPOINT)
        .setProject(APPWRITE_PROJECT_ID)
        .setJWT(jwt);

    const account = new appwrite.Account(userClient);
    return account.get();
}

function getBearerToken(req) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authHeader.slice('Bearer '.length).trim();
    return token || null;
}

function sendJson(res, statusCode, payload) {
    const data = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store'
    });
    res.end(data);
}

function sendText(res, statusCode, payload, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(statusCode, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(payload)
    });
    res.end(payload);
}

const webConversationEventSubscribers = new Map();

function buildWebConversationEventKey(userId, conversationId) {
    return `${userId}:${conversationId}`;
}

function publishWebConversationEvent(userId, conversationId, event) {
    if (!userId || !conversationId) return;
    const key = buildWebConversationEventKey(userId, conversationId);
    const subscribers = webConversationEventSubscribers.get(key);
    if (!subscribers || subscribers.size === 0) return;

    const payload = JSON.stringify({
        ...event,
        conversationId,
        ts: new Date().toISOString()
    });

    for (const res of subscribers) {
        try {
            res.write(`data: ${payload}\n\n`);
        } catch (_) {
        }
    }
}

function subscribeWebConversationEvents(userId, conversationId, res) {
    const key = buildWebConversationEventKey(userId, conversationId);
    let subscribers = webConversationEventSubscribers.get(key);
    if (!subscribers) {
        subscribers = new Set();
        webConversationEventSubscribers.set(key, subscribers);
    }
    subscribers.add(res);

    return () => {
        const current = webConversationEventSubscribers.get(key);
        if (!current) return;
        current.delete(res);
        if (current.size === 0) {
            webConversationEventSubscribers.delete(key);
        }
    };
}

function hasWebConversationSubscribers(userId, conversationId) {
    if (!userId || !conversationId) return false;
    const key = buildWebConversationEventKey(userId, conversationId);
    const subscribers = webConversationEventSubscribers.get(key);
    return Boolean(subscribers && subscribers.size > 0);
}

function formatServerError(error) {
    const details = [];

    if (typeof error?.code === 'number') {
        details.push(`code ${error.code}`);
    }
    if (typeof error?.type === 'string' && error.type.trim()) {
        details.push(error.type.trim());
    }
    if (typeof error?.message === 'string' && error.message.trim()) {
        details.push(error.message.trim());
    }
    if (typeof error?.response?.message === 'string' && error.response.message.trim()) {
        const responseMessage = error.response.message.trim();
        if (!details.includes(responseMessage)) {
            details.push(responseMessage);
        }
    }

    if (details.length === 0) {
        return 'Internal server error.';
    }

    return details.join(' | ');
}

function serializeErrorForClient(error) {
    const payload = {
        name: error?.name || null,
        code: typeof error?.code === 'number' ? error.code : null,
        type: typeof error?.type === 'string' ? error.type : null,
        message: typeof error?.message === 'string' ? error.message : null,
        responseMessage: typeof error?.response?.message === 'string' ? error.response.message : null,
        responseType: typeof error?.response?.type === 'string' ? error.response.type : null
    };

    if (IS_PRODUCTION) {
        return payload;
    }

    payload.stack = typeof error?.stack === 'string' ? error.stack : null;
    payload.raw = serializeLogValue(error);
    return payload;
}

async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;

        req.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }

            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });

        req.on('error', (error) => reject(error));
    });
}

async function readJsonBodyOrRespond(req, res) {
    try {
        return await readJsonBody(req);
    } catch (error) {
        if (error.message === 'Request body too large') {
            sendJson(res, 413, { success: false, message: 'Request body too large.' });
            return null;
        }

        sendJson(res, 400, { success: false, message: 'Invalid JSON body.' });
        return null;
    }
}

async function authenticateWebRequest(req, res, { requireVerifiedEmail = false, tokenOverride = null } = {}) {
    if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID) {
        sendJson(res, 503, {
            success: false,
            message: 'Appwrite auth is not configured on the server.'
        });
        return null;
    }

    const token = tokenOverride || getBearerToken(req);
    if (!token) {
        sendJson(res, 401, { success: false, message: 'Missing bearer token.' });
        return null;
    }

    try {
        const user = await verifyAppwriteJwt(token);
        if (requireVerifiedEmail && !user?.emailVerification) {
            sendJson(res, 403, {
                success: false,
                message: 'Email is not verified.'
            });
            return null;
        }
        return user;
    } catch (error) {
        sendJson(res, 401, { success: false, message: 'Invalid or expired token.' });
        return null;
    }
}

async function handleWebApi(req, res, requestUrl) {
    try {
        const pathname = requestUrl.pathname;
        if (req.method === 'GET' && pathname === '/api/health') {
            sendJson(res, 200, { success: true });
            return;
        }

        if (req.method === 'GET' && pathname === '/api/config') {
            sendJson(res, 200, {
                success: true,
                appwriteEndpoint: APPWRITE_ENDPOINT,
                appwriteProjectId: APPWRITE_PROJECT_ID
            });
            return;
        }

    if (req.method === 'GET' && pathname === '/api/me') {
            const user = await authenticateWebRequest(req, res);
            if (!user) return;
            const onboardingCompleted = await isWebOnboardingCompleted(user.$id);
            const onboardingProfile = await getWebProfile(user.$id);

            sendJson(res, 200, {
                success: true,
                user: {
                    id: user.$id,
                    name: user.name,
                    email: user.email,
                    emailVerification: Boolean(user.emailVerification),
                    onboardingCompleted,
                    onboardingProfile
                }
            });
            return;
        }

        if (pathname === '/api/onboarding') {
            const user = await authenticateWebRequest(req, res);
            if (!user) return;

            if (req.method === 'GET') {
                const onboardingCompleted = await isWebOnboardingCompleted(user.$id);
                const onboardingProfile = await getWebProfile(user.$id);
                sendJson(res, 200, {
                    success: true,
                    onboardingCompleted,
                    onboardingProfile
                });
                return;
            }

            if (req.method === 'POST') {
                const body = await readJsonBodyOrRespond(req, res);
                if (!body) return;
                const saveResult = await saveWebProfile(user.$id, body);
                if (!saveResult.success) {
                    sendJson(res, 500, { success: false, message: saveResult.message || 'Failed to save profile.' });
                    return;
                }
                const marked = await markWebOnboardingCompleted(user.$id);
                if (!marked) {
                    sendJson(res, 500, { success: false, message: 'Failed to save onboarding state.' });
                    return;
                }
                sendJson(res, 200, {
                    success: true,
                    onboardingCompleted: true,
                    onboardingProfile: saveResult.profile
                });
                return;
            }

            sendJson(res, 405, { success: false, message: 'Method not allowed.' });
            return;
        }

        if (pathname === '/api/link/slack') {
            const user = await authenticateWebRequest(req, res);
            if (!user) return;

            if (req.method === 'GET') {
                const linkedSlackUserId = await getLinkedSlackUserIdForAppwriteUser(user.$id);
                sendJson(res, 200, {
                    success: true,
                    linkedSlackUserId: linkedSlackUserId || null
                });
                return;
            }

            if (req.method === 'POST') {
                const link = await createSlackLinkCodeForAppwriteUser(user.$id);
                sendJson(res, 201, {
                    success: true,
                    code: link.code,
                    expiresAt: link.expiresAt
                });
                return;
            }

            sendJson(res, 405, { success: false, message: 'Method not allowed.' });
            return;
        }

        if (pathname === '/api/conversations') {
            const user = await authenticateWebRequest(req, res);
            if (!user) return;

            if (req.method === 'GET') {
                const conversations = await listWebConversations(user.$id);
                sendJson(res, 200, {
                    success: true,
                    conversations
                });
                return;
            }

            if (req.method === 'POST') {
                const body = await readJsonBodyOrRespond(req, res);
                if (!body) return;
                const conversation = await createWebConversation(user.$id, body.title);
                sendJson(res, 201, {
                    success: true,
                    conversation
                });
                return;
            }

            sendJson(res, 405, { success: false, message: 'Method not allowed.' });
            return;
        }

        const conversationEventsRouteMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/events$/);
        if (conversationEventsRouteMatch) {
            const conversationId = decodeURIComponent(conversationEventsRouteMatch[1]);
            if (conversationId.startsWith('_')) {
                sendJson(res, 404, { success: false, message: 'Conversation not found.' });
                return;
            }
            const tokenFromQuery = requestUrl.searchParams.get('token');
            const user = await authenticateWebRequest(req, res, { tokenOverride: tokenFromQuery || null });
            if (!user) return;

            const conversation = await getWebConversationForUser(conversationId, user.$id);
            if (!conversation) {
                sendJson(res, 404, { success: false, message: 'Conversation not found.' });
                return;
            }

            if (req.method !== 'GET') {
                sendJson(res, 405, { success: false, message: 'Method not allowed.' });
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.write(`data: ${JSON.stringify({ type: 'connected', conversationId, ts: new Date().toISOString() })}\n\n`);

            const unsubscribe = subscribeWebConversationEvents(user.$id, conversationId, res);
            const keepAlive = setInterval(() => {
                try {
                    res.write(`: ping\n\n`);
                } catch (_) {
                }
            }, 20000);

            req.on('close', () => {
                clearInterval(keepAlive);
                unsubscribe();
                try {
                    res.end();
                } catch (_) {
                }
            });
            return;
        }

        const messagesRouteMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if (messagesRouteMatch) {
            const user = await authenticateWebRequest(req, res);
            if (!user) return;

            const conversationId = decodeURIComponent(messagesRouteMatch[1]);
            if (conversationId.startsWith('_')) {
                sendJson(res, 404, { success: false, message: 'Conversation not found.' });
                return;
            }
            const conversation = await getWebConversationForUser(conversationId, user.$id);
            if (!conversation) {
                sendJson(res, 404, { success: false, message: 'Conversation not found.' });
                return;
            }

            if (req.method === 'GET') {
                const rawMessages = await listWebConversationMessages(conversation.id);
                const messages = await enrichMessagesWithReactions(conversation.id, rawMessages);
                sendJson(res, 200, { success: true, messages });
                return;
            }

            if (req.method === 'POST') {
                const body = await readJsonBodyOrRespond(req, res);
                if (!body) return;
                const content = typeof body.content === 'string' ? body.content.trim() : '';
                if (!content) {
                    sendJson(res, 400, { success: false, message: 'Message content is required.' });
                    return;
                }
                if (content.length > 6000) {
                    sendJson(res, 400, { success: false, message: 'Message is too long.' });
                    return;
                }

                const history = await listWebConversationMessages(conversation.id, 100);
                const modelHistory = mergeAssistantMessagesForModel(history);
                const userMessage = await createWebConversationMessage({
                    conversationId: conversation.id,
                    userId: user.$id,
                    role: 'user',
                    content
                });

                const assistantMessages = [];
                try {
                    const chatResult = await chat(
                        content,
                        null,
                        null,
                        user.$id,
                        null,
                        null,
                        {
                            history: modelHistory,
                            source: 'web',
                            sessionId: conversation.id,
                            conversationId: conversation.id,
                            currentUserMessageId: userMessage.id,
                            returnDetailedOutput: true,
                            onWebEvent: (event) => {
                                publishWebConversationEvent(user.$id, conversation.id, event);
                            }
                        }
                    );

                    const nextAssistantMessages = Array.isArray(chatResult?.assistantMessages)
                        ? chatResult.assistantMessages
                        : [];

                    for (const assistantTextRaw of nextAssistantMessages) {
                        const assistantText = typeof assistantTextRaw === 'string'
                            ? assistantTextRaw.trim()
                            : '';
                        if (!assistantText) {
                            continue;
                        }
                        const savedAssistantMessage = await createWebConversationMessage({
                            conversationId: conversation.id,
                            userId: user.$id,
                            role: 'assistant',
                            content: assistantText
                        });
                        const enrichedAssistantMessage = {
                            ...savedAssistantMessage,
                            reactions: await listMessageReactions(conversation.id, savedAssistantMessage.id)
                        };
                        assistantMessages.push(enrichedAssistantMessage);
                    }
                } catch (error) {
                    console.error('Web chat error:', error);
                    const fallbackMessage = "Something went wrong while generating a reply.";
                    const savedAssistantMessage = await createWebConversationMessage({
                        conversationId: conversation.id,
                        userId: user.$id,
                        role: 'assistant',
                        content: fallbackMessage
                    });
                    assistantMessages.push({
                        ...savedAssistantMessage,
                        reactions: await listMessageReactions(conversation.id, savedAssistantMessage.id)
                    });
                }

                const shouldSetTitle = normalizeConversationTitle(conversation.title) === 'New conversation';
                const nextTitle = shouldSetTitle
                    ? buildConversationTitleFromMessage(content)
                    : conversation.title;
                const updatedConversation = await touchWebConversation(conversation, nextTitle);

                const hasLiveSubscriber = hasWebConversationSubscribers(user.$id, conversation.id);
                const responseMessages = hasLiveSubscriber
                    ? [{ ...userMessage, reactions: await listMessageReactions(conversation.id, userMessage.id) }]
                    : [{ ...userMessage, reactions: await listMessageReactions(conversation.id, userMessage.id) }, ...assistantMessages];

                sendJson(res, 200, {
                    success: true,
                    conversation: updatedConversation,
                    messages: responseMessages
                });
                return;
            }

            sendJson(res, 405, { success: false, message: 'Method not allowed.' });
            return;
        }

        sendJson(res, 404, { success: false, message: 'API route not found.' });
    } catch (error) {
        console.error('Web API route error:', error);
        sendJson(res, 500, {
            success: false,
            message: formatServerError(error),
            error: serializeErrorForClient(error)
        });
    }
}

let webServer = null;

async function startWebServer() {
    if (!WEB_UI_ENABLED) {
        return;
    }

    webServer = http.createServer(async (req, res) => {
        try {
            const host = req.headers.host || `localhost:${WEB_UI_PORT}`;
            const requestUrl = new URL(req.url || '/', `http://${host}`);
            const pathname = requestUrl.pathname;

            if (pathname.startsWith('/api/')) {
                await handleWebApi(req, res, requestUrl);
                return;
            }

            if (req.method !== 'GET') {
                sendText(res, 405, 'Method Not Allowed');
                return;
            }

            if (pathname === '/favicon.ico') {
                res.writeHead(204);
                res.end();
                return;
            }

            sendJson(res, 404, {
                success: false,
                message: 'UI moved to Next.js app. Use the Next server for web pages.'
            });
        } catch (error) {
            console.error('Web server request error:', error);
            if ((req.url || '').startsWith('/api/')) {
                sendJson(res, 500, {
                    success: false,
                    message: formatServerError(error),
                    error: serializeErrorForClient(error)
                });
                return;
            }
            sendText(res, 500, 'Internal Server Error');
        }
    });

    await new Promise((resolve, reject) => {
        webServer.once('error', reject);
        webServer.listen(WEB_UI_PORT, WEB_UI_HOST, resolve);
    });

    console.log(`Web API server running on http://localhost:${WEB_UI_PORT}`);
}

async function stopWebServer() {
    if (!webServer) {
        return;
    }

    await new Promise((resolve, reject) => {
        webServer.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
    webServer = null;
}

function parseSlackLinkCommand(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return null;

    const stripped = text
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    let match = stripped.match(/^(?:\/)?link\b(?:\s+([A-Za-z0-9_-]+))?\s*$/i);
    if (match) {
        return {
            isLinkCommand: true,
            code: normalizeLinkCode(match[1] || '')
        };
    }

    match = stripped.match(/^<@[^>]+>\s*(?:\/)?link\b(?:\s+([A-Za-z0-9_-]+))?\s*$/i);
    if (match) {
        return {
            isLinkCommand: true,
            code: normalizeLinkCode(match[1] || '')
        };
    }

    return null;
}

app.message(async ({ message, say }) => {
    if (message.channel_type === 'im') {
        if (!message.text && !message.files) {
            return;
        }

        let fileInfo = null;
        if (message.files && message.files.length > 0) {
            const file = message.files[0];
            fileInfo = {
                name: file.name,
                url: file.url_private_download,
                id: file.id
            };
        }

        const userText = message.text || "";
        const linkCommand = parseSlackLinkCommand(userText);
        if (linkCommand?.isLinkCommand) {
            const providedCode = linkCommand.code;
            if (!providedCode) {
                const linkedAppwriteUserId = await getLinkedAppwriteUserIdForSlackUser(message.user);
                if (linkedAppwriteUserId) {
                    await say(`Slack is linked to Appwrite user \`${linkedAppwriteUserId}\`.`);
                } else {
                    await say('Open the web UI, generate a Slack link code, then DM me: `link <CODE>`');
                }
                return;
            }

            try {
                const linkResult = await consumeSlackLinkCode(providedCode, message.user);
                if (!linkResult.success) {
                    await say(`Link failed: ${linkResult.message}`);
                    return;
                }

                await say(`Your Slack account is now linked to Lana. You can start chatting!`);
                return;
            }
            catch (error) {
                console.error('Slack link command exception', error);
                await say(`Link failed: ${error.message}`);
                return;
            }
        }

        const linkedAppwriteUserId = await getLinkedAppwriteUserIdForSlackUser(message.user);
        if (!linkedAppwriteUserId) {
            await say('No WebUI account is linked to this Slack user yet. Open the web UI, generate a code, then DM Lana: `link <CODE>`');
            return;
        }

        const effectiveIdentity = linkedAppwriteUserId;
        let response;
        let assistantMessagesForMirror = [];
        
        try {
            const chatResult = await chat(
                userText, 
                fileInfo, 
                message.channel, 
                message.user,
                message.ts,
                message.thread_ts,
                {
                    returnDetailedOutput: true,
                    source: 'slack',
                    linkedAppwriteUserId: effectiveIdentity
                }
            );

            response = typeof chatResult === 'string' ? chatResult : (chatResult?.finalText || null);
            assistantMessagesForMirror = Array.isArray(chatResult?.assistantMessages)
                ? chatResult.assistantMessages
                : [];
            
            if (response) {
                if (message.thread_ts) {
                    await say({
                        text: response,
                        thread_ts: message.thread_ts
                    });
                } else {
                    await say({
                        text: response,
                        thread_ts: message.ts
                    });
                }
            } else {
                console.log('No response received');
            }
        } catch (error) {
            console.error('AI Error:', error);
            response = `[ERROR] ${error.message}`;
            assistantMessagesForMirror = [`Something went wrong :heavysob: ${error.message}`];
            
            if (message.thread_ts) {
                await say({
                    text: `Something went wrong :heavysob: ${error.message}`,
                    thread_ts: message.thread_ts
                });
            } else {
                await say({
                    text: `Something went wrong :heavysob: ${error.message}`,
                    thread_ts: message.ts
                });
            }
        }

        try {
            const threadRootTs = message.thread_ts || message.ts;
            await mirrorSlackThreadToWeb({
                appwriteUserId: linkedAppwriteUserId,
                channelId: message.channel,
                threadTs: threadRootTs,
                messageTs: message.ts,
                userId: message.user,
                userText,
                assistantMessages: assistantMessagesForMirror
            });
        } catch (mirrorError) {
            console.error('Failed to mirror Slack thread to web:', mirrorError);
        }
        
        try {
            const historyAssistantText = assistantMessagesForMirror.join('\n\n') || response || '';
            await storeConversationHistory(userText, historyAssistantText);
        } catch (historyError) {
            console.error('Failed to store history:', historyError);
        }
    }
});



app.action('reply_button_click', async ({ body, ack, client }) => {
    await ack();

    const originalMessage = body.actions[0].value;

    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                private_metadata: originalMessage,
                callback_id: 'suggest_yap_submission',
                title: {
                    type: 'plain_text',
                    text: 'Yap suggestion'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'yap_input_block',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'yap_input_action',
                            multiline: true
                        },
                        label: {
                            type: 'plain_text',
                    text: 'What do you want Lana to yap about?'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'consent_block',
                        element: {
                            type: 'checkboxes',
                            action_id: 'consent_action',
                            options: [
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Yes'
                                    },
                                    value: 'consent_given'
                                }
                            ],
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Are you ok with your question being shown? NOT your name, questions are anonymized.'
                        }
                    }
                ],
                submit: {
                    type: 'plain_text',
                    text: 'Send Yap :3'
                }
            }
        });
    } catch (error) {
        console.error(error);
    }
});

app.view('suggest_yap_submission', async ({ ack, body, view, client }) => {
    await ack();

    const suggestion = view.state.values.yap_input_block.yap_input_action.value;
    const user = body.user.id;
    const originalMessage = view.private_metadata;

    try {
        await client.chat.postMessage({
            channel: USER_ID,
            text: `New yap suggestion! "${suggestion}"\nOriginal Yap: "${originalMessage}"`
        });
        await client.chat.postMessage({
            channel: USER_ID,
            text: "Reply",
            blocks: [
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "Reply to the suggestion",
                                emoji: false,
                            },
                            action_id: "suggestion_reply_button_click",
                            value: suggestion
                        }
                    ]
                }
            ]
        });
    } catch (error) {
        console.error(error);
    }
});

app.action('suggestion_reply_button_click', async ({ body, ack, client }) => {
    await ack();
    const suggestion = body.actions[0].value;
    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                private_metadata: suggestion,
                callback_id: 'reply_yap_suggestion',
                title: {
                    type: 'plain_text',
                    text: 'Reply to suggestion'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'yap_input_block',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'yap_input_action',
                            multiline: true
                        },
                        label: {
                            type: 'plain_text',
                            text: 'What do you reply to "' + suggestion + '"?'
                        }
                    },
                ],
                submit: {
                    type: 'plain_text',
                    text: 'Reply :3'
                }
            }
        });
    } catch (error) {
        console.error(error);
    }
});

app.view('reply_yap_suggestion', async ({ ack, body, view, client }) => {
    await ack();
    const reply = view.state.values.yap_input_block.yap_input_action.value;
    const suggestion = view.private_metadata;
    try {
        await client.chat.postMessage({
            channel: CHANNEL_ID,
            text: `<!subteam^S09LUMPUBU0|cultists> *New yap! Go read it :tw_knife:*\n_(Replying to: "${suggestion}")_\n\n${reply}`
        });
        
        await client.chat.postMessage({
            channel: CHANNEL_ID,
            text: "Pls thread here! :thread: :D",
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "Pls thread here! :thread: :D"
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "Suggest a new yap",
                                emoji: false,
                            },
                            action_id: "reply_button_click",
                            value: reply
                        }
                    ]
                }
            ]
        });

    }
    catch (error) {
        console.error(error);
    }
});

async function buildHomeTab(userId) {
    const isOwner = userId === USER_ID;
    
    if (!isOwner) {
        return {
            type: 'home',
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: "*Access Denied*\n\nYou don't have permission to view this page."
                    }
                }
            ]
        };
    }
    
    const currentModel = getActiveModel();
    const currentPrompt = getActivePrompt();
    const allTools = getAllToolNames();
    const disabledTools = settingsCache.disabledTools;
    
    const toolOptions = allTools.map(toolName => ({
        text: { type: 'plain_text', text: toolName },
        value: toolName
    }));
    
    const enabledTools = allTools.filter(t => !disabledTools.has(t));
    const initialOptions = enabledTools.length > 0
        ? enabledTools.map(t => ({ text: { type: 'plain_text', text: t }, value: t }))
        : undefined;
    
    return {
        type: 'home',
        blocks: [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: 'Lana Bot Settings :3',
                    emoji: true
                }
            },
            {
                type: 'divider'
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Current Model:* \`${currentModel}\``
                },
                accessory: {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: 'Edit Model',
                        emoji: true
                    },
                    action_id: 'edit_model_button'
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*System Prompt:* _${currentPrompt.substring(0, 100)}..._`
                },
                accessory: {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: 'Edit Prompt',
                        emoji: true
                    },
                    action_id: 'edit_prompt_button'
                }
            },

            {
                type: 'divider'
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '*Enabled Tools*'
                },
                accessory: {
                    type: 'multi_static_select',
                    action_id: 'tools_multiselect',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Select enabled tools'
                    },
                    options: toolOptions,
                    ...(initialOptions && { initial_options: initialOptions })
                }
            },
            {
                type: 'divider'
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Last settings refresh: ${settingsCache.lastFetched ? settingsCache.lastFetched.toLocaleString() : 'Never'}`
                    }
                ]
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: 'Refresh Settings',
                            emoji: true
                        },
                        action_id: 'refresh_settings_button'
                    }
                ]
            }
        ]
    };
}

app.event('app_home_opened', async ({ event, client }) => {
    try {
        await refreshSettings();
        const homeView = await buildHomeTab(event.user);
        await client.views.publish({
            user_id: event.user,
            view: homeView
        });
    } catch (error) {
        console.error('Error publishing home tab:', error);
    }
});

app.action('refresh_settings_button', async ({ ack, body, client }) => {
    await ack();
    try {
        await refreshSettings();
        const homeView = await buildHomeTab(body.user.id);
        await client.views.publish({
            user_id: body.user.id,
            view: homeView
        });
    } catch (error) {
        console.error('Error refreshing settings:', error);
    }
});

app.action('edit_model_button', async ({ ack, body, client }) => {
    await ack();
    try {
        const models = await fetchAvailableModels();
        const currentModel = getActiveModel();
        
        const modelOptions = models.map(m => ({
            text: { type: 'plain_text', text: m.length > 75 ? m.substring(0, 72) + '...' : m },
            value: m
        }));
        
        const initialOption = modelOptions.find(o => o.value === currentModel) || modelOptions[0];
        
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'save_model_modal',
                title: {
                    type: 'plain_text',
                    text: 'Edit Model'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'model_input_block',
                        element: {
                            type: 'static_select',
                            action_id: 'model_input',
                            options: modelOptions,
                            initial_option: initialOption
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Model'
                        }
                    }
                ],
                submit: {
                    type: 'plain_text',
                    text: 'Save'
                }
            }
        });
    } catch (error) {
        console.error('Error opening model modal:', error);
    }
});

app.view('save_model_modal', async ({ ack, body, view, client }) => {
    await ack();
    const model = view.state.values.model_input_block.model_input.selected_option?.value;
    
    if (model) {
        await setSetting('model', model);
        await refreshSettings();
    }
    
    const homeView = await buildHomeTab(body.user.id);
    await client.views.publish({
        user_id: body.user.id,
        view: homeView
    });
});

app.action('edit_prompt_button', async ({ ack, body, client }) => {
    await ack();
    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'save_prompt_modal',
                title: {
                    type: 'plain_text',
                    text: 'Edit System Prompt'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'prompt_input_block',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'prompt_input',
                            multiline: true,
                            initial_value: getActivePrompt()
                        },
                        label: {
                            type: 'plain_text',
                            text: 'System Prompt'
                        }
                    }
                ],
                submit: {
                    type: 'plain_text',
                    text: 'Save'
                }
            }
        });
    } catch (error) {
        console.error('Error opening prompt modal:', error);
    }
});

app.view('save_prompt_modal', async ({ ack, body, view, client }) => {
    await ack();
    const prompt = view.state.values.prompt_input_block.prompt_input.value;
    
    if (prompt && prompt.trim()) {
        await setSetting('prompt', prompt.trim());
        await refreshSettings();
    }
    
    const homeView = await buildHomeTab(body.user.id);
    await client.views.publish({
        user_id: body.user.id,
        view: homeView
    });
});



app.action('tools_multiselect', async ({ ack, body, action, client }) => {
    await ack();
    
    try {
        const allTools = getAllToolNames();
        const selectedTools = new Set((action.selected_options || []).map((option) => option.value));

        for (const toolName of allTools) {
            const settingId = `tool-${toolName}`;
            if (selectedTools.has(toolName)) {
                await deleteSetting(settingId);
            } else {
                await setSetting(settingId, 'disabled');
            }
        }
        
        await refreshSettings();
        
        const homeView = await buildHomeTab(body.user.id);
        await client.views.publish({
            user_id: body.user.id,
            view: homeView
        });
    } catch (error) {
        console.error('Error updating tools:', error);
    }
});

app.event('member_joined_channel', async ({ event, client }) => {
    if (event.channel === CHANNEL_ID) {
        try {
            await client.chat.postMessage({
                channel: USER_ID,
                text: `Heyaaaaa :D Just letting you know user <@${event.user}> has joined your channel and (if they weren't there already) the ping group`,
            });

            await client.chat.postMessage({
                channel: USER_ID,
                text: `Lov yu byeee :3`,
            });

            const currentUsers = await client.usergroups.users.list({
                usergroup: 'S09LUMPUBU0'
            });
            
            if (currentUsers.users.includes(event.user)) {
                console.log(`User ${event.user} is already in the cultists group.`);
                return;
            }

            const newUsersList = [...currentUsers.users, event.user].join(',');

            await client.usergroups.users.update({
                usergroup: 'S09LUMPUBU0',
                users: newUsersList
            });

            await client.chat.postMessage({
                channel: event.user,
                text: `Hey <@${event.user}>! Welcome to the Zoe's yapping channel :D You've been added to the ping group :3 now you can't leave :neocat_evil:\n\n(Joking, you can leave anytime by just removing yourself from the group in Slack settings)`,
            });

            console.log(`Added user ${event.user} to cultists.`);

        } catch (error) {
            console.error('Error adding user to group:', error);
        }
    }
});

cron.schedule('*/2 * * * *', async () => {
    await syncMemoriesToVector();
});

cron.schedule('* * * * *', async () => {
    await processPendingReminders();
});

async function sendDailyRitualMessage() {
    try {
        const greetings = [
            "Hey bestie, how's the grind going?",
            "What've you cooked today??",
            "Tell me you've been productive 👀",
            "Spill the tea on what you've built :0",
            "What's the vibe on today's work?",
        ];
        
        const closings = [
            "Go share it on a yap pls :3",
            "Drop a yap about it!! :D",
            "Yap about your wins fr fr :3",
            "Let the cultists know what's up :tw_knife:",
            "Time to flex on the channel :neocat_cool:",
        ];
        
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];
        const closing = closings[Math.floor(Math.random() * closings.length)];
        
        const today = new Date().toISOString().split('T')[0];
        let statsText = '';
        
        try {
            const stats = await getCodingStats(today);
            if (stats && stats.projects && stats.projects.length > 0) {
                const topProjects = stats.projects.slice(0, 3).map(p => `${p.name} (${p.hours}h ${p.minutes}m)`).join('\n • ');
                statsText = `\n_Today you've worked on:_\n • ${topProjects}`;
            }
        } catch (e) {
            console.log('Could not fetch coding stats for daily message:', e.message);
        }

        let musicText = '';
        try {
            const tracks = await getLastFmTracksToday();
            if (tracks.length > 0) {
                const counts = new Map();
                for (const t of tracks) {
                    const key = `${t.name} — ${t.artist?.['#text'] || 'Unknown'}`;
                    counts.set(key, (counts.get(key) || 0) + 1);
                }
                const top = [...counts.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([name, n]) => n > 1 ? `${name} (${n} plays)` : name)
                    .join('\n • ');
                musicText = `\n_Today's soundtrack (${tracks.length} plays):_\n • ${top}`;
            }
        } catch (e) {
            console.log('Could not fetch Last.fm tracks for daily message:', e.message);
        }

        await app.client.chat.postMessage({
            channel: CHANNEL_ID,
            text: `<@${USER_ID}> ${greeting}${statsText}${musicText}\n${closing}`
        });
    } catch (error) {
        console.error('Error sending daily ritual message:', error);
    }
}

cron.schedule('0 20 * * *', sendDailyRitualMessage);

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log('Running :3');
    await startWebServer();

    await refreshSettings();
    
    await syncMemoriesToVector();
    await processPendingReminders();
})();

process.on('SIGTERM', async () => {
    await stopWebServer();
    await shutdownPosthog();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await stopWebServer();
    await shutdownPosthog();
    process.exit(0);
});
