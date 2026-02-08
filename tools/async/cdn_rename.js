const declaration = {
    type: "function",
    function: {
        name: "cdn_rename",
        description: "Rename a file on the CDN",
        parameters: {
            type: "object",
            properties: {
                original_id: { type: "string", description: "The current file ID on CDN" },
                new_id: { type: "string", description: "The new file ID" }
            },
            required: ["original_id", "new_id"]
        }
    }
};

async function run({ toolInput, deps }) {
    const file = await deps.storage.getFile(deps.APPWRITE_BUCKET_ID, toolInput.original_id);
    const fileBuffer = await deps.storage.getFileDownload(deps.APPWRITE_BUCKET_ID, toolInput.original_id);

    const inputFile = deps.InputFile.fromBuffer(Buffer.from(fileBuffer), file.name);
    await deps.storage.createFile(
        deps.APPWRITE_BUCKET_ID,
        toolInput.new_id,
        inputFile,
        [deps.appwrite.Permission.read(deps.appwrite.Role.any())]
    );

    await deps.storage.deleteFile(deps.APPWRITE_BUCKET_ID, toolInput.original_id);

    const shareFileUrl = `https://cdn.isitzoe.dev/${toolInput.new_id}`;
    return { success: true, message: `File renamed! New URL: ${shareFileUrl}` };
}

module.exports = {
    declaration,
    run
};
