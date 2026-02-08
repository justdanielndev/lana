const declaration = {
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
};

async function run({ toolInput, messageContext, deps }) {
    const threadTs = messageContext.threadTs || messageContext.messageTs;
    const broadcast = toolInput.send_to_channel || false;
    const postConfig = {
        channel: messageContext.userId,
        text: toolInput.message,
        thread_ts: threadTs
    };

    if (broadcast) {
        postConfig.reply_broadcast = true;
    }

    await deps.app.client.chat.postMessage(postConfig);
    return { success: true, message: "Message sent successfully!" };
}

module.exports = {
    declaration,
    run
};
