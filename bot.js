require('dotenv').config();
const irc = require('irc-framework');
const fetch = require('node-fetch');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const Redis = require('ioredis');

class EloWardTwitchBot {
  constructor() {
    this.bot = new irc.Client();
    this.channels = new Set();
    this.CLOUDFLARE_WORKER_URL = process.env.CF_WORKER_URL || 'https://eloward-bot.unleashai.workers.dev';
    this.currentToken = null;
    this.tokenExpiresAt = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.tokenCheckInterval = null;
    
    // AWS SQS Configuration
    this.sqs = new SQSClient({ 
      region: process.env.AWS_REGION || 'us-west-2',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
    this.queueUrl = process.env.SQS_QUEUE_URL;
    
    // Redis Configuration
    this.redis = null;
    if (process.env.REDIS_URL) {
      this.redis = new Redis({
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        retryDelayOnFailure: 100,
        enableOfflineQueue: false,
        lazyConnect: true
      });
    }
  }

  async start() {
    console.log('🚀 Starting EloWard Twitch Bot with instant Redis notifications...');
    console.log('📡 CF Worker URL:', this.CLOUDFLARE_WORKER_URL);
    console.log('⚡ Redis:', this.redis ? 'Configured for instant notifications' : 'Not configured - using polling only');
    console.log('📨 SQS Queue:', this.queueUrl ? 'Available for testing/backup' : 'Not configured');
    console.log('🔄 Periodic Polling: 15-minute fallback for reliability');

    // Get fresh token from CF Worker
    const tokenData = await this.getTokenFromWorker();
    if (!tokenData) {
      console.error('❌ Failed to get token from CF Worker');
      process.exit(1);
    }

    console.log('✅ Token obtained from CF Worker', { 
      userLogin: tokenData.user.login,
      expiresInMinutes: tokenData.expires_in_minutes
    });

    this.currentToken = tokenData.token;
    this.tokenExpiresAt = tokenData.expires_at;

    await this.connectToTwitch();
    this.setupEventHandlers();
    this.startTokenMonitoring();
    
    // Start messaging systems - Redis first for instant notifications
    this.startRedisSubscription();
    this.startSQSPolling();
  }

  // PRODUCTION TOKEN SYNC - Get current token from CF Worker
  async getTokenFromWorker() {
    try {
      console.log('🔄 Requesting fresh token from CF Worker...');
      
      const response = await fetch(`${this.CLOUDFLARE_WORKER_URL}/token`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('❌ Token request failed:', { 
          status: response.status, 
          error: error.error 
        });
        return null;
      }

      const tokenData = await response.json();
      
      console.log('✅ Token received from CF Worker', {
        userLogin: tokenData.user?.login,
        expiresInMinutes: tokenData.expires_in_minutes,
        needsRefreshSoon: tokenData.needs_refresh_soon
      });

      return tokenData;
    } catch (e) {
      console.error('❌ Token sync failed:', e.message);
      return null;
    }
  }

  // PRODUCTION CONNECTION - Use fresh token
  async connectToTwitch() {
    if (!this.currentToken) {
      throw new Error('No token available for connection');
    }

    console.log('🔌 Connecting to Twitch IRC with fresh token...');

    this.bot.connect({
      host: 'irc.chat.twitch.tv',
      port: 6667,
      nick: 'elowardbot',
      username: 'elowardbot',
      password: this.currentToken
    });
  }

  // PRODUCTION TOKEN MONITORING - Refresh before expiry + Channel reloading
  startTokenMonitoring() {
    // Check token every 15 minutes
    this.tokenCheckInterval = setInterval(async () => {
      const now = Date.now();
      const expiresInMinutes = Math.floor((this.tokenExpiresAt - now) / 60000);
      
      console.log('🔍 Token health check', { 
        expiresInMinutes,
        needsRefresh: expiresInMinutes < 120,
        timestamp: new Date().toISOString()
      });

      // Refresh if expires in next 2 hours
      if (expiresInMinutes < 120) {
        console.log('🔄 Token needs refresh - syncing with CF Worker');
        await this.refreshToken();
      }
    }, 15 * 60 * 1000);
  }

  async refreshToken() {
    try {
      console.log('🔄 Refreshing token from CF Worker...');
      
      const tokenData = await this.getTokenFromWorker();
      if (!tokenData) {
        console.error('❌ Token refresh failed');
        return false;
      }

      const oldToken = this.currentToken;
      this.currentToken = tokenData.token;
      this.tokenExpiresAt = tokenData.expires_at;

      // If token actually changed, reconnect
      if (oldToken !== this.currentToken) {
        console.log('🔄 Token changed - reconnecting to Twitch...');
        this.bot.quit('Token refresh - reconnecting');
        
        setTimeout(() => {
          this.connectToTwitch();
        }, 2000);
      } else {
        console.log('✅ Token is still current');
      }

      return true;
    } catch (e) {
      console.error('❌ Token refresh error:', e.message);
      return false;
    }
  }

  setupEventHandlers() {
    this.bot.on('registered', () => {
      console.log('✅ Connected to Twitch IRC successfully!');
      this.reconnectAttempts = 0;
      this.loadChannelsFromCloudflare();
      
      // Post-startup channel check
      setTimeout(() => {
        console.log('🔄 Post-startup channel check...');
        this.reloadChannelsIfNeeded();
      }, 5000);
    });

    this.bot.on('privmsg', this.handleMessage.bind(this));
    
    this.bot.on('error', (err) => {
      console.error('❌ IRC Error:', err);
      this.handleConnectionError(err);
    });

    this.bot.on('close', () => {
      console.log('🔌 IRC connection closed');
      this.handleConnectionError(new Error('Connection closed'));
    });
  }

  // PRODUCTION ERROR HANDLING - Exponential backoff reconnection
  async handleConnectionError(error) {
    console.error('🔌 Connection error occurred:', error.message);
    
    if (error.message === 'Token refresh - reconnecting') {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    
    console.log(`🔄 Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    setTimeout(async () => {
      try {
        const tokenData = await this.getTokenFromWorker();
        if (tokenData) {
          this.currentToken = tokenData.token;
          this.tokenExpiresAt = tokenData.expires_at;
        }
        
        await this.connectToTwitch();
      } catch (e) {
        console.error(`❌ Reconnection attempt ${this.reconnectAttempts} failed:`, e.message);
      }
    }, delay);
  }

  async handleMessage(event) {
    const channel = event.target.replace('#', '');
    const user = event.nick;
    const message = event.message;

    console.log(`📝 [${channel}] ${user}: ${message}`);

    try {
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
      console.log('⚠️ No channels loaded - bot will not join any channels automatically');
    }
  }

  // Dynamic channel reloading (join new, leave removed)
  async reloadChannelsIfNeeded() {
    try {
      console.log('🔍 Checking for channel changes...');
      const response = await fetch(`${this.CLOUDFLARE_WORKER_URL}/channels`);
      
      if (!response.ok) {
        console.log(`⚠️ Channel reload failed: HTTP ${response.status}`);
        return;
      }
      
      const { channels: newChannels } = await response.json();
      const newChannelSet = new Set(newChannels);
      const currentChannels = Array.from(this.channels);
      
      const channelsToJoin = newChannels.filter(channel => !this.channels.has(channel));
      const channelsToLeave = currentChannels.filter(channel => !newChannelSet.has(channel));
      
      // Join new channels
      if (channelsToJoin.length > 0) {
        console.log(`📥 Joining ${channelsToJoin.length} new channels:`, channelsToJoin);
        for (const channel of channelsToJoin) {
          this.bot.join(`#${channel}`);
          this.channels.add(channel);
          console.log(`✅ Joined: #${channel}`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      // Leave removed channels
      if (channelsToLeave.length > 0) {
        console.log(`📤 Leaving ${channelsToLeave.length} removed channels:`, channelsToLeave);
        for (const channel of channelsToLeave) {
          this.bot.part(`#${channel}`);
          this.channels.delete(channel);
          console.log(`👋 Left: #${channel}`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      if (channelsToJoin.length === 0 && channelsToLeave.length === 0) {
        console.log('✅ No channel changes detected');
      } else {
        console.log(`🔄 Channel reload complete. Now in ${this.channels.size} channels:`, Array.from(this.channels));
      }
      
    } catch (error) {
      console.error('❌ Channel reload failed:', error.message);
    }
  }

  // SQS message polling for reliable backup delivery
  startSQSPolling() {
    if (!this.queueUrl) {
      console.log('⚠️ SQS not configured - no backup messaging');
      return;
    }

    console.log('🔄 Starting SQS backup polling...');
    
    const pollSQS = async () => {
      try {
        const command = new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20, // Long polling
          MessageAttributeNames: ['All']
        });
        
        const response = await this.sqs.send(command);
        
        if (response.Messages) {
          for (const message of response.Messages) {
            await this.handleSQSMessage(message);
            
            // Delete processed message
            await this.sqs.send(new DeleteMessageCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: message.ReceiptHandle
            }));
          }
        }
      } catch (error) {
        console.error('❌ SQS polling error:', error.message);
      }
      
      // Continue polling
      setTimeout(pollSQS, 1000);
    };

    // Start polling
    pollSQS();
  }

  async handleSQSMessage(message) {
    try {
      const body = JSON.parse(message.Body);
      console.log('📨 SQS backup message received:', body);
      
      if (body.action === 'enable' || body.action === 'disable') {
        console.log('🔔 Channel update via SQS backup:', body.action, body.channel);
        await this.reloadChannelsIfNeeded();
      }
    } catch (error) {
      console.error('❌ SQS message handling error:', error.message);
    }
  }

  // Redis subscription for instant notifications (primary method)
  startRedisSubscription() {
    if (!this.redis) {
      console.log('⚠️ Redis not configured - relying on SQS for channel updates');
      return;
    }

    console.log('🔄 Starting Redis subscription for instant notifications...');
    
    this.redis.connect().then(() => {
      console.log('✅ Connected to Redis for instant channel updates');
      
      this.redis.subscribe('eloward:bot:commands');
      
      this.redis.on('message', async (channel, message) => {
        if (channel === 'eloward:bot:commands') {
          try {
            const data = JSON.parse(message);
            console.log('⚡ Instant Redis notification:', data);
            
            if (data.action === 'enable' || data.action === 'disable') {
              console.log('🚀 Instant channel update via Redis:', data.action, data.channel);
              await this.reloadChannelsIfNeeded();
            }
          } catch (error) {
            console.error('❌ Redis message handling error:', error.message);
          }
        }
      });
      
      this.redis.on('error', (error) => {
        console.error('❌ Redis connection error:', error.message);
      });
      
      this.redis.on('reconnecting', () => {
        console.log('🔄 Redis reconnecting...');
      });
      
    }).catch((error) => {
      console.error('❌ Redis connection failed:', error.message);
      console.log('⚠️ Falling back to SQS-only messaging');
    });
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  if (bot.redis) bot.redis.disconnect();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Interrupted - shutting down gracefully...');
  if (bot.redis) bot.redis.disconnect();
  process.exit(0);
});

// Start the bot
const bot = new EloWardTwitchBot();
bot.start();
