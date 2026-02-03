# Zoe's assistant angel

After the sad demise of Slack workflows on the HC Slack, I moved what used to be a custom workflow here. 
It started as a simple bot that would listen to my DMs and forward them to a specific channel, as well as allow me to send things to CDN to get uploaded, but now it's much more.

The latest features have brought her a full AI assistant capabilities w/ Hack Club AI behind, with memory storage in Upstash Vector DB.

## Features

- AI assistant for myself
- Custom CDN on Appwrite
- Daily summary message with HackaTime coding stats
- Notifications for new channel members
- Ping group for new channel members
- Yap replies and follow-ups

## Setup

1.  **Clone the repository.**
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```
3.  **Configure Environment Variables:**
    - Rename `.env.example` to `.env`.
    - Fill in all required environment variables in the `.env` file.


## Running

```bash
pnpm start
```
(complex asf :D use pnpm pls it's fire)

## Slack Config

1.  Create a new Slack App.
2.  Enable Socket Mode.
3.  Enable Events and subscribe to `message.im`.
4.  Add `chat:write`, `im:history` to Bot Token Scopes.
5.  Enable Interactivity.

## Appwrite Config

1.  Create a new Appwrite project.
2.  Create a new API key with `files.write` and `files.read` permissions
3.  Create a new Storage Bucket for file uploads.