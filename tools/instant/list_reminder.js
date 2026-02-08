const declaration = {
    type: "function",
    function: {
        name: "list_reminder",
        description: "List your reminders.",
        parameters: {
            type: "object",
            properties: {
                include_read: {
                    type: "boolean",
                    description: "Include reminders already marked as read."
                }
            },
            required: []
        }
    }
};

async function run({ toolInput, messageContext, deps }) {
    const userId = messageContext?.userId || deps.USER_ID;
    if (!userId) {
        return { success: false, message: "Couldn't determine which user's reminders to list." };
    }

    const reminders = await deps.listReminders(userId, {
        includeRead: Boolean(toolInput.include_read)
    });

    return {
        success: true,
        count: reminders.length,
        reminders
    };
}

module.exports = {
    declaration,
    run
};
