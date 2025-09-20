require('dotenv').config();
const irc = require('irc-framework');
const fetch = require('node-fetch');

class EloWardTwitchBot {
  constructor() {
    this.bot = new irc.Client();
    this.channels = new Set();
    this.CLOUDFLARE_WORKER_URL = process.env.CF_WORKER_URL || 'https://eloward-bot.unleashai.workers.dev';
  }

  async start() {
    const token = process.env.TWITCH_TOKEN;
    if (!token) {
      console.error('❌ TWITCH_TOKEN environment variable required');
      console.error('Make sure .env file exists with TWITCH_TOKEN=oauth:your_token');
      process.exit(1);
    }

    console.log('🚀 Starting EloWard Twitch Bot...');
    console.log('📡 CF Worker URL:', this.CLOUDFLARE_WORKER_URL);

    this.bot.connect({
      host: 'irc.chat.twitch.tv',
      port: 6667,
      nick: 'elowardbot',
      username: 'elowardbot',
      password: token
    });

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.bot.on('registered', () => {
      console.log('✅ Connected to Twitch IRC successfully!');
      this.loadChannelsFromCloudflare();
    });

    this.bot.on('privmsg', this.handleMessage.bind(this));
    this.bot.on('error', (err) => console.error('❌ IRC Error:', err));
  }

  async handleMessage(event) {
    const channel = event.target.replace('#', '');
    const user = event.nick;
    const message = event.message;

    console.log(`📝 [${channel}] ${user}: ${message}`);

    try {
      // Call your existing Cloudflare Worker
      const response = await fetch(`${this.CLOUDFLARE_WORKER_URL}/check-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, user, message })
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`✅ Processed message for ${user} in ${channel}:`, result.action);
      } else {
        console.error(`❌ CF Worker responded with ${response.status}`);
      }
    } catch (error) {
      console.error(`❌ Error processing message: ${error.message}`);
    }
  }

  async loadChannelsFromCloudflare() {
    try {
      console.log('📡 Loading channels from Cloudflare...');
      const response = await fetch(`${this.CLOUDFLARE_WORKER_URL}/channels`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const { channels } = await response.json();
      
      channels.forEach(channel => {
        this.bot.join(`#${channel}`);
        this.channels.add(channel);
      });
      
      console.log(`✅ Joined ${channels.length} channels:`, channels);
    } catch (error) {
      console.error('❌ Failed to load channels:', error.message);
      // Fallback: join a test channel
      console.log('🔄 Falling back to test channel...');
      this.bot.join('#yomata1');
      this.channels.add('yomata1');
    }
  }
}

// Start the bot
const bot = new EloWardTwitchBot();
bot.start();