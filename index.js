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

let pendingUploads = {};
let lastSyncTime = null;

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
    }
];

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
            console.log('No unsynced memories found');
        } else {
            console.log(`Found ${unsyncedDocs.documents.length} unsynced memories`);

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
        console.log(`Sync completed at ${lastSyncTime.toISOString()}`);
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
            console.log(`[Deleted: ${toDelete.join(', ')}`);
        } else {
            console.log(' No orphaned vectors found');
        }
    } catch (error) {
        console.error('[Sync] Error checking deletions:', error);
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
        
        console.log(`Found ${memories.length} relevant memories`);
        memories.forEach((m, i) => console.log(`  ${i+1}. [${m.category}] score=${m.score.toFixed(3)} "${m.content?.substring(0, 40)}..."`));
        
        return memories;
    } catch (error) {
        console.error('[Query] Error:', error);
        return [];
    }
}

async function executeToolCall(toolName, toolInput) {
    console.log(`Executing tool: ${toolName}`);
    console.log(`Tool input:`, JSON.stringify(toolInput, null, 2));
    
    switch (toolName) {
        case 'add_memory': {
            const docId = await addMemoryToAppwrite(toolInput.content, toolInput.category);
            console.log(`add_memory completed: ${docId}`);
            return { success: true, message: `Memory saved with ID ${docId}. Will be synced to vector DB shortly.` };
        }
        
        case 'yap': {
            console.log(`Posting yap to channel ${CHANNEL_ID}`);
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
            console.log('Yap posted successfully');
            return { success: true, message: "Yap posted successfully!" };
        }
        
        case 'cdn_upload': {
            console.log(`CDN upload: ${toolInput.file_id}`);
            const localFilePath = path.join(__dirname, 'cache', toolInput.file_id + path.extname(toolInput.original_name));
            const writer = fs.createWriteStream(localFilePath);
            
            console.log(`Downloading from Slack...`);
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

            console.log(`Uploading to Appwrite...`);
            const inputFile = InputFile.fromPath(localFilePath, toolInput.original_name);
            const appwriteFile = await storage.createFile(
                APPWRITE_BUCKET_ID, 
                toolInput.file_id, 
                inputFile, 
                [appwrite.Permission.read(appwrite.Role.any())]
            );
            
            fs.unlinkSync(localFilePath);
            
            const shareFileUrl = `https://cdn.isitzoe.dev/${appwriteFile.$id}`;
            console.log(`CDN upload complete: ${shareFileUrl}`);
            return { success: true, message: `File uploaded! URL: ${shareFileUrl}` };
        }
        
        case 'cdn_rename': {
            console.log(`CDN rename: ${toolInput.original_id} -> ${toolInput.new_id}`);
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
            console.log(`CDN rename complete: ${shareFileUrl}`);
            return { success: true, message: `File renamed! New URL: ${shareFileUrl}` };
        }
        
        case 'cdn_delete': {
            console.log(`CDN delete: ${toolInput.file_id}`);
            await storage.deleteFile(APPWRITE_BUCKET_ID, toolInput.file_id);
            console.log(`CDN delete complete`);
            return { success: true, message: `File ${toolInput.file_id} deleted.` };
        }
        
        default:
            console.log(`Unknown tool: ${toolName}`);
            return { success: false, message: `Unknown tool: ${toolName}` };
    }
}

async function getSlackHistory(channelId, limit = 20) {
    console.log(`Fetching last ${limit} messages from Slack channel ${channelId}`);
    try {
        const result = await app.client.conversations.history({
            channel: channelId,
            limit: limit
        });
        
        const messages = result.messages
            .reverse()
            .map(msg => ({
                role: msg.bot_id ? "assistant" : "user",
                content: msg.text || "",
                timestamp: msg.ts
            }))
            .filter(msg => msg.content);
        
        console.log(`Retrieved ${messages.length} messages`);
        return messages;
    } catch (error) {
        console.error('Error fetching Slack history:', error);
        return [];
    }
}

async function storeConversationHistory(userMessage, assistantResponse) {
    const timestamp = new Date().toISOString();
    const historyEntry = `[${timestamp}] User: ${userMessage}\n[${timestamp}] Assistant: ${assistantResponse}`;
    
    await addMemoryToAppwrite(historyEntry, 'history');
}

