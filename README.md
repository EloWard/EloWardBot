# EloWard Twitch Bot

A Twitch IRC bot that enforces League of Legends rank requirements in chat using AWS Lightsail for IRC connections and Cloudflare Workers for business logic.

## 🎯 **What It Does**

The EloWardBot monitors Twitch chat and automatically times out users who don't meet minimum rank requirements:

- **Connects to Twitch IRC** and joins configured channels
- **Processes every chat message** from non-privileged users
- **Checks user's League of Legends rank** via the EloWard API
- **Issues timeouts** (via Twitch Helix API) for users without sufficient rank
- **Operates 24/7** with automatic error recovery and token management

## 🏗️ **Architecture Overview**

### **Hybrid Architecture**
```
┌─────────────── CLOUDFLARE WORKERS (Business Logic) ────────────────┐
│                                                                    │
│  🔐 Bot Worker              📊 Rank Worker           👤 Users       │
│  • Token Management         • LoL Rank Lookup        • User Data    │
│  • OAuth Refresh            • Database Queries       • Channels     │
│  • Business Logic           • Service Bindings       • Config       │
│  • Timeout API Calls        • Edge Network           • Storage      │
│                                                                    │
│  💾 KV Storage              🗄️ D1 Database                          │
│  • Bot Tokens               • Channel Configuration                │
│  • Global Replication       • User Ranks & Data                   │
│                                                                    │
└──────────────────┬─────────────────────────────────────────────────┘
                   │ 
                   │ Token Sync API (/token endpoint)
                   │ Message Processing API (/check-message)
                   │ Channel List API (/channels)
                   │
    ┌──────────────▼─────────────────┐
    │         AWS LIGHTSAIL          │
    │                                │
    │  🤖 IRC Bot (Node.js)          │
    │  • Persistent IRC Connection   │
    │  • Message Ingestion          │
    │  • Dynamic Token Management   │
    │  • Error Recovery & Reconnect │
    │                                │
    └────────────────────────────────┘
```

### **Architecture Design**

The system uses a hybrid approach where Cloudflare Workers handle stateless business logic and token management, while AWS Lightsail maintains the persistent IRC connection. This separation allows for optimal platform utilization.

## 🔧 **Components**

### **1. IRC Bot (AWS Lightsail)**
**File**: `bot.js`

- **Purpose**: Maintains persistent connection to Twitch IRC
- **Responsibilities**:
  - Connect to `irc.chat.twitch.tv` with OAuth token
  - Join/leave channels dynamically
  - Process incoming chat messages
  - Forward messages to CF Worker for rank checking
  - Handle connection errors with exponential backoff
  - Monitor token expiration and refresh automatically

**Key Features**:
```javascript
// Dynamic token management
const tokenData = await this.getTokenFromWorker();

// Message processing
this.bot.on('privmsg', this.handleMessage.bind(this));

// Auto-recovery
this.handleConnectionError(error);
```

### **2. Bot Worker (Cloudflare Workers)**
**File**: `Backend/workers/elowardbot/bot-worker.ts`

- **Purpose**: Central business logic and token management
- **Responsibilities**:
  - Store and refresh Twitch OAuth tokens
  - Provide fresh tokens to IRC bot via `/token` endpoint
  - Process messages via `/check-message` endpoint
  - Execute timeouts via Twitch Helix API
  - Manage channel configuration
  - Scheduled maintenance (daily at 3 AM UTC)

**Key Endpoints**:
```typescript
GET /token              // Get current bot token
POST /token/refresh     // Force token refresh
POST /check-message     // Process chat message
GET /channels          // Get channel list
GET /irc/health        // Health check
```

### **3. Supporting Infrastructure**

**Rank Worker** (`Backend/workers/ranks/`):
- Validates user League of Legends ranks
- Integrates with Riot Games API
- Database queries for user data

**Users Worker** (`Backend/workers/users/`):
- Manages channel configuration
- User registration and preferences

## 🔐 **Token Management System**

### **Production-Grade Token Sync**

The bot uses a **dual-layer refresh system** for maximum reliability:

#### **Layer 1: Proactive Maintenance (CF Worker Cron)**
```typescript
// Runs daily at 3 AM UTC
async scheduled(event: ScheduledEvent) {
  if (expiresInHours < 12) {
    await refreshBotToken(env, refreshToken); // Refresh during low-traffic
  }
}
```

#### **Layer 2: Reactive Safety Net (IRC Bot)**
```javascript
// Checks every 15 minutes
setInterval(() => {
  if (expiresInMinutes < 120) {
    await this.refreshToken(); // Get fresh token from CF Worker
  }
}, 15 * 60 * 1000);
```

### **Token Flow**
1. **CF Worker** maintains OAuth tokens in KV storage
2. **IRC Bot** requests fresh tokens via `GET /token`
3. **Automatic refresh** when tokens expire within thresholds
4. **Seamless reconnection** only when token actually changes
5. **Manual override** available via `POST /token/refresh`

## 🚀 **Deployment**

### **Prerequisites**
- AWS Lightsail instance (running)
- Cloudflare Workers deployment
- SSH key for server access
- Valid Twitch OAuth tokens

### **Deploy CF Workers**
```bash
cd Backend/workers/elowardbot
wrangler deploy
```

### **Deploy IRC Bot**
```bash
cd EloWardBot
npm run deploy
```

The deployment script:
1. Copies `bot.js` and `package.json` to server
2. Creates `.env` file with CF Worker URL
3. Installs dependencies via npm
4. Starts bot with PM2 for process management
5. Configures auto-restart on server reboot

## 📊 **Monitoring & Operations**

