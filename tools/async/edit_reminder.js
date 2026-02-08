const { parseReminderDateTimeInput, SPAIN_TIME_ZONE } = require('../../utils/reminder_time');

const declaration = {
    type: "function",
    function: {
        name: "edit_reminder",
        description: `Edit an existing reminder. Can update date/time, content, and read state. If timezone is omitted, notify_datetime is interpreted as ${SPAIN_TIME_ZONE}.`,
        parameters: {
            type: "object",
            properties: {
                reminder_id: {
                    type: "string",
                    description: "The reminder ID."
                },
                notify_datetime: {
                    type: "string",
                    description: "New notification date/time."
                },
                content: {
                    type: "string",
                    description: "New reminder content."
                },
                mark_as_read: {
                    type: "boolean",
                    description: "Mark this reminder as read (true) or unread (false)."
                },
                reset_repeats: {
                    type: "boolean",
                    description: "Reset reminder repeat counter."
                }
            },
            required: ["reminder_id"]
        }
    }
}

async function run({ toolInput, messageContext, deps }) {
    const userId = messageContext?.userId || deps.USER_ID;
    if (!userId) {
        return { success: false, message: "Couldn't determine the reminder owner." };
    }

    let parsedNotifyDateTime = null;
    if (toolInput.notify_datetime !== undefined && toolInput.notify_datetime !== null) {
        parsedNotifyDateTime = parseReminderDateTimeInput(toolInput.notify_datetime);
    }
    if (toolInput.notify_datetime !== undefined && toolInput.notify_datetime !== null && !parsedNotifyDateTime) {
        return {
            success: false,
            message: `Invalid notify_datetime. Use YYYY-MM-DDTHH:mm(:ss), optionally with timezone. No timezone means ${SPAIN_TIME_ZONE}.`
        };
    }

    const updates = {};
    if (typeof toolInput.content === 'string') {
        updates.content = toolInput.content;
    }
    if (parsedNotifyDateTime) {
        updates.notifyDateTime = parsedNotifyDateTime;
    }
    if (typeof toolInput.mark_as_read === 'boolean') {
        updates.markAsRead = toolInput.mark_as_read;
    }
    if (typeof toolInput.reset_repeats === 'boolean') {
        updates.resetRepeats = toolInput.reset_repeats;
    }

    if (Object.keys(updates).length === 0) {
        return { success: false, message: "No updates provided." };
    }

    const result = await deps.editReminder(toolInput.reminder_id, userId, updates);
    if (!result.success) {
        return result;
    }

    await deps.processPendingReminders();
    return {
        success: true,
        reminder: result.reminder,
        message: `Updated reminder ${toolInput.reminder_id}.`
    };
}

module.exports = {
    declaration,
    run
};
