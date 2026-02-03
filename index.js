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
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_MEMORY_COLLECTION_ID = process.env.APPWRITE_MEMORY_COLLECTION_ID || 'memory-items';

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
const HACKATIME_API_KEY = process.env.HACKATIME_API_KEY;
const HACKATIME_BASE_URL = 'https://hackatime.hackclub.com/api/v1';

let pendingUploads = {};
let lastSyncTime = null;
let toolQueue = [];
let isProcessingQueue = false;

const REFUSAL_MESSAGES = [
    "Can't talk here, nice try tho :loll: If you want to reply to a yap, pls do that in the channel.",
    "Can't talk to you :sadge: If you want to reply to a yap, pls do that in the channel.",
    "You're not allowed to talk to me here :shrug: If you want to reply to a yap, pls do that in the channel.",
    "Sorry bestie, this chat's for Zoe only :3 If you want to reply to a yap, pls do that in the channel.",
];

function getRandomRefusal() {
    return REFUSAL_MESSAGES[Math.floor(Math.random() * REFUSAL_MESSAGES.length)];
}

const AI_TOOLS = [
    {
        type: "function",
        function: {
            name: "add_memory",
            description: "Store a piece of information in long-term memory. Use this when the user tells you something about themselves, their preferences, projects, or anything you should remember for future conversations.",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "The information to remember" },
                    category: { type: "string", description: "Category of the memory, can be anything (e.g., 'preference', 'project', 'fact', 'reminder')" }
                },
                required: ["content", "category"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_message",
            description: "Send a message to the DM channel or to a specific location. By default sends to thread (if in a thread) or as direct message. Use send_to_channel=true to send to the main channel instead.",
            parameters: {
                type: "object",
                properties: {
                    message: { type: "string", description: "The message to send" },
                    send_to_channel: { type: "boolean", description: "If true, send to main channel. Otherwise sends to DM/thread" }
                },
                required: ["message"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "react",
            description: "Add a reaction emoji to a message. Use this to react to the user's message or other messages.",
            parameters: {
                type: "object",
                properties: {
                    emoji: { type: "string", description: "The emoji name without colons (e.g., 'thumbsup', 'yay', 'real')" },
                    message_ts: { type: "string", description: "The message timestamp to react to. If not provided, reacts to the current/last message" }
                },
                required: ["emoji"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_messages",
            description: "Search for messages in the chat history. Returns relevant messages matching the query.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to search for in messages" },
                    limit: { type: "number", description: "Maximum number of results (default 5)" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "yap",
            description: "Post a yap (message) to Zoe's yapping channel. Use this when the user wants to share something with their cultists (channel members :3)",
            parameters: {
                type: "object",
                properties: {
                    message: { type: "string", description: "The message to yap" }
                },
                required: ["message"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "cdn_upload",
            description: "Upload a file to the CDN. The user must have attached a file to their message.",
            parameters: {
                type: "object",
                properties: {
                    file_id: { type: "string", description: "The custom ID to use for the file on CDN, ask the user for this" },
                    slack_file_url: { type: "string", description: "The Slack file URL to download from" },
                    original_name: { type: "string", description: "The original filename" }
                },
                required: ["file_id", "slack_file_url", "original_name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "cdn_rename",
            description: "Rename a file on the CDN",
            parameters: {
                type: "object",
                properties: {
                    original_id: { type: "string", description: "The current file ID on CDN" },
                    new_id: { type: "string", description: "The new file ID" }
                },
                required: ["original_id", "new_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "cdn_delete",
            description: "Delete a file from the CDN",
            parameters: {
                type: "object",
                properties: {
                    file_id: { type: "string", description: "The file ID to delete" }
                },
                required: ["file_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_coding_stats",
            description: "Get your daily coding time stats from HackaTime for a specific date range. Returns project breakdown and daily average.",
            parameters: {
                type: "object",
                properties: {
                    start_date: { type: "string", description: "Start date in YYYY-MM-DD format (optional)" },
                    end_date: { type: "string", description: "End date in YYYY-MM-DD format (optional)" }
                },
                required: []
            }
        }
    }
];

async function getCodingStats(startDate = null, endDate = null) {
    try {
        let url = `${HACKATIME_BASE_URL}/users/my/stats?features=projects`;
        
        if (startDate) url += `&start_date=${startDate}`;
        if (endDate) url += `&end_date=${endDate}`;
        
        console.log(`HackaTime URL: ${url}`);
        
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

async function executeImmediateTool(toolName, toolInput, context) {
    try {
        switch (toolName) {
            case 'send_message': {
                try {
                    const threadTs = context.threadTs || context.messageTs;
                    const broadcast = toolInput.send_to_channel || false;
                    let postConfig = {
                        channel: context.userId,
                        text: toolInput.message,
                        thread_ts: threadTs
                    };
                    
                    if (broadcast) {
                        postConfig.reply_broadcast = true;
                    }
                    
                    const result = await app.client.chat.postMessage(postConfig);
                    return { success: true, message: "Message sent successfully!" };
                } catch (error) {
                    console.error('Failed to send message:', error);
                    return { success: false, message: `Failed to send message: ${error.message}` };
                }
            }
            
            case 'react': {
                const targetTs = toolInput.message_ts || context.messageTs;
                if (!targetTs) return { success: false, message: "No message to react to" };
                
                try {
                    await app.client.reactions.add({
                        channel: context.channelId,
                        name: toolInput.emoji,
                        timestamp: targetTs
                    });
                    return { success: true, message: `Reacted with :${toolInput.emoji}:` };
                } catch (error) {
                    console.error('Failed to add reaction:', error);
                    return { success: false, message: `Failed to react: ${error.message}` };
                }
            }
            
            case 'search_messages': {
                const limit = toolInput.limit || 5;
                const query = toolInput.query.toLowerCase();
                
                const results = context.history.filter(msg => 
                    msg.content.toLowerCase().includes(query)
                ).slice(0, limit);
                
                if (results.length === 0) {
                    return { success: true, message: `No messages found matching "${toolInput.query}"` };
                }
                
                const formatted = results.map((msg, i) => 
                    `${i + 1}. [${msg.role}]: ${msg.content.substring(0, 100)}...`
                ).join('\n');
                
                return { success: true, results: formatted };
            }
            
            case 'get_coding_stats': {
                const stats = await getCodingStats(toolInput.start_date, toolInput.end_date);
                
                const topProjects = stats.projects ? stats.projects.slice(0, 5).map(p => 
                    `• ${p.name}: ${p.text} (${p.percent.toFixed(1)}%)`
                ).join('\n') : 'No project data available';
                
                const message = `Coding Stats\n\n` +
                    `Total: ${stats.human_readable_total}\n` +
                    `Daily Avg: ${stats.human_readable_daily_average}\n\n` +
                    `Top Projects:\n${topProjects}`;
                
                return { success: true, message };
            }
            
            default:
                return { success: false, message: `Unknown immediate tool: ${toolName}` };
        }
    } catch (error) {
        return { success: false, message: `Error: ${error.message}` };
    }
}

async function executeToolCall(toolName, toolInput) {

    switch (toolName) {
        case 'add_memory': {
            const docId = await addMemoryToAppwrite(toolInput.content, toolInput.category);
            if (toolInput.category !== 'history') {
                await syncMemoriesToVector();
            }
            return { success: true, message: `Memory saved with ID ${docId}.` };
        }
        
        case 'yap': {
            await app.client.chat.postMessage({
                channel: CHANNEL_ID,
                text: `<!subteam^S09LUMPUBU0|cultists> *New yap! Go read it :tw_knife:*\n\n${toolInput.message}`
            });
            
            await app.client.chat.postMessage({
                channel: CHANNEL_ID,
                text: "Pls thread here! :thread: :D",
                blocks: [
                    {
                        type: "section",
                        text: { type: "mrkdwn", text: "Pls thread here! :thread: :D" }
                    },
                    {
                        type: "actions",
                        elements: [{
                            type: "button",
                            text: { type: "plain_text", text: "Suggest a new yap", emoji: false },
                            action_id: "reply_button_click",
                            value: toolInput.message
                        }]
                    }
                ]
            });
            return { success: true, message: "Yap posted successfully!" };
        }
        
        case 'cdn_upload': {
            const localFilePath = path.join(__dirname, 'cache', toolInput.file_id + path.extname(toolInput.original_name));
            const writer = fs.createWriteStream(localFilePath);
            
            const response = await axios({
                url: toolInput.slack_file_url,
                method: 'GET',
                responseType: 'stream',
                headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
            });
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const inputFile = InputFile.fromPath(localFilePath, toolInput.original_name);
            const appwriteFile = await storage.createFile(
                APPWRITE_BUCKET_ID, 
                toolInput.file_id, 
                inputFile, 
                [appwrite.Permission.read(appwrite.Role.any())]
            );
            
            fs.unlinkSync(localFilePath);
            
            const shareFileUrl = `https://cdn.isitzoe.dev/${appwriteFile.$id}`;
            return { success: true, message: `File uploaded! URL: ${shareFileUrl}` };
        }
        
        case 'cdn_rename': {
            const file = await storage.getFile(APPWRITE_BUCKET_ID, toolInput.original_id);
            const fileBuffer = await storage.getFileDownload(APPWRITE_BUCKET_ID, toolInput.original_id);
            
            const inputFile = InputFile.fromBuffer(Buffer.from(fileBuffer), file.name);
            await storage.createFile(
                APPWRITE_BUCKET_ID, 
                toolInput.new_id, 
                inputFile, 
                [appwrite.Permission.read(appwrite.Role.any())]
            );
            
            await storage.deleteFile(APPWRITE_BUCKET_ID, toolInput.original_id);
            
            const shareFileUrl = `https://cdn.isitzoe.dev/${toolInput.new_id}`;
            return { success: true, message: `File renamed! New URL: ${shareFileUrl}` };
        }
        
        case 'cdn_delete': {
            await storage.deleteFile(APPWRITE_BUCKET_ID, toolInput.file_id);
            return { success: true, message: `File ${toolInput.file_id} deleted.` };
        }
        
        default:
            console.log(`Unknown tool: ${toolName}`);
            return { success: false, message: `Unknown tool: ${toolName}` };
    }
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
            const result = await executeToolCall(toolName, toolInput);

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
        model: "google/gemini-3-flash-preview",
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
     console.log('Retrieved memories:', memories);
     let memoryContext = "";
     
     const actualMemories = memories.filter(m => m.category !== 'history' && m.score > 0.5).slice(0, 10);

     if (actualMemories.length > 0) {
         memoryContext += "\n\nRelevant memories:\n" + 
             actualMemories.map(m => `- [${m.category}] ${m.content}`).join("\n");
     }
     
     console.log('Memory context:', memoryContext);

     const systemPrompt = `You are Zoe's personal AI assistant bot on Slack. You're friendly, helpful, and have a cute personality (use :3 and similar emoticons sometimes).

IMPORTANT: To reply to Zoe, you MUST use the send_message tool. Any text you output outside of send_message will be ignored. Always use send_message for your responses.

You have access to long-term memory - information Zoe has shared with you in past conversations. Use this context to provide personalized responses.

You can:
1. Remember things for Zoe (use add_memory tool for important info)
2. Send messages (send_message tool - THIS IS HOW YOU REPLY, goes to thread, use send_to_channel=true to broadcast to main chat view too)
3. React to messages (react tool)
4. Search message history (search_messages tool)
5. Post yaps (messages) to Zoe's yapping channel (Zoe needs to provide the exact message to yap, or you can send her the exact text you're planning to yap, for her to approve first)
6. Manage CDN files (upload, rename, delete)
7. Get daily coding stats from HackaTime (get_coding_stats tool - shows projects breakdown, total time, and daily average)

About tools:
- send_message, react, search_messages, get_coding_stats: Execute immediately
- add_memory, yap, cdn_*: These are queued async operations - tell the user you're queuing them EXCEPT for add_memory which is silent and happens in the background when you find it useful to remember smth. You should NOT tell the user about add_memory usage unless they specifically ask you about it.

When Zoe shares something important about herself, use add_memory to save it.

Do NOT randomly react. At most run one react tool call per conversation, and only if it's really needed.

You can send multiple messages in one response - just call send_message multiple times with different content.

You're in the Hack Club Slack workspace, and as such you can use workspace emojis. There are thousands, though, so you can't know them all. Here are some (which you can use instead of standard emojis):
- :real: (text showing "real")
- :heavysob: (crying face)
- :yesyes: (animated cat nodding)
- :no-no: (animated cat shaking head)
- :yay: (animated fox excited)
- :skulk: (squished skull)
- :upvote:
- :downvote:
- :this: (text showing "this" with an arrow pointing up)
- :eyes_shaking: (animated eyes shaking)
- :loll: (animated minion laughing)
- :same: (text showing "same")
- :60fps-parrot: (animated dancing parrot)
- :leeks: (leeks the vegetable as a reference to leaks)

Use slack formatting where appropriate (e.g., *bold*, _italic_, ~strikethrough~, \`code\`, \`\`\`code blocks\`\`\`, <links|with text>, etc).

Don't abuse emojis, but feel free to use them to express emotion and make your messages more fun. If something fails with reacting, no need to notify the user.

The current date and time is ${new Date().toLocaleString()}.${memoryContext}`;

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
        
    let response;
    try {
        response = await axios.post(HC_CHAT_URL, {
            model: "google/gemini-3-flash-preview",
            messages: messages,
            tools: AI_TOOLS,
            max_tokens: 2048
        }, {
            headers: {
                'Authorization': `Bearer ${HC_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        console.error('Request size:', JSON.stringify({model: "google/gemini-3-flash-preview", messages: messages, tools: AI_TOOLS, max_tokens: 2048}).length, 'bytes');
        throw error;
    }

    let assistantMessage = response.data.choices[0].message;
    let usedSendMessage = false;

    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push(assistantMessage);
        
        const immediateTools = ['send_message', 'react', 'search_messages', 'get_coding_stats'];
        const queuedTools = ['add_memory', 'yap', 'cdn_upload', 'cdn_rename', 'cdn_delete'];

        for (const toolCall of assistantMessage.tool_calls) {
            try {
                const args = JSON.parse(toolCall.function.arguments);
                let toolResult;
                
                console.log(`Executing tool: ${toolCall.function.name}`, args);
                
                if (toolCall.function.name === 'send_message') {
                    usedSendMessage = true;
                }
                
                if (immediateTools.includes(toolCall.function.name)) {
                     toolResult = await executeImmediateTool(toolCall.function.name, args, currentMessageContext);
                 } else if (queuedTools.includes(toolCall.function.name)) {
                     queueToolExecution(toolCall.function.name, args, userId, channelId, threadTs);
                     toolResult = { queued: true, message: `${toolCall.function.name} queued` };
                 } else {
                     toolResult = { success: false, message: `Unknown tool: ${toolCall.function.name}` };
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
                model: "google/gemini-3-flash-preview",
                messages: messages,
                tools: AI_TOOLS,
                max_tokens: 2048
            }, {
                headers: {
                    'Authorization': `Bearer ${HC_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
        } catch (error) {
            console.error('AI API Error:', error.response?.data || error.message);
            console.error('Request size:', JSON.stringify({model: "google/gemini-3-flash-preview", messages: messages, tools: AI_TOOLS, max_tokens: 2048}).length, 'bytes');
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

cron.schedule('0 20 * * *', async () => {
    try {
        await app.client.chat.postMessage({
            channel: CHANNEL_ID,
            text: `<@${USER_ID}> how was your day??? Go share on a yap pls :3`
        });
    } catch (error) {
        console.error('Error sending daily ritual message:', error);
    }
});

cron.schedule('*/2 * * * *', async () => {
    await syncMemoriesToVector();
});

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log('Running :3');
    
    await syncMemoriesToVector();
})();
