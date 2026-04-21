import { Account, Client, ID } from 'appwrite';

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || '';
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || '';

export const hasAppwriteConfig = Boolean(endpoint && projectId);

let appwriteAccount = null;

if (hasAppwriteConfig) {
  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId);

  appwriteAccount = new Account(client);
}

export { appwriteAccount, ID };
