require('dotenv').config();
const irc = require('irc-framework');
const fetch = require('node-fetch');
const crypto = require('crypto');
const Redis = require('ioredis');

class EloWardTwitchBot {
  constructor() {
    // Two IRC connections for resilience (per README spec)
    this.primaryBot = new irc.Client();
    this.secondaryBot = new irc.Client();
    this.channels = new Map(); // channel_name -> {primary: bool, secondary: bool}
    this.maxChannelsPerConnection = 80; // 75-80 channels each per README
    this.WORKER_URL = process.env.CF_WORKER_URL || 'https://eloward-bot.unleashai.workers.dev';
    this.HMAC_SECRET = process.env.HMAC_SECRET;
    this.currentToken = null;
    this.tokenExpiresAt = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.tokenCheckInterval = null;
    this.configSweepInterval = null;
    
    // Local caches with TTL (production optimization)
    this.configCache = new Map(); // channel -> {config, expires}  
    this.rankCache = new Map();   // user -> {hasRank, expires}
    
    // Redis for instant config updates
    this.redis = null;
    if (process.env.UPSTASH_REDIS_URL) {
      this.redis = new Redis(process.env.UPSTASH_REDIS_URL, {
        password: process.env.UPSTASH_REDIS_PASSWORD,
        retryDelayOnFailure: 100,
        enableOfflineQueue: false,
        lazyConnect: true,
        tls: process.env.UPSTASH_REDIS_URL.startsWith('rediss:') ? {} : undefined
      });
    }
    
    if (!this.HMAC_SECRET) {
      throw new Error('HMAC_SECRET required for production security');
    }
  }

  async start() {
    console.log('🚀 Starting EloWard Production IRC Bot...');
    console.log('📡 Worker URL:', this.WORKER_URL);
    console.log('⚡ Redis:', this.redis ? 'Configured for instant config updates (1-3s propagation)' : 'Not configured - using polling fallback');
    console.log('🔒 HMAC Security: Enabled (SHA-256, ±60s window)');
    console.log('💾 Local Caching: Config (1-2s TTL), Rank (30-60s TTL) for <400ms decisions');
    console.log('🔗 IRC Connections: Dual connections for resilience (max 80 channels each)');

    // Get fresh token from Worker
    const tokenData = await this.getTokenFromWorker();
    if (!tokenData) {
      console.error('❌ Failed to get token from Worker');
      process.exit(1);
    }

    console.log('✅ Token obtained', { 
      userLogin: tokenData.user.login,
      expiresInMinutes: tokenData.expires_in_minutes
    });

    this.currentToken = tokenData.token;
    this.tokenExpiresAt = tokenData.expires_at;

    await this.connectToTwitch();
    this.setupEventHandlers();
    this.startTokenMonitoring();
    this.startRedisSubscription();
    this.startConfigSweep();
  }

  // HMAC request signing for secure Worker communication
  signRequest(method, path, body) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = timestamp + method + path + (body || '');
    const signature = crypto.createHmac('sha256', this.HMAC_SECRET)
      .update(payload)
      .digest('hex');
    
