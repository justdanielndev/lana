const declaration = {
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
};

async function run({ toolInput, messageContext }) {
    const limit = toolInput.limit || 5;
    const query = toolInput.query.toLowerCase();

    const results = messageContext.history.filter((msg) =>
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

module.exports = {
    declaration,
    run
};
