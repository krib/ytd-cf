# YouTube Discord Bot - Cloudflare Worker

A Cloudflare Worker that monitors a YouTube channel and posts new videos to Discord.

## Features

- Fetches latest videos from a YouTube channel using RSS feed
- Filters out live streams
- Posts new videos to Discord via webhook
- Tracks seen videos to avoid duplicates
- Runs on a 5-minute cron schedule

## Setup

1. Create a Discord webhook URL:
   - Go to your Discord server settings
   - Navigate to Webhooks > Create Webhook
   - Copy the webhook URL

2. Configure environment variables in Cloudflare Workers:
   - `YOUTUBE_CHANNEL_ID`: Your YouTube channel ID
   - `DISCORD_WEBHOOK_URL`: Your Discord webhook URL

## Deployment

1. Install Wrangler:
```bash
npm install -g wrangler
```

2. Deploy to Cloudflare:
```bash
wrangler deploy
```

## Development

1. Run locally:
```bash
wrangler dev
```

## Environment Variables

- `YOUTUBE_CHANNEL_ID`: YouTube channel ID (required)
- `DISCORD_WEBHOOK_URL`: Discord webhook URL (required)

## How It Works

1. Runs on a 5-minute cron schedule
2. Fetches the latest videos from the specified YouTube channel
3. Filters out live streams (based on title and page content)
4. Compares against previously seen videos to avoid duplicates
5. Posts new videos to Discord using webhooks
6. Stores seen video IDs in memory (in production, use Durable Objects or KV for persistence)

## Persistent Storage Implementation

This worker currently uses in-memory storage for tracking seen videos, which means it will lose track of videos between deployments. For production use, you should implement persistent storage using either Cloudflare Durable Objects or KV Storage. Here's how to implement each option:

### Option 1: Cloudflare Durable Objects

Durable Objects provide a more robust solution for maintaining state across worker invocations.

1. First, define the Durable Object class in your worker code (typically in `index.js`):

```javascript
export class VideoTracker {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/')[2];

    if (action === 'seen') {
      const videoId = url.searchParams.get('videoId');
      if (!videoId) return new Response('Missing videoId', { status: 400 });

      if (request.method === 'POST') {
        await this.storage.put(`seen:${videoId}`, true);
        return new Response('Video marked as seen');
      } else if (request.method === 'GET') {
        const seen = await this.storage.get(`seen:${videoId}`);
        return new Response(seen ? 'true' : 'false');
      }
    }

    return new Response('Invalid action', { status: 400 });
  }
}
```

2. Add the Durable Object to your `wrangler.toml` configuration:

```toml
[[durable_objects.bindings]]
name = "VIDEO_TRACKER"
class_name = "VideoTracker"

[[migrations]]
tag = "v1"
new_classes = ["VideoTracker"]
```

3. Update your worker code to use the Durable Object:

```javascript
// In your main worker function
const tracker = VIDEO_TRACKER.get(VIDEO_TRACKER.idFromName('default'));
const seen = await tracker.fetch(new Request('http://localhost/seen?videoId=' + videoId));
```

### Option 2: Cloudflare KV Storage

KV Storage is simpler to implement and sufficient for this use case.

1. Add a KV namespace to your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SEEN_VIDEOS"  # This will be the variable name in your code
id = "your-kv-namespace-id"
```

2. Update your worker code to use KV storage instead of in-memory storage:

```javascript
// Replace in-memory tracking with KV storage
async function isVideoSeen(videoId) {
  const seen = await SEEN_VIDEOS.get(`seen:${videoId}`);
  return seen !== null;
}

async function markVideoAsSeen(videoId) {
  await SEEN_VIDEOS.put(`seen:${videoId}`, 'true');
}
```

## Note

For production use with persistent storage, consider implementing either:
- Cloudflare Durable Objects (more robust for complex state management)
- Cloudflare KV Storage (simpler and sufficient for this use case)
- Another persistent storage solution