### **Health Checks**
```bash
# CF Worker health
curl -s https://eloward-bot.unleashai.workers.dev/irc/health | jq .

# IRC Bot logs
npm run logs

# Server status
ssh -i ./eloward-twitch-bot-key.pem bitnami@IP 'pm2 status'
```

### **Expected Health Response**
```json
{
  "connected": true,
  "ready": true,
  "channels": 1,
  "messagesProcessed": 127,
  "timeoutsIssued": 3,
  "connectionAge": 45000,
  "botLogin": "elowardbot",
  "timestamp": "2025-09-20T04:12:41.234Z"
}
```

### **Key Metrics**
- `connected`: IRC connection status
- `messagesProcessed`: Total messages handled
- `timeoutsIssued`: Successful timeout commands
- `connectionAge`: Uptime in milliseconds
- `reconnectAttempts`: Should be 0 or very low

## 🐛 **Troubleshooting**

### **Common Issues**

**Bot Not Connecting**:
```bash
# Check token status
curl -s https://eloward-bot.unleashai.workers.dev/token

# Force token refresh
curl -X POST https://eloward-bot.unleashai.workers.dev/token/refresh
```

**Messages Not Processing**:
```bash
# Check CF Worker health
curl -s https://eloward-bot.unleashai.workers.dev/irc/health

# Check bot logs
npm run logs
```

**Token Expired**:
```bash
# Automatic refresh should handle this, but manual override:
curl -X POST https://eloward-bot.unleashai.workers.dev/token/refresh
```

### **Log Patterns**

**✅ Healthy Operation**:
```
✅ Connected to Twitch IRC successfully!
✅ Joined 1 channels: [ 'channelname' ]
🔍 Token health check { expiresInMinutes: 720, needsRefresh: false }
✅ Processed message for user in channel: timeout
```

**❌ Issues to Watch**:
```
❌ Token request failed: { status: 500 }
❌ Reconnection attempt 3 failed
❌ CF Worker responded with 500
🔄 Token needs refresh - syncing with CF Worker
```

## 🔧 **Development**

### **Local Development**
```bash
# Install dependencies
npm install

# Set environment variables
echo "CF_WORKER_URL=https://eloward-bot.unleashai.workers.dev" > .env

# Run locally (connects to production CF Worker)
npm start
```

### **Development Workflow**
1. **Edit code** in `bot.js`
2. **Test locally** with production CF Worker
3. **Deploy to server** with `npm run deploy`
4. **Monitor logs** with `npm run logs`

### **Configuration**

**Environment Variables** (`.env`):
```bash
CF_WORKER_URL=https://eloward-bot.unleashai.workers.dev
```

**Server Configuration** (`deploy.sh`):
```bash
SERVER_USER="bitnami"
SERVER_IP="35.94.69.109"
SSH_KEY="./eloward-twitch-bot-key.pem"
APP_DIR="/home/bitnami/elowardbot"
```

## 📈 **Performance & Scale**

### **Current Capacity**
- **Channels**: Dynamically loaded from database
- **Messages**: Handles high-volume chat processing
- **Response Time**: Fast message processing via edge network
- **Uptime**: Automatic recovery and reconnection

### **Scaling Considerations**
- **IRC Bot**: Single instance handles multiple channels
- **CF Workers**: Auto-scale with demand
- **Database**: D1 handles concurrent queries efficiently

## 🛡️ **Security & Reliability**

### **Token Security**
- ✅ OAuth tokens stored securely in CF KV
- ✅ Automatic token refresh with exponential backoff
- ✅ No hardcoded secrets in code
- ✅ Tokens synced dynamically, never exposed in logs

### **Error Handling**
- ✅ Exponential backoff for reconnections
- ✅ Circuit breaker for failed API calls
- ✅ Graceful degradation on service outages
- ✅ Comprehensive logging for debugging

### **Production Safeguards**
- ✅ Dual-layer token refresh system
- ✅ Health monitoring and alerting
- ✅ Automatic recovery from failures
- ✅ Zero-downtime deployments
- ✅ Maintenance during low-traffic hours

## 📝 **API Documentation**

### **CF Worker Endpoints**

#### `GET /token`
Get current bot OAuth token for IRC connection.

**Response**:
```json
{
  "token": "oauth:abc123...",
  "user": { "login": "elowardbot", "id": "123" },
  "expires_at": 1758341255703,
  "expires_in_minutes": 840,
  "needs_refresh_soon": false
}
```

#### `POST /check-message`
Process a chat message and determine if user should be timed out.

**Request**:
```json
{
  "channel": "streamername",
  "user": "chattername", 
  "message": "hello world"
}
```

**Response**:
```json
{
  "action": "timeout",
  "reason": "insufficient rank",
  "duration": 20
}
```

#### `GET /channels`
Get list of channels bot should be monitoring.

**Response**:
```json
{
  "channels": ["channel1", "channel2"],
  "count": 2,
  "timestamp": "2025-09-20T04:12:41.234Z"
}
```

## 🤝 **Contributing**

1. Fork the repository
2. Create a feature branch
3. Test changes locally
4. Deploy to staging environment
5. Submit pull request with detailed description

### **Development Setup**
```bash
git clone <repo>
cd EloWardBot
npm install
cp .env.example .env  # Configure CF Worker URL
npm start
```

## 📄 **License**

Apache 2.0 + Commons Clause - see LICENSE file for details.

## 🆘 **Support**

- **Issues**: GitHub Issues
- **Documentation**: This README + inline comments
- **Monitoring**: CF Worker health endpoints
- **Logs**: PM2 logs on AWS Lightsail server

---

**The EloWardBot provides automated Twitch chat moderation based on League of Legends rank requirements.**
