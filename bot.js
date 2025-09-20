require('dotenv').config();
const irc = require('irc-framework');
const fetch = require('node-fetch');

class EloWardTwitchBot {
  constructor() {
    this.bot = new irc.Client();
    this.channels = new Set();
    this.CLOUDFLARE_WORKER_URL = process.env.CF_WORKER_URL || 'https://eloward-bot.unleashai.workers.dev';
    this.currentToken = null;
    this.tokenExpiresAt = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000; // 30 seconds max
    this.tokenCheckInterval = null;
  }

  async start() {
    console.log('🚀 Starting EloWard Twitch Bot with dynamic token management...');
    console.log('📡 CF Worker URL:', this.CLOUDFLARE_WORKER_URL);

    // Get fresh token from CF Worker instead of static env var
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

  // PRODUCTION TOKEN MONITORING - Refresh before expiry
  startTokenMonitoring() {
    // Check token every 15 minutes (more responsive)
    this.tokenCheckInterval = setInterval(async () => {
      const now = Date.now();
      const expiresInMinutes = Math.floor((this.tokenExpiresAt - now) / 60000);
      
      console.log('🔍 Token health check', { 
        expiresInMinutes,
        needsRefresh: expiresInMinutes < 120, // Refresh if expires in 2 hours (more proactive)
        timestamp: new Date().toISOString()
      });

      // Refresh if expires in next 2 hours (more proactive)
      if (expiresInMinutes < 120) {
        console.log('🔄 Token needs refresh - syncing with CF Worker');
        await this.refreshToken();
      }
    }, 15 * 60 * 1000); // Every 15 minutes (more frequent checks)
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
        
        // Reconnect with new token after short delay
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
      this.reconnectAttempts = 0; // Reset on successful connection
      this.loadChannelsFromCloudflare();
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
    
    // Don't reconnect if we're in the middle of a token refresh
    if (error.message === 'Token refresh - reconnecting') {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    
    console.log(`🔄 Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    setTimeout(async () => {
      try {
        // Get fresh token before reconnecting (in case token was the issue)
        const tokenData = await this.getTokenFromWorker();
        if (tokenData) {
          this.currentToken = tokenData.token;
          this.tokenExpiresAt = tokenData.expires_at;
        }
        
        await this.connectToTwitch();
      } catch (e) {
        console.error(`❌ Reconnection attempt ${this.reconnectAttempts} failed:`, e.message);
        // Will trigger another reconnection attempt
      }
    }, delay);
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
      console.log('⚠️ No channels loaded - bot will not join any channels automatically');
      // Note: Channels must be configured via the dashboard or API
    }
  }
}

// Start the bot
const bot = new EloWardTwitchBot();
bot.start();