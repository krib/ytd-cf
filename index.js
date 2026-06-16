// Configuration - using environment variables from Cloudflare
const YOUTUBE_CHANNEL_ID = typeof ENV !== 'undefined' ? ENV.YOUTUBE_CHANNEL_ID || '' : '';
const DISCORD_WEBHOOK_URL = typeof ENV !== 'undefined' ? ENV.DISCORD_WEBHOOK_URL || '' : '';

// YouTube RSS URL
const RSS_URL = "https://www.youtube.com/feeds/videos.xml";

// Regular expression for live stream titles
const LIVE_TITLE = /^[🔴🟡🟢🔵🟣⏺▪️]\s*(LIVE|PREMIERE|STREAM|首播|生放送)/i;

// In-memory storage for seen videos (in production, you'd want to use Durable Objects or KV)
let seenVideos = new Set();

// Helper function to check if a video is live
async function isLiveBroadcast(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    if (!response.ok) {
      return false;
    }
    
    const text = await response.text();
    return text.includes('"isLiveBroadcast":true') || text.includes('"isLiveContent":true');
  } catch (error) {
    console.warn(`Failed to check video ${videoId}, assuming not live`, error);
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
async function fetchLatestVideos(channelId, maxResults = 5) {
  try {
    const params = new URLSearchParams({ channel_id: channelId });
    const response = await fetch(`${RSS_URL}?${params}`, {
      timeout: 10000 // 10 seconds timeout
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const xmlText = await response.text();
    // Parse XML using DOMParser (available in Cloudflare Workers)
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    
    const entries = xmlDoc.getElementsByTagName("entry");
    const videos = [];
    
    for (let i = 0; i < Math.min(maxResults, entries.length); i++) {
      const entry = entries[i];
      
      // Extract video ID
      const videoId = entry.querySelector('yt\\:videoId')?.textContent || '';
      if (!videoId) continue;
      
      // Extract title
      const title = entry.querySelector('atom\\:title')?.textContent || '';
      
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
      const publishedRaw = entry.querySelector('atom\\:published')?.textContent || '';
      const publishedAt = new Date(publishedRaw);
      
      // Extract channel title
      const author = entry.querySelector('atom\\:author atom\\:name');
      const channelTitle = author ? author.textContent : '';
      
      // Extract thumbnail URL
      const thumbnail = entry.querySelector('media\\:group media\\:thumbnail');
      const thumbnailUrl = thumbnail ? thumbnail.getAttribute('url') : '';
      
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
async function sendDiscordMessage(video) {
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
    
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`Discord webhook failed with status ${response.status}`);
    }
    
    console.info(`Posted: ${video.title}`);
  } catch (error) {
    console.error('Error sending Discord message:', error);
    throw error;
  }
}

// Main function that runs on cron schedule
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
  
  async handleScheduled(event, env) {
    try {
      console.log('Checking for new YouTube videos...');
      
      // Validate configuration
      if (!YOUTUBE_CHANNEL_ID || !DISCORD_WEBHOOK_URL) {
        throw new Error('Missing required environment variables: YOUTUBE_CHANNEL_ID and DISCORD_WEBHOOK_URL');
      }
      
      // Fetch latest videos
      const videos = await fetchLatestVideos(YOUTUBE_CHANNEL_ID);
      
      // Filter out already seen videos
      const newVideos = videos.filter(video => !seenVideos.has(video.id));
      
      if (newVideos.length === 0) {
        console.log('No new videos found');
        return;
      }
      
      // Mark new videos as seen
      for (const video of newVideos) {
        seenVideos.add(video.id);
      }
      
      // Send messages to Discord
      for (const video of newVideos) {
        await sendDiscordMessage(video);
      }
      
      console.log(`Successfully processed ${newVideos.length} new videos`);
    } catch (error) {
      console.error('Error in scheduled function:', error);
      throw error;
    }
  }
};