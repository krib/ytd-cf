// Import fast-xml-parser for XML parsing in Node.js environment
import { XMLParser } from 'fast-xml-parser';

// Configuration - using environment variables from Cloudflare
// We'll get these from the env parameter in functions, but define defaults here for clarity
const DEFAULT_YOUTUBE_CHANNEL_ID = '';
const DEFAULT_DISCORD_WEBHOOK_URL = '';

// YouTube RSS URL
const RSS_URL = "https://www.youtube.com/feeds/videos.xml";

// Regular expression for live stream titles
const LIVE_TITLE = /^[🔴🟡🟢🔵🟣⏺▪️]\s*(LIVE|PREMIERE|STREAM|首播|生放送)/i;

// Helper function to check if a video is live
async function isLiveBroadcast(videoId) {
  console.debug(`Checking if video ${videoId} is live...`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout
    
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.warn(`Failed to fetch video ${videoId} - status: ${response.status}`);
      return false;
    }
    
    const text = await response.text();
    const isLive = text.includes('"isLiveBroadcast":true') || text.includes('"isLiveContent":true');
    console.log(`Video ${videoId} live check result: ${isLive}`);
    return isLive;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(`Timeout while checking video ${videoId}`);
    } else {
      console.warn(`Failed to check video ${videoId}, assuming not live`, error);
    }
    return false;
  }
}

// Data class for VideoItem
class VideoItem {
  constructor(id, title, url, publishedAt, thumbnailUrl, channelTitle) {
    this.id = id;
    this.title = title;
    this.url = url;
    this.publishedAt = publishedAt;
    this.thumbnailUrl = thumbnailUrl;
    this.channelTitle = channelTitle;
  }
}

// Function to fetch latest videos from YouTube RSS feed
async function fetchLatestVideos(channelId, maxResults = 2) {
  console.log(`Fetching latest videos for channel: ${channelId}`);
  try {
    const params = new URLSearchParams({ channel_id: channelId });
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout
    
    const response = await fetch(`${RSS_URL}?${params}`, {
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const xmlText = await response.text();
    console.log(`Received XML response, length: ${xmlText.length} characters`);
    
    // Parse XML using fast-xml-parser to avoid MessagePort issues
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      textNodeName: "#text"
    });
    const parsedData = parser.parse(xmlText);
    const entries = parsedData.feed.entry || [];
    console.debug(`Found ${entries.length} entries in RSS feed`);
    const videos = [];
    
    for (let i = 0; i < Math.min(maxResults, entries.length); i++) {
      const entry = entries[i];
      
      // Extract video ID
      const videoId = entry['yt:videoId'] || '';
      if (!videoId) {
        console.debug(`Skipping entry with no video ID`);
        continue;
      }
      
      // Extract title
      const title = entry.title || '';
      
      // Skip live streams based on title
      if (LIVE_TITLE.test(title)) {
        console.debug(`Skipping live stream (title): ${title}`);
        continue;
      }
      
      // Check if video is live using page check
      if (await isLiveBroadcast(videoId)) {
        console.debug(`Skipping live stream (page check): ${title}`);
        continue;
      }
      
      // Extract published date
      const publishedRaw = entry.published || '';
      const publishedAt = new Date(publishedRaw);
      
      // Extract channel title
      const author = entry.author?.name;
      const channelTitle = author ? author : '';
      
      // Extract thumbnail URL
      const thumbnail = entry['media:group']?.['media:thumbnail'];
      const thumbnailUrl = thumbnail ? thumbnail.url : '';
      
      videos.push(new VideoItem(
        videoId,
        title,
        `https://youtube.com/watch?v=${videoId}`,
        publishedAt,
        thumbnailUrl,
        channelTitle
      ));
    }
    
    return videos;
  } catch (error) {
    console.error('Error fetching videos:', error);
    throw error;
  }
}

// Function to send message to Discord webhook
async function sendDiscordMessage(video, env) {
  try {
    const payload = {
      content: '',
      embeds: [{
        title: video.title,
        url: video.url,
        color: 16711680, // Red color (0xFF0000)
        timestamp: video.publishedAt.toISOString(),
        author: {
          name: video.channelTitle
        },
        image: {
          url: video.thumbnailUrl
        }
      }]
    };
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout
    
    const response = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Discord webhook failed with status ${response.status}`);
    }
    
    console.info(`Posted: ${video.title}`);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('Timeout while sending Discord message');
    } else {
      console.error('Error sending Discord message:', error);
    }
    throw error;
  }
}

// Replace in-memory tracking with KV storage
async function isVideoSeen(videoId) {
  const seen = await SEEN_VIDEOS.get(`seen:${videoId}`);
  return seen !== null;
}

async function markVideoAsSeen(videoId) {
  await SEEN_VIDEOS.put(`seen:${videoId}`, 'true');
}

// Main function that runs on cron schedule
async function handleScheduled(env) {
  try {
    console.log('Starting scheduled processing...');
    console.log(`Environment variables - Channel ID: ${env.YOUTUBE_CHANNEL_ID ? 'Set' : 'Not set'}, Webhook URL: ${env.DISCORD_WEBHOOK_URL ? 'Set' : 'Not set'}`);
    
    // Validate configuration
    if (!env.YOUTUBE_CHANNEL_ID || !env.DISCORD_WEBHOOK_URL) {
      console.error('ERROR: Missing required environment variables');
      throw new Error('Missing required environment variables: YOUTUBE_CHANNEL_ID and DISCORD_WEBHOOK_URL');
    }
    
    console.log('Configuration validated successfully');
    
    // Fetch latest videos
    const videos = await fetchLatestVideos(env.YOUTUBE_CHANNEL_ID);
    console.log(`Fetched ${videos.length} videos from YouTube`);
    
    // Filter out already seen videos
    const newVideos = videos.filter(video => !seenVideoSeen(video.id));
    console.log(`Found ${newVideos.length} new videos`);
    
    if (newVideos.length === 0) {
      console.log('No new videos found');
      return;
    }
    
    // Mark new videos as seen
    for (const video of newVideos) {
      await markVideoAsSeen(video.id);
    }
    console.log(`Marked ${newVideos.length} videos as seen`);
    
    // Send messages to Discord
    console.log('Sending messages to Discord...');
    for (const video of newVideos) {
      await sendDiscordMessage(video, env);
    }
    
    console.log(`Successfully processed ${newVideos.length} new videos`);
  } catch (error) {
    console.error('Error in scheduled function:', error);
    throw error;
  }
}

export default {
  async scheduled(event, env, ctx) {
    console.log('Scheduled event triggered');
    // Run the main logic when the worker is invoked by the cron trigger
    await handleScheduled(env);
    // Return a simple response to satisfy Cloudflare Worker requirements
    return new Response('Processed YouTube videos successfully');
  },
  
  async fetch(request, env, ctx) {
    console.log('Direct fetch request received');
    // Run the main logic when the worker is invoked directly
    await handleScheduled(env);
    // Return a simple response to satisfy Cloudflare Worker requirements
    return new Response('Processed YouTube videos successfully');
  }
};