async function chat(userMessage, fileInfo = null, channelId = null) {
    console.log(`Chat file attached: ${fileInfo ? fileInfo.name : 'none'}`);
    
    const memories = await queryMemories(userMessage, 5);
    const historicalContext = await queryMemories(userMessage, 10);
    
    let memoryContext = "";
    const nonHistoryMemories = memories.filter(m => m.category !== 'history');
    if (nonHistoryMemories.length > 0) {
        memoryContext = "\n\nRelevant memories:\n" + 
            nonHistoryMemories.map(m => `- [${m.category}] ${m.content}`).join("\n");
    }
    
    let olderHistoryContext = "";
    const historyMemories = historicalContext.filter(m => m.category === 'history');
    if (historyMemories.length > 0) {
        olderHistoryContext = "\n\nRelevant older conversations:\n" + 
            historyMemories.map(m => m.content).join("\n\n");
    }

    const systemPrompt = `You are Zoe's personal AI assistant bot on Slack. You're friendly, helpful, and have a cute personality (use :3 and similar emoticons sometimes).

You have access to long-term memory - information Zoe has shared with you in past conversations. Use this context to provide personalized responses.

You can:
1. Remember things for Zoe (use add_memory tool for important info)
2. Post yaps (messages) to Zoe's channel for her followers
3. Manage CDN files (upload, rename, delete)

When Zoe shares something important about herself, her preferences, projects, or anything you should remember, use the add_memory tool to save it.

When Zoe wants to yap/share something with her followers, use the yap tool.
${memoryContext}${olderHistoryContext}`;

    let userContent = userMessage;
    if (fileInfo) {
        userContent += `\n\n[User attached a file: "${fileInfo.name}" - URL: ${fileInfo.url}]`;
    }

    const messages = [{ role: "system", content: systemPrompt }];
    
    if (channelId) {
        const recentHistory = await getSlackHistory(channelId, 20);
        for (const msg of recentHistory.slice(0, -1)) {
            messages.push({ role: msg.role, content: msg.content });
        }
    }
    
    messages.push({ role: "user", content: userContent });
    
    let response = await axios.post(HC_CHAT_URL, {
        model: "google/gemini-2.5-flash-preview",
        messages: messages,
        tools: AI_TOOLS,
        max_tokens: 1024
    }, {
        headers: {
            'Authorization': `Bearer ${HC_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    let assistantMessage = response.data.choices[0].message;

    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        console.log(`Processing ${assistantMessage.tool_calls.length} tool call(s)`);
        messages.push(assistantMessage);

        for (const toolCall of assistantMessage.tool_calls) {
            let toolResult;
            try {
                const args = JSON.parse(toolCall.function.arguments);
                toolResult = await executeToolCall(toolCall.function.name, args);
            } catch (error) {
                toolResult = { success: false, message: `Error: ${error.message}` };
            }

            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify(toolResult)
            });
        }

        response = await axios.post(HC_CHAT_URL, {
            model: "google/gemini-2.5-flash-preview",
            messages: messages,
            tools: AI_TOOLS,
            max_tokens: 1024
        }, {
            headers: {
                'Authorization': `Bearer ${HC_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        assistantMessage = response.data.choices[0].message;
    }

    return assistantMessage.content || "I processed your request! :3";
}

app.message(async ({ message, say }) => {
    if (message.channel_type === 'im' && message.user === USER_ID) {
        if (!message.text && !message.files) {
            return;
        }

        let fileInfo = null;
        if (message.files && message.files.length > 0) {
            const file = message.files[0];
            console.log(`[Slack] File attached: ${file.name}`);
            fileInfo = {
                name: file.name,
                url: file.url_private_download,
                id: file.id
            };
        }

        const userText = message.text || "";
        let response;
        
        try {
            response = await chat(userText, fileInfo, message.channel);
            await say(response);
        } catch (error) {
            console.error('AI Error:', error);
            response = `[ERROR] ${error.message}`;
            await say(`Something went wrong :heavysob: ${error.message}`);
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

            console.log(`Added user ${event.user} to cultists group.`);

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
