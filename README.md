# Lana (Zoe's assistant angel)

After the sad demise of Slack workflows on the HC Slack, I moved what used to be a custom workflow here.
It started as a simple bot that would listen to my DMs and forward them to a specific channel, as well as allow me to send things to CDN to get uploaded, but now it's much more.

The latest features have brought her a full AI assistant capabilities w/ Hack Club AI behind, with memory storage in Upstash Vector DB. There's also a separate consciousness simulation layer in n8n (sleep, dreams, world simulation, prompt updating...)

## Features

- AI assistant for myself
- Custom CDN on Appwrite
- Daily summary message with HackaTime coding stats
- Notifications for new channel members
- Ping group for new channel members
- Yap replies and follow-ups
- Web UI with Appwrite auth + conversation threads
- Consciousness simulation (n8n) with sleep/dream cycles, autonomous action loop, emotional state, and self-updating identity prompt

## Setup

1.  **Clone the repository.**
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```
    ```bash
    pnpm web:install
    ```
3.  **Configure Environment Variables:**
    - Rename `.env.example` to `.env`.
    - Fill in all required environment variables in the `.env` file.
    - Copy `web/.env.example` to `web/.env.local` and fill it too.


## Running

```bash
pnpm start
```
(complex asf :D use pnpm pls it's fire)

```bash
pnpm web:dev
```

## Slack Config

1.  Create a new Slack App.
2.  Enable Socket Mode.
3.  Enable Events and subscribe to `message.im`.
4.  Add `chat:write`, `im:history` to Bot Token Scopes.
5.  Enable Interactivity.

## Appwrite Config

1.  Create a new Appwrite project.
2.  Create a new API key with:
    - `files.read`, `files.write`
    - `databases.read`, `databases.write`
3.  Create a Storage Bucket for CDN uploads.
4.  In your configured database, create collections:
    - `memory-items` (or `APPWRITE_MEMORY_COLLECTION_ID`)
    - `settings` (or `APPWRITE_SETTINGS_COLLECTION_ID`)
    - `reminders` (or `APPWRITE_REMINDERS_COLLECTION_ID`)
    - `conversations` (or `APPWRITE_CONVERSATIONS_COLLECTION_ID`)
    - `conversation-messages` (or `APPWRITE_CONVERSATION_MESSAGES_COLLECTION_ID`)
5.  Enable Appwrite Email OTP auth for users.

## Consciousness simulation

To run the consciousness simulation, you need to set up n8n locally and import the workflows located in `conscience-sim/`.