    return {
      'X-HMAC-Signature': signature,
      'X-Timestamp': timestamp.toString(),
      'Content-Type': 'application/json'
    };
  }

  // Token sync - unprotected endpoint for IRC bot
  async getTokenFromWorker() {
    try {
      console.log('🔄 Requesting fresh token from Worker...');
      
      const response = await fetch(`${this.WORKER_URL}/token`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('❌ Token request failed:', { 
          status: response.status, 
          error: error.error 
        });
        return null;
      }

      const tokenData = await response.json();
      
      console.log('✅ Token received from Worker', {
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

  // Production IRC connection with dual connections for resilience
  async connectToTwitch() {
    if (!this.currentToken) {
      throw new Error('No token available for connection');
    }

    console.log('🔌 Connecting to Twitch IRC with dual connections for resilience...');

    const connectionConfig = {
      host: 'irc.chat.twitch.tv',
      port: 6667,
      nick: 'elowardbot',
      username: 'elowardbot',
      password: this.currentToken
    };

    // Connect both IRC clients for resilience
    this.primaryBot.connect(connectionConfig);
    
    // Stagger secondary connection to avoid rate limits
    setTimeout(() => {
      this.secondaryBot.connect(connectionConfig);
    }, 2000);
  }

  // Permanent local caching - only invalidated by Redis pub/sub
  getCachedConfig(channelLogin) {
    const cached = this.configCache.get(channelLogin);
    return cached ? cached.config : null;
  }

  setCachedConfig(channelLogin, config) {
    this.configCache.set(channelLogin, { config });
  }

  getCachedRank(userLogin) {
    const cached = this.rankCache.get(userLogin);
    if (cached && Date.now() < cached.expires) {
      return { hasRank: cached.hasRank, cached: true };
    }
    return null;
  }

  setCachedRank(userLogin, hasRank) {
    this.rankCache.set(userLogin, {
      hasRank,
      expires: Date.now() + (hasRank ? 60000 : 30000) // 60s for valid, 30s for invalid
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

      // If token actually changed, reconnect both connections
      if (oldToken !== this.currentToken) {
        console.log('🔄 Token changed - reconnecting both IRC connections...');
        this.primaryBot.quit('Token refresh - reconnecting');
        this.secondaryBot.quit('Token refresh - reconnecting');
        
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
    // Primary connection event handlers
    this.primaryBot.on('registered', () => {
      console.log('✅ Primary IRC connection established!');
      this.reconnectAttempts = 0;
      this.loadChannels();
      
      // Post-startup channel check
      setTimeout(() => {
        console.log('🔄 Post-startup channel sync...');
        this.reloadChannels();
      }, 5000);
    });

    this.primaryBot.on('privmsg', (event) => this.handleMessage(event, 'primary'));
    this.primaryBot.on('error', (err) => this.handleConnectionError(err, 'primary'));
    this.primaryBot.on('close', () => this.handleConnectionError(new Error('Primary connection closed'), 'primary'));

    // Secondary connection event handlers  
    this.secondaryBot.on('registered', () => {
      console.log('✅ Secondary IRC connection established for resilience!');
    });

    this.secondaryBot.on('privmsg', (event) => this.handleMessage(event, 'secondary'));
    this.secondaryBot.on('error', (err) => this.handleConnectionError(err, 'secondary'));
    this.secondaryBot.on('close', () => this.handleConnectionError(new Error('Secondary connection closed'), 'secondary'));
  }

  // PRODUCTION ERROR HANDLING - Exponential backoff reconnection with dual connection support
  async handleConnectionError(error, connection = 'unknown') {
    console.error(`🔌 ${connection} connection error occurred:`, error.message);
    
    if (error.message.includes('Token refresh - reconnecting')) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    
    console.log(`🔄 Scheduling ${connection} reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    setTimeout(async () => {
      try {
        const tokenData = await this.getTokenFromWorker();
        if (tokenData) {
          this.currentToken = tokenData.token;
          this.tokenExpiresAt = tokenData.expires_at;
        }
        
        // Reconnect the specific connection that failed
        const connectionConfig = {
          host: 'irc.chat.twitch.tv',
          port: 6667,
          nick: 'elowardbot',
          username: 'elowardbot',
          password: this.currentToken
        };

        if (connection === 'primary') {
          this.primaryBot.connect(connectionConfig);
        } else if (connection === 'secondary') {
          this.secondaryBot.connect(connectionConfig);
        } else {
          // Fallback: reconnect both
        await this.connectToTwitch();
        }
      } catch (e) {
        console.error(`❌ ${connection} reconnection attempt ${this.reconnectAttempts} failed:`, e.message);
      }
    }, delay);
  }

  // PRODUCTION MESSAGE PROCESSING - Fast decisions with local caching (dual connection support)
  async handleMessage(event, connection = 'primary') {
    const startTime = Date.now();
    const channelLogin = event.target.replace('#', '');
    const userLogin = event.nick;
    const message = event.message;

    // Fast prefix check for chat commands (only process on primary to avoid duplicates)
    if (message.startsWith('!eloward') && connection === 'primary') {
      console.log(`🎯 Chat command detected: ${userLogin} in ${channelLogin}: ${message}`);
      return this.handleChatCommand(channelLogin, userLogin, message, event);
    }

    try {
      // Step 1: Get channel config (cache hit = instant decision)
      let config = this.getCachedConfig(channelLogin);
      const configCached = !!config;
      
      if (!config) {
        // Cache miss - HMAC call to Worker
        console.log(`🔍 Config cache miss for ${channelLogin}, fetching from Worker...`);
        config = await this.fetchChannelConfig(channelLogin);
        this.setCachedConfig(channelLogin, config);
      }

      // Debug: Always log the config state for troubleshooting
      console.log(`🔍 Config check for ${channelLogin}: enabled=${config?.bot_enabled}, cached=${configCached}, config=${config ? 'present' : 'null'}`);

      if (!config?.bot_enabled) {
        // Channel not configured or in standby mode - allow all messages
        console.log(`⏸️  Bot in standby for ${channelLogin} (enabled: ${config?.bot_enabled}), allowing message from ${userLogin}`);
        return;
      }

      console.log(`🤖 Bot active in ${channelLogin}, processing message from ${userLogin} (config cached: ${configCached})`);

      // Step 2: Check if user is exempt (broadcaster/mod/vip based on config)
      if (this.isUserExempt(userLogin, channelLogin, event, config)) {
        console.log(`👑 User ${userLogin} is exempt in ${channelLogin}, allowing message`);
        return;
      }

      // Step 3: Check user rank (cache hit = instant decision)
      let rankResult = this.getCachedRank(userLogin);
      const rankCached = !!rankResult;
      
      if (!rankResult) {
        // Cache miss - HMAC call to Worker
        console.log(`🔍 Rank cache miss for ${userLogin}, fetching from Worker...`);
        const hasRank = await this.fetchUserRank(userLogin);
        this.setCachedRank(userLogin, hasRank);
        rankResult = { hasRank, cached: false };
      }

      console.log(`📊 Rank check for ${userLogin}: hasRank=${rankResult.hasRank} (cached: ${rankCached})`);

      // Step 4: Apply enforcement logic
      const shouldTimeout = this.shouldTimeoutUser(rankResult.hasRank, config);
      
      console.log(`⚖️  Enforcement decision for ${userLogin} in ${channelLogin}: shouldTimeout=${shouldTimeout} (mode: ${config.enforcement_mode})`);
      
      if (shouldTimeout) {
        console.log(`🔨 Executing timeout for ${userLogin} in ${channelLogin}...`);
        await this.executeTimeout(channelLogin, userLogin, config);
        const duration = Date.now() - startTime;
        console.log(`⏱️  Message decision: TIMEOUT ${userLogin} in ${channelLogin} (${duration}ms)`);
      } else {
        const duration = Date.now() - startTime;
        console.log(`✅ Message allowed: ${userLogin} in ${channelLogin} (${duration}ms)`);
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ Message processing error for ${userLogin} in ${channelLogin} (${duration}ms):`, error.message);
      // Fail open on errors - don't timeout on system failures
    }
  }

  // HMAC-secured config fetch with caching
  async fetchChannelConfig(channelLogin) {
    try {
      const path = '/bot/config-get';
      const body = JSON.stringify({ channel_login: channelLogin });
      const headers = this.signRequest('POST', path, body);
      
      const response = await fetch(`${this.WORKER_URL}${path}`, {
        method: 'POST',
        headers,
        body
      });

      if (response.ok) {
        const config = await response.json();
        console.log(`📥 Config fetched for ${channelLogin}: enabled=${config.bot_enabled}, enforcement=${config.enforcement_mode}`);
        return config;
      } else if (response.status === 404) {
        console.log(`📭 No config found for ${channelLogin} (404)`);
        return null; // Channel not configured
      } else {
        console.warn(`Config fetch failed for ${channelLogin}: ${response.status}`);
        return null;
      }
    } catch (error) {
      console.warn(`Config fetch error for ${channelLogin}:`, error.message);
      return null;
    }
  }

  // HMAC-secured rank fetch with caching
  async fetchUserRank(userLogin) {
    try {
      const path = '/rank:get';
      const body = JSON.stringify({ user_login: userLogin });
      const headers = this.signRequest('POST', path, body);
      
      const response = await fetch(`${this.WORKER_URL}${path}`, {
        method: 'POST',
        headers,
        body
      });

      if (response.ok) {
        return true; // User has valid rank
      } else {
        return false; // No valid rank
      }
    } catch (error) {
      console.warn(`Rank fetch error for ${userLogin} - failing open (allowing message):`, error.message);
      return true; // Fail open on errors - assume user has rank to avoid timeouts due to system issues
    }
  }

  // Check if user should be exempt from enforcement
  isUserExempt(userLogin, channelLogin, event, config) {
    // Always exempt broadcaster
    if (userLogin.toLowerCase() === channelLogin.toLowerCase()) {
      return true;
    }

    // Check IRC badges from event
    const badges = event.tags?.badges || '';
    const ignoreRoles = (config.ignore_roles || 'broadcaster,moderator').toLowerCase();
    
    if (ignoreRoles.includes('moderator') && badges.includes('moderator/')) {
      return true;
    }
    
    if (ignoreRoles.includes('vip') && badges.includes('vip/')) {
      return true;
    }
    
    if (ignoreRoles.includes('subscriber') && badges.includes('subscriber/')) {
      return true;
    }

    return false;
  }

  // Enforcement logic based on config - FAIL-OPEN design
  // Note: hasRank=true on system errors (fetchUserRank catch block) to avoid timeouts during outages
  shouldTimeoutUser(hasRank, config) {
    if (!config.bot_enabled) return false;

    const mode = config.enforcement_mode || 'has_rank';
    
    if (mode === 'has_rank') {
      return !hasRank; // Timeout if no rank badge (but hasRank=true on system errors)
    }
    
    if (mode === 'min_rank') {
      // For minimum rank mode, we need rank details from Worker
      // For now, treat as has_rank mode - can be enhanced later
      return !hasRank; // (but hasRank=true on system errors)
    }
    
    return false; // Default: allow message
  }

  // Execute timeout via Twitch Helix API (bot calls directly)  
  async executeTimeout(channelLogin, userLogin, config) {
    try {
      const duration = config.timeout_seconds || 30;
      const reasonTemplate = config.reason_template || 'not enough elo to speak. type !eloward';
      
      const reason = reasonTemplate
        .replace('{seconds}', duration)
        .replace('{site}', 'https://eloward.com')
        .replace('{user}', userLogin);

      // First, get user ID, broadcaster ID, and bot's own ID from Twitch API
      const userInfo = await this.getTwitchUserInfo([userLogin, channelLogin, 'elowardbot']);
      if (!userInfo || !userInfo[userLogin] || !userInfo[channelLogin] || !userInfo['elowardbot']) {
        console.error(`❌ Failed to get user IDs for timeout: ${userLogin} in ${channelLogin}`);
        return;
      }

      const userId = userInfo[userLogin].id;
      const broadcasterId = userInfo[channelLogin].id;
      const botUserId = userInfo['elowardbot'].id;

      console.log(`🔍 Timeout attempt: ${userLogin}(${userId}) in ${channelLogin}(${broadcasterId}) for ${duration}s (bot: ${botUserId})`);

      // Use bot's own token to timeout via Helix API with correct parameters
      const response = await fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${botUserId}`, {
        method: 'POST', 
        headers: {
          'Authorization': `Bearer ${this.currentToken.replace('oauth:', '')}`,
          'Client-Id': process.env.TWITCH_CLIENT_ID || 'your-client-id',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: {
            user_id: userId,
            duration: duration,
            reason: reason
          }
        })
      });

      if (response.ok) {
        console.log(`🔨 Timeout executed: ${userLogin} in ${channelLogin} (${duration}s)`);
      } else {
        const errorData = await response.text();
        console.warn(`⚠️ Timeout failed: ${userLogin} in ${channelLogin} (${response.status}): ${errorData}`);
      }
    } catch (error) {
      console.warn(`⚠️ Timeout error for ${userLogin} in ${channelLogin}:`, error.message);
    }
  }

  // Get Twitch user info for multiple users
  async getTwitchUserInfo(userLogins) {
    try {
      const loginParams = userLogins.map(login => `login=${encodeURIComponent(login)}`).join('&');
      const response = await fetch(`https://api.twitch.tv/helix/users?${loginParams}`, {
        headers: {
          'Authorization': `Bearer ${this.currentToken.replace('oauth:', '')}`,
          'Client-Id': process.env.TWITCH_CLIENT_ID || 'your-client-id'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const userMap = {};
      
      for (const user of data.data || []) {
        userMap[user.login.toLowerCase()] = user;
      }

      return userMap;
    } catch (error) {
      console.error('❌ Failed to get Twitch user info:', error.message);
      return null;
    }
  }

  // Chat command processing (!eloward commands)
  async handleChatCommand(channelLogin, userLogin, message, event) {
    try {
      // Only broadcaster and moderators can use commands
      if (!this.isUserExempt(userLogin, channelLogin, event, { ignore_roles: 'broadcaster,moderator' })) {
        return;
      }

      const parts = message.toLowerCase().split(' ');
      const command = parts[1];

      switch (command) {
        case 'on':
          await this.updateChannelConfig(channelLogin, { bot_enabled: true });
          console.log(`🔵 ${userLogin} enabled bot in ${channelLogin}`);
          break;

        case 'off':
          await this.updateChannelConfig(channelLogin, { bot_enabled: false });
          console.log(`🔴 ${userLogin} disabled bot in ${channelLogin}`);
          break;

        case 'mode':
          if (parts[2] === 'has_rank') {
            await this.updateChannelConfig(channelLogin, { enforcement_mode: 'has_rank' });
            console.log(`⚙️ ${userLogin} set mode to has_rank in ${channelLogin}`);
          } else if (parts[2] === 'min_rank') {
            await this.updateChannelConfig(channelLogin, {
              enforcement_mode: 'min_rank',
            });
            console.log(`⚙️ ${userLogin} set mode to min_rank in ${channelLogin}`);
          }
          break;

        case 'set':
          if (parts[2] === 'timeout') {
            if (parts[2] && !isNaN(parts[2])) {
              const seconds = Math.max(1, Math.min(1209600, parseInt(parts[2])));
              await this.updateChannelConfig(channelLogin, { timeout_seconds: seconds });
              console.log(`⏱️ ${userLogin} set timeout to ${seconds}s in ${channelLogin}`);
            }
          } else if (parts[2] === 'min_rank' && parts[3] && parts[4]) {
            const tier = parts[3].toUpperCase();
            const division = parts[4].toUpperCase();
            await this.updateChannelConfig(channelLogin, {
              min_rank_tier: tier,
              min_rank_division: division
            });
            console.log(`⚙️ ${userLogin} set minrank ${tier} ${division} in ${channelLogin}`);
          } else if (parts[2] === 'reason') {
            const reason = parts[3].replace(/"/g, '');
            await this.updateChannelConfig(channelLogin, { reason_template: reason });
            console.log(`⚙️ ${userLogin} set reason to ${reason} in ${channelLogin}`);
          }
          break;

        default:
          console.log(`❓ Unknown command from ${userLogin} in ${channelLogin}: ${message}`);
      }
    } catch (error) {
      console.error(`❌ Chat command error from ${userLogin} in ${channelLogin}:`, error.message);
    }
  }

  // HMAC-secured config update
  async updateChannelConfig(channelLogin, updates) {
    try {
      const path = '/bot/config-update';
      const body = JSON.stringify({
        channel_login: channelLogin,
        fields: updates
      });
      const headers = this.signRequest('POST', path, body);
      
      const response = await fetch(`${this.WORKER_URL}${path}`, {
        method: 'POST',
        headers,
        body
      });

      if (response.ok) {
        // Invalidate local cache so next message gets fresh config
        this.configCache.delete(channelLogin);
        console.log(`✅ Config updated for ${channelLogin}:`, updates);
      } else {
        console.warn(`Config update failed for ${channelLogin}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Config update error for ${channelLogin}:`, error.message);
    }
  }

  // Channel loading from Worker with dual connection distribution (75-80 channels each)
  async loadChannels() {
    try {
      console.log('📡 Loading channels from Worker (always-on presence model)...');
      const response = await fetch(`${this.WORKER_URL}/channels`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const { channels } = await response.json();
      console.log(`📋 Found ${channels.length} total channels to join`);
      
      // Distribute channels across both connections (max 80 per connection per README)
      const primaryChannels = channels.slice(0, this.maxChannelsPerConnection);
      const secondaryChannels = channels.slice(this.maxChannelsPerConnection, this.maxChannelsPerConnection * 2);
      
      console.log(`🎯 Joining ${primaryChannels.length} channels on primary connection with anti-spam throttling...`);
      
      // Join channels on primary connection with conservative rate limiting
      for (let i = 0; i < primaryChannels.length; i++) {
        const channel = primaryChannels[i];
        this.primaryBot.join(`#${channel}`);
        this.channels.set(channel, { primary: true, secondary: false });
        console.log(`📥 Joined (primary): #${channel} (${i + 1}/${primaryChannels.length})`);
        
        // Conservative rate limit: 15 joins per 10 seconds = 667ms between joins
        // This prevents Twitch spam detection while maintaining reasonable startup time
        await new Promise(resolve => setTimeout(resolve, 667));
        
        // Progress logging every 10 channels
        if ((i + 1) % 10 === 0) {
          console.log(`📊 Primary connection progress: ${i + 1}/${primaryChannels.length} channels joined`);
        }
      }
      
      if (secondaryChannels.length > 0) {
        console.log(`🎯 Joining ${secondaryChannels.length} channels on secondary connection...`);
        
        // Join channels on secondary connection with rate limiting
        for (let i = 0; i < secondaryChannels.length; i++) {
          const channel = secondaryChannels[i];
          this.secondaryBot.join(`#${channel}`);
          this.channels.set(channel, { 
            primary: this.channels.has(channel) ? this.channels.get(channel).primary : false, 
            secondary: true 
          });
          console.log(`📥 Joined (secondary): #${channel} (${i + 1}/${secondaryChannels.length})`);
          
          // Conservative rate limit: 15 joins per 10 seconds = 667ms between joins
          await new Promise(resolve => setTimeout(resolve, 667));
          
          // Progress logging every 10 channels
          if ((i + 1) % 10 === 0) {
            console.log(`📊 Secondary connection progress: ${i + 1}/${secondaryChannels.length} channels joined`);
          }
        }
      }
      
      console.log(`✅ Joined ${channels.length} channels total (${primaryChannels.length} primary, ${secondaryChannels.length} secondary)`);
      console.log(`⏰ Channel joining completed in ~${Math.ceil(channels.length * 667 / 1000)} seconds with anti-spam throttling`);
    } catch (error) {
      console.error('❌ Failed to load channels:', error.message);
      console.log('⚠️ Bot will continue with empty channel list');
    }
  }

  // Reload channels with dual connection support - join new, leave removed
  async reloadChannels() {
    try {
      console.log('🔍 Reloading channel list...');
      const response = await fetch(`${this.WORKER_URL}/channels`);
      
      if (!response.ok) {
        console.log(`⚠️ Channel reload failed: HTTP ${response.status}`);
        return;
      }
      
      const { channels: newChannels } = await response.json();
      const newChannelSet = new Set(newChannels);
      const currentChannels = Array.from(this.channels.keys());
      
      const channelsToJoin = newChannels.filter(channel => !this.channels.has(channel));
      const channelsToLeave = currentChannels.filter(channel => !newChannelSet.has(channel));
      
      // Join new channels with dual connection distribution
        for (const channel of channelsToJoin) {
        const primaryChannelCount = Array.from(this.channels.values()).filter(c => c.primary).length;
        const usePrimary = primaryChannelCount < this.maxChannelsPerConnection;
        
        if (usePrimary) {
          this.primaryBot.join(`#${channel}`);
          this.channels.set(channel, { primary: true, secondary: false });
          console.log(`📥 Joined (primary): #${channel}`);
        } else {
          this.secondaryBot.join(`#${channel}`);
          this.channels.set(channel, { primary: false, secondary: true });
          console.log(`📥 Joined (secondary): #${channel}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Leave removed channels from both connections
        for (const channel of channelsToLeave) {
        const channelInfo = this.channels.get(channel);
        if (channelInfo?.primary) {
          this.primaryBot.part(`#${channel}`);
        }
        if (channelInfo?.secondary) {
          this.secondaryBot.part(`#${channel}`);
        }
        this.channels.delete(channel);
        console.log(`📤 Left: #${channel}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      if (channelsToJoin.length === 0 && channelsToLeave.length === 0) {
        console.log('✅ No channel changes detected');
      } else {
        const primaryCount = Array.from(this.channels.values()).filter(c => c.primary).length;
        const secondaryCount = Array.from(this.channels.values()).filter(c => c.secondary).length;
        console.log(`🔄 Channel reload complete. Now in ${this.channels.size} channels (${primaryCount} primary, ${secondaryCount} secondary)`);
      }
      
    } catch (error) {
      console.error('❌ Channel reload failed:', error.message);
    }
  }

  // Redis subscription for instant config updates (1-3s propagation)
  startRedisSubscription() {
    if (!this.redis) {
      console.log('⚠️ Redis not configured - using polling fallback only');
      return;
    }

    console.log('🔄 Starting Redis subscription for instant config updates...');
    
    this.redis.connect().then(() => {
      console.log('✅ Connected to Redis for instant notifications');
      
      this.redis.subscribe('eloward:config:updates');
      
      this.redis.on('message', async (channel, message) => {
        if (channel === 'eloward:config:updates') {
          try {
            const data = JSON.parse(message);
            console.log('⚡ Redis config update:', data.type, data.channel_login);
            
            if (data.type === 'config_update' && data.channel_login) {
              // Invalidate cache for instant effect
              const hadCache = this.configCache.has(data.channel_login);
              this.configCache.delete(data.channel_login);
              console.log(`🗑️  Cache invalidated for ${data.channel_login} (had cache: ${hadCache}, fields: ${JSON.stringify(data.fields)})`);
              
              // Check if this affects channel membership
              if (data.fields?.bot_enabled !== undefined) {
                console.log('🚀 Instant channel membership change:', data.channel_login, data.fields.bot_enabled);
                setTimeout(() => this.reloadChannels(), 1000);
              }
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
      console.log('⚠️ Continuing with polling-based updates only');
    });
  }

  // Self-healing config sweep (every 60-120s)
  startConfigSweep() {
    const sweepInterval = 90000 + Math.random() * 30000; // 90-120s with jitter
    
    this.configSweepInterval = setInterval(() => {
      console.log('🧹 Running config sweep for cache consistency...');
      
      // Clear expired rank cache entries (config cache is permanent - Redis managed)
      const now = Date.now();
      
      for (const [key, cached] of this.rankCache.entries()) {
        if (now >= cached.expires) {
          this.rankCache.delete(key);
        }
      }
      
      console.log(`🧹 Config sweep complete. Cache sizes: config=${this.configCache.size} (permanent), rank=${this.rankCache.size}`);
    }, sweepInterval);
    
    console.log(`🧹 Config sweep started (${Math.round(sweepInterval/1000)}s interval)`);
  }
}

// Graceful shutdown with dual connection support
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  if (bot?.redis) bot.redis.disconnect();
  if (bot?.primaryBot) bot.primaryBot.quit('Server shutdown');
  if (bot?.secondaryBot) bot.secondaryBot.quit('Server shutdown');
  if (bot?.tokenCheckInterval) clearInterval(bot.tokenCheckInterval);
  if (bot?.configSweepInterval) clearInterval(bot.configSweepInterval);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Interrupted - shutting down gracefully...');
  if (bot?.redis) bot.redis.disconnect();
  if (bot?.primaryBot) bot.primaryBot.quit('Server shutdown');
  if (bot?.secondaryBot) bot.secondaryBot.quit('Server shutdown');
  if (bot?.tokenCheckInterval) clearInterval(bot.tokenCheckInterval);
  if (bot?.configSweepInterval) clearInterval(bot.configSweepInterval);
  process.exit(0);
});

// Start the production bot
console.log('🚀 Starting EloWard Production Bot...');
const bot = new EloWardTwitchBot();
bot.start().catch(error => {
  console.error('💥 Bot startup failed:', error);
  process.exit(1);
});
