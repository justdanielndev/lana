const declaration = {
    type: "function",
    function: {
        name: "react",
        description: "Add a reaction emoji to a message. Use this to react to the user's message or other messages.",
        parameters: {
            type: "object",
            properties: {
                emoji: { type: "string", description: "The emoji name without colons (e.g., 'thumbsup', 'yay', 'real')" },
                name: { type: "string", description: "Alias for emoji. The emoji name without colons." },
                message_ts: { type: "string", description: "Slack message timestamp to react to. If not provided, reacts to the current/last message." },
                target_message_id: { type: "string", description: "Web conversation message id to react to." }
            }
        }
    }
};

async function run({ toolInput, messageContext, deps }) {
    const rawEmoji = typeof toolInput.emoji === 'string' ? toolInput.emoji : toolInput.name;
    const emoji = typeof rawEmoji === 'string' ? rawEmoji.trim() : '';
    if (!emoji) {
        return { success: false, message: "Missing emoji/name for reaction." };
    }

    if (messageContext?.source === 'web') {
        const targetMessageId = String(
            toolInput.target_message_id ||
            toolInput.message_id ||
            messageContext.currentUserMessageId ||
            ''
        ).trim();
        if (!targetMessageId) {
            return { success: false, message: "No target message id for web reaction." };
        }

        const conversationId = String(messageContext.conversationId || '').trim();
        let reactions = [emoji];
        if (conversationId && typeof deps.addReactionToMessage === 'function') {
            reactions = await deps.addReactionToMessage(conversationId, targetMessageId, emoji);
        }

        return {
            success: true,
            emoji,
            targetMessageId,
            reactions,
            message: `Reacted with :${emoji}: in web conversation.`
        };
    }

    if (!messageContext.channelId) {
        return { success: false, message: "Can't react without a Slack channel context." };
    }

    const targetTs = toolInput.message_ts || messageContext.messageTs;
    if (!targetTs) {
        return { success: false, message: "No message to react to" };
    }

    await deps.app.client.reactions.add({
        channel: messageContext.channelId,
        name: emoji,
        timestamp: targetTs
    });

    if (typeof deps.recordSlackReactionForWebMirror === 'function') {
        try {
            await deps.recordSlackReactionForWebMirror({
                linkedAppwriteUserId: messageContext.linkedAppwriteUserId,
                channelId: messageContext.channelId,
                threadTs: messageContext.threadTs || messageContext.messageTs,
                messageTs: targetTs,
                emoji
            });
        } catch (_) {
        }
    }

    return { success: true, message: `Reacted with :${emoji}:` };
}

module.exports = {
    declaration,
    run
};
