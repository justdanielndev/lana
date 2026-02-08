const declaration = {
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
};

async function run({ toolInput, messageContext, deps }) {
    const targetTs = toolInput.message_ts || messageContext.messageTs;
    if (!targetTs) {
        return { success: false, message: "No message to react to" };
    }

    await deps.app.client.reactions.add({
        channel: messageContext.channelId,
        name: toolInput.emoji,
        timestamp: targetTs
    });

    return { success: true, message: `Reacted with :${toolInput.emoji}:` };
}

module.exports = {
    declaration,
    run
};
