const declaration = {
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
};

async function run({ toolInput, deps }) {
    const docId = await deps.addMemoryToAppwrite(toolInput.content, toolInput.category);

    if (toolInput.category !== 'history') {
        await deps.syncMemoriesToVector();
    }

    return { success: true, message: `Memory saved with ID ${docId}.` };
}

module.exports = {
    declaration,
    run
};
