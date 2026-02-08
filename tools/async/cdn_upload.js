const declaration = {
    type: "function",
    function: {
        name: "cdn_upload",
        description: "Upload a file to the CDN. The user must have attached a file to their message.",
        parameters: {
            type: "object",
            properties: {
                file_id: { type: "string", description: "The custom ID to use for the file on CDN, ask the user for this" },
                slack_file_url: { type: "string", description: "The Slack file URL to download from" },
                original_name: { type: "string", description: "The original filename" }
            },
            required: ["file_id", "slack_file_url", "original_name"]
        }
    }
};

async function run({ toolInput, deps }) {
    const localFilePath = deps.path.join(
        deps.rootDir,
        'cache',
        toolInput.file_id + deps.path.extname(toolInput.original_name)
    );
    const writer = deps.fs.createWriteStream(localFilePath);

    const response = await deps.axios({
        url: toolInput.slack_file_url,
        method: 'GET',
        responseType: 'stream',
        headers: { 'Authorization': `Bearer ${deps.SLACK_BOT_TOKEN}` }
    });
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    const inputFile = deps.InputFile.fromPath(localFilePath, toolInput.original_name);
    const appwriteFile = await deps.storage.createFile(
        deps.APPWRITE_BUCKET_ID,
        toolInput.file_id,
        inputFile,
        [deps.appwrite.Permission.read(deps.appwrite.Role.any())]
    );

    deps.fs.unlinkSync(localFilePath);

    const shareFileUrl = `https://cdn.isitzoe.dev/${appwriteFile.$id}`;
    return { success: true, message: `File uploaded! URL: ${shareFileUrl}` };
}

module.exports = {
    declaration,
    run
};
