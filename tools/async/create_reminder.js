const { parseReminderDateTimeInput, SPAIN_TIME_ZONE } = require('../../utils/reminder_time');

const declaration = {
    type: "function",
    function: {
        name: "create_reminder",
        description: `Create a reminder for a specific date and time. If no timezone is included, the input is interpreted as ${SPAIN_TIME_ZONE}.`,
        parameters: {
            type: "object",
            properties: {
                notify_datetime: {
                    type: "string",
                    description: "When to notify. Prefer ISO format, for example 2026-02-08T18:30:00-05:00."
                },
                content: {
                    type: "string",
                    description: "Reminder text content."
                }
            },
            required: ["notify_datetime", "content"]
        }
    }
}

async function run({ toolInput, messageContext, deps }) {
    const userId = messageContext?.userId || deps.USER_ID;
    const channelId = messageContext?.channelId || userId;
    const threadTs = messageContext?.threadTs || null;

    if (!userId) {
        return { success: false, message: "Couldn't determine the reminder owner." };
    }

    const notifyDateTime = parseReminderDateTimeInput(toolInput.notify_datetime);
    if (!notifyDateTime) {
        return {
            success: false,
            message: `Invalid notify_datetime. Use YYYY-MM-DDTHH:mm(:ss), optionally with timezone. No timezone means ${SPAIN_TIME_ZONE}.`
        };
    }

    const content = (toolInput.content || "").trim();
    if (!content) {
        return { success: false, message: "Reminder content cannot be empty." };
    }

    const reminder = await deps.createReminder({
        userId,
        channelId,
        threadTs,
        content,
        notifyDateTime
    });

    await deps.processPendingReminders();

    return {
        success: true,
        reminder,
        message: `Created reminder ${reminder.id} for ${reminder.notifyDateTime}.`
    };
}

module.exports = {
    declaration,
    run
};
