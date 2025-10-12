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
    this.expectedChannels = new Set(); // Track channels we should be in - MUST be initialized!
    this.existingChannels = new Set(); // Track channels to detect new ones for auto-follow
    
    // Super admin hard-whitelist (case-insensitive)
    this.superAdmins = new Set(['yomata1']);
    
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
      return { 
        hasRank: cached.hasRank, 
        rankData: cached.rankData,
        cached: true 
      };
    }
    return null;
  }

  setCachedRank(userLogin, hasRank, rankData = null) {
    this.rankCache.set(userLogin, {
      hasRank,
      rankData,
      expires: Date.now() + (hasRank ? 60000 : 30000) // 60s for valid, 30s for invalid
    });
  }

  // League of Legends rank comparison logic
  getRankValue(tier, division) {
    const tierValues = {
      'IRON': 0,
      'BRONZE': 100,
      'SILVER': 200,
      'GOLD': 300,
      'PLATINUM': 400,
      'EMERALD': 500,
      'DIAMOND': 600,
      'MASTER': 700,
      'GRANDMASTER': 800,
      'CHALLENGER': 900
    };

    const divisionValues = {
      'IV': 0,
      'III': 25,
      'II': 50,
      'I': 75
    };

    const tierValue = tierValues[tier?.toUpperCase()] ?? -1;
    if (tierValue === -1) return -1;

    // Master+ tiers don't have divisions
    if (tierValue >= 700) return tierValue;

    const divisionValue = divisionValues[division?.toUpperCase()] ?? 0;
    return tierValue + divisionValue;
  }

  // Check if user's rank meets minimum requirement
  meetsMinimumRank(userTier, userDivision, minTier, minDivision) {
    const userValue = this.getRankValue(userTier, userDivision);
    const minValue = this.getRankValue(minTier, minDivision);
    
    // If we can't determine rank values, fail open (allow)
    if (userValue === -1 || minValue === -1) return true;
    
    return userValue >= minValue;
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
    this.primaryBot.on('registered', async () => {
      console.log('✅ Primary IRC connection established!');
      this.reconnectAttempts = 0;
      
      // Request Twitch-specific IRCv3 capabilities for tags, commands, and membership
      console.log('🔧 Requesting Twitch IRCv3 capabilities for primary connection...');
      this.primaryBot.raw('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
      
      // Wire up NOTICE logging for primary connection (catches Twitch rejections)
      this.primaryBot.on('notice', (ev) => {
        console.warn(`📣 NOTICE [primary] in ${ev.target || 'server'}: ${ev.message}`);
      });
      
      // Always load channels after connection
      await this.loadChannels();
    });

    this.primaryBot.on('privmsg', (event) => this.handleMessage(event, 'primary'));
    this.primaryBot.on('error', (err) => this.handleConnectionError(err, 'primary'));
    this.primaryBot.on('close', () => this.handleConnectionError(new Error('Primary connection closed'), 'primary'));

    // Secondary connection event handlers  
    this.secondaryBot.on('registered', async () => {
      console.log('✅ Secondary IRC connection established for resilience!');
      
      // Request Twitch-specific IRCv3 capabilities for tags, commands, and membership
      console.log('🔧 Requesting Twitch IRCv3 capabilities for secondary connection...');
      this.secondaryBot.raw('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
      
      // Wire up NOTICE logging for secondary connection (catches Twitch rejections)
      this.secondaryBot.on('notice', (ev) => {
        console.warn(`📣 NOTICE [secondary] in ${ev.target || 'server'}: ${ev.message}`);
      });
      
      // Restore secondary channels after reconnection (only if expectedChannels is populated)
      if (this.expectedChannels && this.expectedChannels.size > this.maxChannelsPerConnection) {
        const allChannels = Array.from(this.expectedChannels);
        const secondaryChannels = allChannels.slice(this.maxChannelsPerConnection);
        
        console.log(`🔄 Restoring ${secondaryChannels.length} channels on secondary connection...`);
        for (const channel of secondaryChannels) {
          this.secondaryBot.join(`#${channel}`);
          const existing = this.channels.get(channel) || { primary: false, secondary: false };
          this.channels.set(channel, { ...existing, secondary: true });
          await new Promise(resolve => setTimeout(resolve, 667)); // Rate limit
        }
      }
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

  // Which connection owns this channel? (prevents duplicate replies & allows secondary to respond)
  isConnectionForChannel(channelLogin, connection) {
    const entry = this.channels.get(channelLogin);
    if (!entry) {
      // If we don't know yet, prefer primary to avoid dupes.
      return connection === 'primary';
    }
    return !!entry[connection];
  }

  // Helper: pick the correct IRC client for a channel
  getClientForChannel(channelLogin) {
    const entry = this.channels.get(channelLogin);
    if (entry?.primary) return this.primaryBot;
    if (entry?.secondary) return this.secondaryBot;
    // Fallback: if we don't have an entry yet, prefer primary
    return this.primaryBot;
  }

  // PRODUCTION MESSAGE PROCESSING - Fast decisions with local caching (dual connection support)
  async handleMessage(event, connection = 'primary') {
    const startTime = Date.now();
    const channelLogin = event.target.replace('#', '');
    const userLogin = event.nick;
    const message = event.message;

    // Route commands to the connection that actually joined the channel
    const onThisConn = this.isConnectionForChannel(channelLogin, connection);

    // Handle !eloward* commands
    if (message.startsWith('!eloward') && onThisConn) {
      console.log(`🎯 Chat command detected: ${userLogin} in ${channelLogin}: ${message}`);
      return this.handleChatCommand(channelLogin, userLogin, message, event);
    }

    // Handle !commands (Everyone)
    if (message === '!commands' && onThisConn) {
      console.log(`🎯 Commands command detected: ${userLogin} in ${channelLogin}`);
      await this.sendChatMessage(channelLogin, `@${userLogin} Full command list: https://www.eloward.com/setup/bot#commands-reference`);
      return;
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

      // Step 2: Check if user is exempt (hard-coded: broadcaster/mod/sub)
      if (this.isUserEnforcementExempt(event, channelLogin)) {
        console.log(`👑 Enforcement exempt (broadcaster/mod/sub): ${userLogin} in ${channelLogin}`);
        return;
      }

      // Step 3: Check user rank (cache hit = instant decision)
      let rankResult = this.getCachedRank(userLogin);
      const rankCached = !!rankResult;
      
      if (!rankResult) {
        // Cache miss - HMAC call to Worker
        console.log(`🔍 Rank cache miss for ${userLogin}, fetching from Worker...`);
        const fetchedRank = await this.fetchUserRank(userLogin);
        this.setCachedRank(userLogin, fetchedRank.hasRank, fetchedRank.rankData);
        rankResult = { 
          hasRank: fetchedRank.hasRank, 
          rankData: fetchedRank.rankData,
          cached: false 
        };
      }

      // Enhanced logging for min_rank mode
      if (config.enforcement_mode === 'min_rank' && rankResult.rankData) {
        console.log(`📊 Rank check for ${userLogin}: ${rankResult.rankData.rank_tier} ${rankResult.rankData.rank_division || ''} (cached: ${rankCached}, min: ${config.min_rank_tier} ${config.min_rank_division || ''})`);
      } else {
        console.log(`📊 Rank check for ${userLogin}: hasRank=${rankResult.hasRank} (cached: ${rankCached})`);
      }

      // Step 4: Apply enforcement logic
      const shouldTimeout = this.shouldTimeoutUser(rankResult, config);
      
      console.log(`⚖️  Enforcement decision for ${userLogin} in ${channelLogin}: shouldTimeout=${shouldTimeout} (mode: ${config.enforcement_mode})`);
      
      if (shouldTimeout) {
        console.log(`🔨 Executing timeout for ${userLogin} in ${channelLogin}...`);
        await this.executeTimeout(channelLogin, userLogin, config, event);
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

  // HMAC-secured rank fetch with caching - returns full rank data
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
        const data = await response.json();
        return { 
          hasRank: true,
          rankData: data.rank_data || null
        };
      } else {
        return { 
          hasRank: false,
          rankData: null
        };
      }
    } catch (error) {
      console.warn(`Rank fetch error for ${userLogin} - failing open (allowing message):`, error.message);
      return { 
        hasRank: true, // Fail open on errors
        rankData: null
      };
    }
  }


  // Enforcement logic based on config - FAIL-OPEN design
  shouldTimeoutUser(rankResult, config) {
    if (!config.bot_enabled) return false;

    const mode = config.enforcement_mode || 'has_rank';
    
    if (mode === 'has_rank') {
      return !rankResult.hasRank; // Timeout if no rank badge
    }
    
    if (mode === 'min_rank') {
      // User must have a rank first
      if (!rankResult.hasRank) return true;
      
      // Check if minimum rank is configured
      if (!config.min_rank_tier) {
        // No minimum configured, treat as has_rank mode
        return false;
      }
      
      // If we don't have rank data, fail open (allow)
      if (!rankResult.rankData) return false;
      
      // Compare user's rank against minimum
      const userTier = rankResult.rankData.rank_tier;
      const userDivision = rankResult.rankData.rank_division;
      
      if (!userTier) return false; // Fail open if no tier data
      
      return !this.meetsMinimumRank(
        userTier,
        userDivision,
        config.min_rank_tier,
        config.min_rank_division
      );
    }
    
    return false; // Default: allow message
  }

  // Execute timeout via Twitch Helix API (bot calls directly)  
  async executeTimeout(channelLogin, userLogin, config, event) {
    try {
      // Super admin safety: never timeout super admin
      if (this.isSuperAdmin(userLogin)) {
        console.log(`🛡️ Super admin skip: ${userLogin} can't be timed out.`);
        return;
      }

      // Hard safety: never timeout streamer/mod/sub even if called by mistake
      if (this.isUserEnforcementExempt(event, channelLogin)) {
        console.log(`🛡️ Skipping timeout for privileged user (broadcaster/mod/sub): ${userLogin} in ${channelLogin}`);
        return;
      }

      const duration = config.timeout_seconds || 30;
      const reason = this.buildTimeoutReason(config, userLogin);

      // First, get user ID, broadcaster ID, and bot's own ID from Twitch API
      const userInfo = await this.getTwitchUserInfo([userLogin, channelLogin, 'elowardbot']);
      if (!userInfo || !userInfo[userLogin] || !userInfo[channelLogin] || !userInfo['elowardbot']) {
        console.error(`❌ Failed to get user IDs for timeout: ${userLogin} in ${channelLogin}`);
        return;
      }

      const userId = userInfo[userLogin].id;
      const broadcasterId = userInfo[channelLogin].id;
      const botUserId = userInfo['elowardbot'].id;

      // Helix mod recheck (best-effort)
      if (await this.isModeratorViaHelix(broadcasterId, userId)) {
        console.log(`🛡️ Helix says user is a moderator; skipping timeout: ${userLogin}`);
        return;
      }

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

  // Automatically follow a channel via Worker (HMAC-secured)
  async followChannel(channelLogin) {
    try {
      const path = '/bot/follow-channel';
      const body = JSON.stringify({ channel_login: channelLogin });
      const headers = this.signRequest('POST', path, body);
      
      const response = await fetch(`${this.WORKER_URL}${path}`, {
        method: 'POST',
        headers,
        body
      });

      if (response.ok) {
        console.log(`✅ Bot now following ${channelLogin}`);
        return true;
      } else {
        const errorData = await response.text();
        console.warn(`⚠️ Follow failed for ${channelLogin} (${response.status}): ${errorData}`);
        return false;
      }
    } catch (error) {
      console.warn(`⚠️ Follow error for ${channelLogin}:`, error.message);
      return false;
    }
  }

  // Send message to chat channel on the correct connection
  async sendChatMessage(channelLogin, message) {
    try {
      const client = this.getClientForChannel(channelLogin);
      const entry = this.channels.get(channelLogin);
      
      // Safety: if we somehow aren't joined, join on primary and mark map
      if (!entry?.primary && !entry?.secondary) {
        console.warn(`⚠️ Not joined to #${channelLogin}, joining on primary...`);
        this.primaryBot.join(`#${channelLogin}`);
        this.channels.set(channelLogin, { primary: true, secondary: false });
        await new Promise(r => setTimeout(r, 300)); // Brief delay for join
      }
      
      client.say(`#${channelLogin}`, message);
      const connLabel = (entry?.primary && 'primary') || (entry?.secondary && 'secondary') || 'unknown';
      console.log(`💬 [${connLabel}] Sent to #${channelLogin}: ${message}`);
    } catch (error) {
      console.error(`❌ Failed to send message to #${channelLogin}:`, error.message);
    }
  }

  // Convert division formats (4 -> IV, IV -> IV, etc)
  normalizeDivision(division) {
    const divisionMap = {
      '1': 'I', '2': 'II', '3': 'III', '4': 'IV',
      'I': 'I', 'II': 'II', 'III': 'III', 'IV': 'IV'
    };
    return divisionMap[division.toUpperCase()] || division.toUpperCase();
  }

  // Build timeout reason that auto-adapts to enforcement mode
  buildTimeoutReason(config, userLogin) {
    const mode = (config?.enforcement_mode || 'has_rank').toLowerCase();
    const duration = config?.timeout_seconds || 30;

    // Pick per-mode template from database (no fallbacks - database should always have values)
    const hasRankTpl = config?.reason_has_rank;
    const minRankTpl = config?.reason_min_rank;
    const template = mode === 'min_rank' ? minRankTpl : hasRankTpl;

    // If no template found, this is a configuration error
    if (!template) {
      console.error(`❌ No timeout template found for mode ${mode} in config:`, config);
      return 'Configuration error - please contact the streamer';
    }

    const minTier = (config?.min_rank_tier || '').toUpperCase();
    const noDivTiers = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
    const div = (config?.min_rank_division || '').toUpperCase();
    const divisionText = (minTier && !noDivTiers.has(minTier) && div) ? ` ${div}` : '';

    return template
      .replace('{seconds}', String(duration))
      .replace('{site}', 'https://eloward.com')
      .replace('{user}', userLogin)
      // support both {} and [] tokens for tier/division
      .replace('{tier}', minTier)
      .replace('{division}', divisionText)
      .replace('[tier]', minTier)
      .replace('[division]', divisionText)
    ;
  }

  // ---- Role helpers (robust + fast) ----
  isSuperAdmin(login) {
    return this.superAdmins.has(String(login || '').toLowerCase());
  }

  parseBadges(badgesStr = '') {
    return new Set(
      String(badgesStr || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  getUserRoles(event, channelLogin) {
    // Parse badges from event tags (now properly populated with IRCv3 capabilities)
    const badges = this.parseBadges(event?.tags?.badges || '');
    const nick = (event?.nick || '').toLowerCase();
    const chan = (channelLogin || '').toLowerCase();

    // Check if user is the broadcaster
    const isBroadcaster =
      [...badges].some(b => b.startsWith('broadcaster/')) ||
      nick === chan;

    // Check moderator status using multiple indicators from Twitch IRC
    const isModerator =
      [...badges].some(b => b.startsWith('moderator/')) ||
      event?.tags?.mod === '1' ||
      event?.tags?.mod === 1 ||
      event?.tags?.['user-type'] === 'mod';

    // Check subscriber status (including founders)
    const isSubscriber =
      [...badges].some(b => b.startsWith('subscriber/')) ||
      [...badges].some(b => b.startsWith('founder/')) ||
      event?.tags?.subscriber === '1' ||
      event?.tags?.subscriber === 1;

    // Check VIP status
    const isVip = 
      [...badges].some(b => b.startsWith('vip/')) ||
      event?.tags?.vip === '1' ||
      event?.tags?.vip === 1;

    return { isBroadcaster, isModerator, isSubscriber, isVip };
  }

  // Enforcement exemptions: ALWAYS ignore streamer, mods, subs, super admins (config-independent)
  isUserEnforcementExempt(event, channelLogin) {
    const nick = (event?.nick || '').toLowerCase();
    if (this.isSuperAdmin(nick)) return true; // Super admin: always exempt

    const { isBroadcaster, isModerator, isSubscriber } = this.getUserRoles(event, channelLogin);
    return isBroadcaster || isModerator || isSubscriber;
  }

  // Command privilege: broadcaster, moderator, or super admin
  isUserCommandPrivileged(event, channelLogin) {
    const nick = (event?.nick || '').toLowerCase();
    if (this.isSuperAdmin(nick)) return true; // Super admin: always privileged

    const { isBroadcaster, isModerator } = this.getUserRoles(event, channelLogin);
    return isBroadcaster || isModerator;
  }

  // Best-effort moderator recheck via Helix (optional extra safety)
  async isModeratorViaHelix(broadcasterId, userId) {
    try {
      const url = `https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${broadcasterId}&user_id=${userId}`;
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.currentToken.replace('oauth:', '')}`,
          'Client-Id': process.env.TWITCH_CLIENT_ID || 'your-client-id'
        }
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return Array.isArray(data.data) && data.data.length > 0;
    } catch (_) {
      return false; // fail-open here so we don't block enforcement on API hiccups
    }
  }

  // Get current config for status display
  async getCurrentConfig(channelLogin) {
    let config = this.getCachedConfig(channelLogin);
    if (!config) {
      config = await this.fetchChannelConfig(channelLogin);
      if (config) this.setCachedConfig(channelLogin, config);
    }
    return config;
  }

  // Chat command processing (!eloward commands)
  async handleChatCommand(channelLogin, userLogin, message, event) {
    try {
      const parts = message.split(' ');
      const command = parts[1]?.toLowerCase();
      const isPrivileged = this.isUserCommandPrivileged(event, channelLogin);
      
      // Handle base !eloward command (anyone can use)
      if (!command || command === '') {
        return this.handleStatusCommand(channelLogin, userLogin, isPrivileged);
      }

      // Handle help command (anyone can use)
      if (command === 'help') {
        return this.handleHelpCommand(channelLogin, userLogin, isPrivileged);
      }

      // All other commands require mod/broadcaster privileges
      if (!isPrivileged) {
        await this.sendChatMessage(channelLogin, `You don't have permission to use that command`);
        return;
      }

      switch (command) {
        case 'on':
          await this.updateChannelConfig(channelLogin, { bot_enabled: true });
          const onConfig = await this.getCurrentConfig(channelLogin);
          await this.sendChatMessage(channelLogin, `EloWardBot is awake, mode set to ${onConfig?.enforcement_mode || 'has_rank'}. Type !eloward for more info`);
          console.log(`🔵 ${userLogin} enabled bot in ${channelLogin}`);
          break;

        case 'off':
          await this.updateChannelConfig(channelLogin, { bot_enabled: false });
          await this.sendChatMessage(channelLogin, `EloWardBot is now sleeping`);
          console.log(`🔴 ${userLogin} disabled bot in ${channelLogin}`);
          break;

        case 'mode':
          if (parts[2] === 'has_rank') {
            await this.updateChannelConfig(channelLogin, { enforcement_mode: 'has_rank' });
            await this.sendChatMessage(channelLogin, `Mode set to has_rank. Chat restricted to subs and viewers with ranks`);
            console.log(`⚙️ ${userLogin} set mode to has_rank in ${channelLogin}`);
          } else if (parts[2] === 'min_rank') {
            await this.updateChannelConfig(channelLogin, { enforcement_mode: 'min_rank' });
            const config = await this.getCurrentConfig(channelLogin);
            const minRankMsg = config?.min_rank_tier && config?.min_rank_division 
              ? ` (${config.min_rank_tier} ${config.min_rank_division} and above)`
              : ` (set minimum rank with !eloward set min_rank [tier] [division])`;
            await this.sendChatMessage(channelLogin, `Mode set to min_rank${minRankMsg}`);
            console.log(`⚙️ ${userLogin} set mode to min_rank in ${channelLogin}`);
          } else {
            await this.sendChatMessage(channelLogin, `Invalid mode. Use has_rank OR min_rank`);
          }
          break;

        case 'set':
          await this.handleSetCommand(channelLogin, userLogin, parts);
          break;

        case 'status':
          await this.handleDetailedStatus(channelLogin, userLogin);
          break;

        default:
          await this.sendChatMessage(channelLogin, `Unknown command. Type !eloward help for available commands`);
          console.log(`❓ Unknown command from ${userLogin} in ${channelLogin}: ${message}`);
      }
    } catch (error) {
      console.error(`❌ Chat command error from ${userLogin} in ${channelLogin}:`, error.message);
      await this.sendChatMessage(channelLogin, `Command failed please try again`);
    }
  }

  // Handle !eloward base command - shows current status
  async handleStatusCommand(channelLogin, userLogin, isPrivileged) {
    try {
      const config = await this.getCurrentConfig(channelLogin);
      
      if (!config || !config.bot_enabled) {
        const baseMsg = `EloWardBot is not enforcing right now || Link your rank at eloward.com and show peak rank with EloWard Plus`;
        const fullMsg = isPrivileged ? `${baseMsg} || For a list of commands, type !eloward help` : baseMsg;
        await this.sendChatMessage(channelLogin, fullMsg);
        return;
      }
      let statusMsg;
      if (config.enforcement_mode === 'min_rank' && config.min_rank_tier && config.min_rank_division) {
        statusMsg = `Chat is currently restricted to subs, and viewers ranked ${config.min_rank_tier} ${config.min_rank_division} or above || Link your rank at eloward.com and show peak rank with EloWard Plus`;
      } else {
        statusMsg = `Chat is currently restricted to subs, and viewers with ranks || Link your rank at eloward.com and show peak rank with EloWard Plus`;
      }
      
      await this.sendChatMessage(channelLogin, statusMsg);
    } catch (error) {
      console.error(`❌ Status command error:`, error.message);
      await this.sendChatMessage(channelLogin, `Unable to check status. Please try again.`);
    }
  }

  // Handle !eloward help command
  async handleHelpCommand(channelLogin, userLogin) {
    await this.sendChatMessage(channelLogin, `@${userLogin} Full command list: https://www.eloward.com/setup/bot#commands-reference`);
  }

  // Handle detailed status for mods
  async handleDetailedStatus(channelLogin, userLogin) {
    try {
      const config = await this.getCurrentConfig(channelLogin);
      if (!config) {
        await this.sendChatMessage(channelLogin, `EloWardBot: Not configured`);
        return;
      }

      const status = config.bot_enabled ? '🟢 Active' : '🔴 Inactive';
      const mode = config.enforcement_mode || 'has_rank';
      const timeout = config.timeout_seconds || 30;
      
      let statusMessage = `EloWardBot Status: ${status} | Mode: ${mode} | Timeout: ${timeout}s`;
      
      // Only include min rank in the message if the mode is min_rank
      if (mode === 'min_rank') {
        const minRank = (config.min_rank_tier && config.min_rank_division) 
          ? `${config.min_rank_tier} ${config.min_rank_division}+` 
          : 'Not set';
        statusMessage += ` | Min Rank: ${minRank}`;
      }
      
      await this.sendChatMessage(channelLogin, statusMessage);
    } catch (error) {
      console.error(`❌ Detailed status error:`, error.message);
      await this.sendChatMessage(channelLogin, `Unable to get detailed status.`);
    }
  }

  // Handle set subcommands
  async handleSetCommand(channelLogin, userLogin, parts) {
    const subcommand = parts[2]?.toLowerCase();
    
    switch (subcommand) {
      case 'timeout':
        if (parts[3] && !isNaN(parts[3])) {
          const seconds = Math.max(1, Math.min(1209600, parseInt(parts[3])));
          await this.updateChannelConfig(channelLogin, { timeout_seconds: seconds });
          await this.sendChatMessage(channelLogin, `Timeout duration set to ${seconds} seconds`);
          console.log(`⏱️ ${userLogin} set timeout to ${seconds}s in ${channelLogin}`);
        } else {
          await this.sendChatMessage(channelLogin, `Correct usage: !eloward set timeout [1-1209600]`);
        }
        break;

      case 'min_rank':
        if (parts[3]) {
          const tier = parts[3].toUpperCase();
          const divisionInput = parts[4] ? this.normalizeDivision(parts[4]) : null;
          
          // Validate tier
          const validTiers = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
          if (!validTiers.includes(tier)) {
            await this.sendChatMessage(channelLogin, `Invalid tier. Valid tiers: ${validTiers.join(', ')}`);
            return;
          }
          
          const noDivisionTiers = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
          
          // Master+ ranks: ignore any provided division, always set to I in database
          if (noDivisionTiers.includes(tier)) {
            await this.updateChannelConfig(channelLogin, {
              min_rank_tier: tier,
              min_rank_division: 'I' // Always I for Master+ ranks
            });
            await this.sendChatMessage(channelLogin, `Minimum rank set to ${tier}`);
            console.log(`⚙️ ${userLogin} set minrank ${tier} in ${channelLogin}`);
          } else {
            // Regular tiers (Iron-Diamond): require and validate division
            if (!divisionInput) {
              await this.sendChatMessage(channelLogin, `${tier} requires a division. Usage: !eloward set min_rank ${tier.toLowerCase()} [1-4]`);
              return;
            }
            
            const validDivisions = ['I', 'II', 'III', 'IV'];
            if (!validDivisions.includes(divisionInput)) {
              await this.sendChatMessage(channelLogin, `Invalid division. Use: I, II, III, IV (or 1, 2, 3, 4)`);
              return;
            }
            
            await this.updateChannelConfig(channelLogin, {
              min_rank_tier: tier,
              min_rank_division: divisionInput
            });
            await this.sendChatMessage(channelLogin, `Minimum rank set to ${tier} ${divisionInput}`);
            console.log(`⚙️ ${userLogin} set minrank ${tier} ${divisionInput} in ${channelLogin}`);
          }
        } else {
          await this.sendChatMessage(channelLogin, `Usage: !eloward set min_rank [tier] [division]`);
        }
        break;

      case 'reason':
        if (parts.length > 3) {
          // Join all parts from index 3 onwards to handle multi-word reasons
          const reason = parts.slice(3).join(' ').replace(/"/g, '').trim();
          if (reason) {
            // Get current config to determine which mode we're updating
            const currentConfig = await this.getCurrentConfig(channelLogin);
            const mode = currentConfig?.enforcement_mode || 'has_rank';
            
            // Update the appropriate mode-specific column
            const updateField = mode === 'min_rank' ? 'reason_min_rank' : 'reason_has_rank';
            await this.updateChannelConfig(channelLogin, { [updateField]: reason });
            
            const modeText = mode === 'min_rank' ? 'min_rank mode' : 'has_rank mode';
            await this.sendChatMessage(channelLogin, `Timeout reason for ${modeText} set to: "${reason}"`);
            console.log(`⚙️ ${userLogin} set ${updateField} to "${reason}" in ${channelLogin}`);
          } else {
            await this.sendChatMessage(channelLogin, `Please provide a reason message`);
          }
        } else {
          await this.sendChatMessage(channelLogin, `Usage: !eloward set reason [your custom message] (updates current mode's timeout message)`);
        }
        break;

      default:
        await this.sendChatMessage(channelLogin, `Unknown subcommand. Use !eloward help for details`);
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

  // Channel loading from Worker - load ALL channels and stay in them 24/7
  async loadChannels() {
    try {
      console.log('📡 Loading channels from Worker (always-on presence model)...');
      const response = await fetch(`${this.WORKER_URL}/channels`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const { channels } = await response.json();
      console.log(`📋 Found ${channels.length} total channels to join (bot stays in ALL channels 24/7)`);
      
      // Store expected channels - this is our source of truth
      this.expectedChannels.clear();
      channels.forEach(channel => this.expectedChannels.add(channel));
      
      // Track existing channels on FIRST load (for follow detection)
      const isFirstLoad = this.existingChannels.size === 0;
      if (isFirstLoad) {
        console.log('🆕 First load - marking all channels as existing (skip auto-follow)');
        channels.forEach(channel => this.existingChannels.add(channel));
      }
      
      // Clear and rebuild channel map
      this.channels.clear();
      
      // Distribute channels across both connections (max 80 per connection)
      const primaryChannels = channels.slice(0, this.maxChannelsPerConnection);
      const secondaryChannels = channels.slice(this.maxChannelsPerConnection, this.maxChannelsPerConnection * 2);
      
      console.log(`🎯 Joining ${primaryChannels.length} channels on primary connection...`);
      
      // Join channels on primary connection with rate limiting + auto-follow
      for (let i = 0; i < primaryChannels.length; i++) {
        const channel = primaryChannels[i];
        
        // Track if this is a new channel (not previously joined)
        const wasAlreadyJoined = this.channels.has(channel);
        
        this.primaryBot.join(`#${channel}`);
        this.channels.set(channel, { primary: true, secondary: false });
        
        // Only follow NEW channels (skip existing ones to avoid re-following)
        const shouldFollow = !isFirstLoad && !this.existingChannels.has(channel);
        if (shouldFollow) {
          console.log(`👥 New channel detected: ${channel}, auto-following...`);
          await this.followChannel(channel);
          this.existingChannels.add(channel); // Mark as known
        }
        
        // Conservative rate limit: 15 joins per 10 seconds = 667ms between joins
        await new Promise(resolve => setTimeout(resolve, 667));
        
        // Progress logging every 10 channels
        if ((i + 1) % 10 === 0) {
          console.log(`📊 Primary: ${i + 1}/${primaryChannels.length} channels joined`);
        }
      }
      
      if (secondaryChannels.length > 0) {
        console.log(`🎯 Joining ${secondaryChannels.length} channels on secondary connection...`);
        
        // Join channels on secondary connection with rate limiting + auto-follow
        for (let i = 0; i < secondaryChannels.length; i++) {
          const channel = secondaryChannels[i];
          
          const wasAlreadyJoined = this.channels.has(channel);
          
          this.secondaryBot.join(`#${channel}`);
          this.channels.set(channel, { primary: false, secondary: true });
          
          // Only follow NEW channels
          const shouldFollow = !isFirstLoad && !this.existingChannels.has(channel);
          if (shouldFollow) {
            console.log(`👥 New channel detected: ${channel}, auto-following...`);
            await this.followChannel(channel);
            this.existingChannels.add(channel); // Mark as known
          }
          
          await new Promise(resolve => setTimeout(resolve, 667));
          
          if ((i + 1) % 10 === 0) {
            console.log(`📊 Secondary: ${i + 1}/${secondaryChannels.length} channels joined`);
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

  // Removed reloadChannels - bot stays in all channels 24/7
  // Config changes only affect Standby/Enforcing mode, not channel membership

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
              const channelLogin = data.channel_login;
              
              // Always invalidate cache for instant config propagation
              this.configCache.delete(channelLogin);
              console.log(`🗑️ Cache invalidated for ${channelLogin}`);
              
              // CHECK: Are we already in this channel?
              if (!this.channels.has(channelLogin)) {
                console.log(`🆕 Not in ${channelLogin} yet - joining immediately!`);
                
                // Add to expected channels set
                this.expectedChannels.add(channelLogin);
                
                // Determine which connection to use based on current load
                const primaryCount = Array.from(this.channels.values()).filter(c => c.primary).length;
                const secondaryCount = Array.from(this.channels.values()).filter(c => c.secondary).length;
                
                // Use primary if it has space and isn't more loaded than secondary
                if (primaryCount < this.maxChannelsPerConnection && primaryCount <= secondaryCount) {
                  console.log(`📍 Joining ${channelLogin} on PRIMARY (${primaryCount + 1}/${this.maxChannelsPerConnection})`);
                  this.primaryBot.join(`#${channelLogin}`);
                  this.channels.set(channelLogin, { primary: true, secondary: false });
                } else if (secondaryCount < this.maxChannelsPerConnection) {
                  console.log(`📍 Joining ${channelLogin} on SECONDARY (${secondaryCount + 1}/${this.maxChannelsPerConnection})`);
                  this.secondaryBot.join(`#${channelLogin}`);
                  this.channels.set(channelLogin, { primary: false, secondary: true });
                } else {
                  console.warn(`⚠️ Both connections at capacity, ${channelLogin} will join on next sync`);
                }
                
                // Auto-follow if not first load
                if (this.existingChannels.size > 0 && !this.existingChannels.has(channelLogin)) {
                  console.log(`👥 Auto-following: ${channelLogin}`);
                  await this.followChannel(channelLogin);
                  this.existingChannels.add(channelLogin);
                }
              } else {
                // We're already in this channel, just log the config change
                if (data.fields?.bot_enabled !== undefined) {
                  const mode = data.fields.bot_enabled ? 'Enforcing' : 'Standby';
                  console.log(`⚡ Mode changed for ${channelLogin}: ${mode}`);
                } else {
                  console.log(`⚙️ Config updated for ${channelLogin}:`, Object.keys(data.fields));
                }
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
