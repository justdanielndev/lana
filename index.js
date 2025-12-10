const { App } = require('@slack/bolt');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const appwrite = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');
const cron = require('node-cron');

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

const client = new appwrite.Client();
client
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

const storage = new appwrite.Storage(client);

let pendingUploads = {};

app.message(async ({ message, say }) => {

    if (pendingUploads.url && message.channel_type === 'im' && message.user === USER_ID) {
        const fileData = pendingUploads;
        const customId = message.text;
        pendingUploads = {};

        const localFilePath = path.join(__dirname, 'cache', fileData.id + path.extname(fileData.name));
        const writer = fs.createWriteStream(localFilePath);
        
        try {
            const response = await axios({
                url: fileData.url,
                method: 'GET',
                responseType: 'stream',
                headers: {
                    'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
                }
            });
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const inputFile = InputFile.fromPath(localFilePath, fileData.name);
            const appwriteFile = await storage.createFile(APPWRITE_BUCKET_ID, customId, inputFile, [appwrite.Permission.read(appwrite.Role.any())]);
            
            const shareFileUrl = `https://cdn.isitzoe.dev/${appwriteFile.$id}`;
            
            await say(`Hey <@${message.user}>, your file is now on CDN! You can access it here: ${shareFileUrl} :3`);
            
            fs.unlinkSync(localFilePath);

        } catch (error) {
            console.error('Error downloading file:', error);
            await say(`I was trying to get your file on CDN, but something broke :heavysob: maybe the ID is taken? Can you pwease re-upload it? :3`);
            if (fs.existsSync(localFilePath)) {
                fs.unlinkSync(localFilePath);
            }
        }
        return;
    }

    if (message.text && message.text.startsWith("rename file ") && message.channel_type === 'im' && message.user === USER_ID) {
        const parts = message.text.replace("rename file ", "").trim().split(" ");

        const [originalId, newId] = parts;
        
        await say(`Alrighty! :D Renaming ${originalId} to ${newId}...`);

        try {
            const file = await storage.getFile(APPWRITE_BUCKET_ID, originalId);
            const fileBuffer = await storage.getFileDownload(APPWRITE_BUCKET_ID, originalId);
            
            const inputFile = InputFile.fromBuffer(Buffer.from(fileBuffer), file.name);
            await storage.createFile(APPWRITE_BUCKET_ID, newId, inputFile, [appwrite.Permission.read(appwrite.Role.any())]);
            
            await storage.deleteFile(APPWRITE_BUCKET_ID, originalId);
            
            const shareFileUrl = `https://cdn.isitzoe.dev/${newId}`;
            await say(`Done! File renamed to ${newId}. Check it out! ${shareFileUrl} :yay:`);

        } catch (error) {
            console.error('Error renaming file:', error);
            await say(`Oh noe there was an error :(( :heavysob: ${error.message}`);
        }
        return;
    }

    if (message.text && message.text.startsWith("delete file ") && message.channel_type === 'im' && message.user === USER_ID) {
        const fileId = message.text.replace("delete file ", "").trim();
        await say(`Taking care of it, boss.`);
        try {
            await storage.deleteFile(APPWRITE_BUCKET_ID, fileId);
            await say(`📲 ${fileId} has been terminated, boss. My job here is done. :3`);
        } catch (error) {
            console.error('Error deleting file:', error);
            await say(`Failed to delete file ${fileId} :heavysob: ${error.message}`);
        }
        return;
    }

    if (message.text == "cdn") {
        if (message.files && message.files.length > 0) {
            const file = message.files[0];
            if (file.url_private_download) {
                pendingUploads = {
                    url: file.url_private_download,
                    id: file.id,
                    name: file.name
                };
                await say(`Hiiii cutie :DDD What ID should I use for this file?`);
            } else {
                await say(`I was trying to fetch the file for CDN, but it seems broken :heavysob:, can you pwease re-upload it? :3`);
            }
        } else {
            await say(`I saw you said CDN but there was no file :heavysob:. Can you pwease upload the file you want to share? :3`);
        }

    } else if (message.channel_type === 'im' && message.user === USER_ID) {
        await say({
            text: message.text,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "*Do you want to yap this?*\n\n" + message.text
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "Yeah, looks :fire:",
                                emoji: true
                            },
                            value: message.text,
                            action_id: "fire_button_click"
                        }
                    ]
                }
            ]
        });
    }
});

app.action('fire_button_click', async ({ body, ack, client }) => {
    await ack();

    const originalMessage = body.actions[0].value;

    try {
        await client.chat.postMessage({
            channel: CHANNEL_ID,
            text: `<!subteam^S09LUMPUBU0|cultists> *New yap! Go read it :tw_knife:*\n\n${originalMessage}`
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
                            value: originalMessage
                        }
                    ]
                }
            ]
        });

    } catch (error) {
        console.error(error);
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

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log('Running :3');
})();