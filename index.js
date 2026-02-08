const { App } = require('@slack/bolt');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const appwrite = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');
const cron = require('node-cron');
const { Index } = require('@upstash/vector');

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

async function getEmbedding(text) {
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
    return response.data.data[0].embedding;
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
    history: []
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
        processPendingReminders
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

async function queueToolExecution(toolName, toolInput, userId, channelId, threadTs = null) {
     return new Promise((resolve) => {
         toolQueue.push({
             toolName,
             toolInput,
             userId,
             channelId,
             threadTs,
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
        const { toolName, toolInput, userId, channelId, resolve } = job;
                
        try {
            const result = await executeToolCall(toolName, toolInput, {
                userId: job.userId,
                channelId: job.channelId,
                threadTs: job.threadTs
            });

            const silentTools = ['add_memory', 'send_message', 'react'];
            if (!silentTools.includes(toolName)) {
                const aiResponse = await processToolResultThroughAI(toolName, result);
                
                await app.client.chat.postMessage({
                    channel: userId,
                    text: aiResponse,
                    thread_ts: job.threadTs
                });
            }
            
            resolve({ status: "completed", result });
        } catch (error) {
             console.error(`Error processing ${toolName}:`, error);
             
             const silentTools = ['add_memory'];
             if (!silentTools.includes(toolName)) {
                 const errorResponse = `Uh oh, something went wrong with ${toolName}: ${error.message} :heavysob:`;
                 await app.client.chat.postMessage({
                    channel: userId,
                    text: errorResponse,
                    thread_ts: job.threadTs
                });
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
    
    const response = await axios.post(HC_CHAT_URL, {
        model: getActiveModel(),
        messages: [
            { role: "system", content: "You're Zoe's AI assistant. Respond briefly to tool results." },
            { role: "user", content: prompt }
        ],
        max_tokens: 256
    }, {
        headers: {
            'Authorization': `Bearer ${HC_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });
    
    return response.data.choices[0].message.content || `Finished ${toolName}!`;
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

async function chat(userMessage, fileInfo = null, channelId = null, userId = null, messageTs = null, threadTs = null) {    
     const memories = await queryMemories(userMessage, 50);
     let memoryContext = "";
     
     const actualMemories = memories.filter(m => m.category !== 'history' && m.score > 0.5).slice(0, 10);

     if (actualMemories.length > 0) {
         memoryContext += "\n\nRelevant memories:\n" + 
             actualMemories.map(m => `- [${m.category}] ${m.content}`).join("\n");
     }
     
     console.log('Memory context:', memoryContext);

    const systemPrompt = getActivePrompt()
        .replace('{{CURRENT_DATETIME}}', getCurrentSpanishDateTimeString())
        .replace('{{MEMORY_CONTEXT}}', memoryContext) +
        `\n\nTime handling rule: unless the user explicitly provides another timezone, interpret times as ${SPANISH_TIME_ZONE}.`;

    let userContent = userMessage;
    if (fileInfo) {
        userContent += `\n\n[User attached a file: "${fileInfo.name}" - URL: ${fileInfo.url}]`;
    }

    const messages = [{ role: "system", content: systemPrompt }];
    
    let slackHistory = [];
    if (channelId && threadTs) {
        slackHistory = await getSlackHistory(channelId, 5, threadTs);
        for (const msg of slackHistory) {
            if (msg.timestamp !== messageTs) {
                messages.push({ role: msg.role, content: msg.content });
            }
        }
    }
    
    messages.push({ role: "user", content: userContent });
    
    currentMessageContext = {
        userId,
        channelId,
        messageTs,
        threadTs,
        history: slackHistory
    };
        
    const activeModel = getActiveModel();
    const activeTools = getActiveTools();
    
    let response;
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
        throw error;
    }

    let assistantMessage = response.data.choices[0].message;
    let usedSendMessage = false;

    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push(assistantMessage);

        for (const toolCall of assistantMessage.tool_calls) {
            try {
                const args = JSON.parse(toolCall.function.arguments);
                let toolResult;
                
                console.log(`Executing tool: ${toolCall.function.name}`, args);
                
                if (toolCall.function.name === 'send_message') {
                    usedSendMessage = true;
                }
                
                const activeInstantTools = getActiveInstantTools();
                const activeAsyncTools = getActiveAsyncTools();
                
                if (activeInstantTools.includes(toolCall.function.name)) {
                     toolResult = await executeImmediateTool(toolCall.function.name, args, currentMessageContext);
                 } else if (activeAsyncTools.includes(toolCall.function.name)) {
                     queueToolExecution(toolCall.function.name, args, userId, channelId, threadTs);
                     toolResult = { queued: true, message: `${toolCall.function.name} queued` };
                 } else {
                     toolResult = { success: false, message: `Unknown or disabled tool: ${toolCall.function.name}` };
                 }

                console.log(`Tool result:`, toolResult);
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult)
                });
            } catch (error) {
                console.error(`Error processing tool:`, error);
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ success: false, message: error.message })
                });
            }
        }

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
            throw error;
        }

        assistantMessage = response.data.choices[0].message;
    }

    if (usedSendMessage) {
        return null;
    }
    
    return assistantMessage.content || "Huh... No response was generated.";
}

app.message(async ({ message, say }) => {
    if (message.channel_type === 'im') {
        if (!message.text && !message.files) {
            return;
        }

        if (message.user !== USER_ID) {
            await say(getRandomRefusal());
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
        let response;
        
        try {
            response = await chat(
                userText, 
                fileInfo, 
                message.channel, 
                message.user,
                message.ts,
                message.thread_ts
            );
            
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
            await storeConversationHistory(userText, response);
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
                            text: 'What do you want Zoe to yap about?'
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
                    text: 'Zoe Bot Settings :3',
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
        
        await app.client.chat.postMessage({
            channel: CHANNEL_ID,
            text: `<@${USER_ID}> ${greeting}${statsText}\n${closing}`
        });
    } catch (error) {
        console.error('Error sending daily ritual message:', error);
    }
}

cron.schedule('0 20 * * *', sendDailyRitualMessage);

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log('Running :3');

    await refreshSettings();

    if (START_NOTIFS_CHANNEL_ID) {
        try {
            await app.client.chat.postMessage({
                channel: START_NOTIFS_CHANNEL_ID,
                text: 'Bot is up :3'
            });
        } catch (error) {
            console.error('Failed to send startup notification message:', error);
        }
    }
    
    await syncMemoriesToVector();
    await processPendingReminders();
})();
