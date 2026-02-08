const declaration = {
    type: "function",
    function: {
        name: "cdn_delete",
        description: "Delete a file from the CDN",
        parameters: {
            type: "object",
            properties: {
                file_id: { type: "string", description: "The file ID to delete" }
            },
            required: ["file_id"]
        }
    }
};

async function run({ toolInput, deps }) {
    await deps.storage.deleteFile(deps.APPWRITE_BUCKET_ID, toolInput.file_id);
    return { success: true, message: `File ${toolInput.file_id} deleted.` };
}

module.exports = {
    declaration,
    run
};
