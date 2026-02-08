const declaration = {
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
};

async function run({ toolInput, deps }) {
    await deps.app.client.chat.postMessage({
        channel: deps.CHANNEL_ID,
        text: `<!subteam^S09LUMPUBU0|cultists> *New yap! Go read it :tw_knife:*\n\n${toolInput.message}`
    });

    await deps.app.client.chat.postMessage({
        channel: deps.CHANNEL_ID,
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

module.exports = {
    declaration,
    run
};
