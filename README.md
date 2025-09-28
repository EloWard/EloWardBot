# EloWard Twitch Bot

A production-grade Twitch IRC bot that enforces League of Legends rank requirements in chat using AWS ECS Fargate for secure hosting and Cloudflare Workers for business logic.

## 🎯 **What It Does**

EloWardBot creates a funnel to drive Twitch viewers to connect their League of Legends accounts to EloWard:

- **Always present in chat** (Standby mode) to respond instantly to `!eloward` commands
- **Enforces rank requirements** when enabled, timing out users without connected LoL accounts
- **Supports chat commands** (`!eloward on/off/mode minrank gold4`) for streamers and moderators
- **Dashboard integration** with 1-3 second configuration updates
- **Secure and scalable** with no exposed ports and HMAC-protected communications

## 🏗️ **Architecture Overview**

### **Production Serverless + Containers Architecture**
```
┌─────────────── CLOUDFLARE (Control Plane) ──────────────────┐
│                                                             │
│  🌐 Dashboard          🔐 Bot Worker         📊 Rank Worker │
│  • React UI            • Token Management   • LoL Lookups  │
│  • Pages Functions     • Config Updates     • D1 Queries   │  
│  • Auth Flow           • HMAC Security      • Cache Logic  │
│                        • Redis Publisher    • Fresh Data   │
│                                                             │
│  💾 KV Storage        🗄️ D1 Database        ⚡ Upstash     │
│  • Bot Tokens         • bot_channels        • Redis Pub/Sub│
│  • User Sessions      • lol_ranks           • Global CDN   │
│                       • Audit Logs          • TLS + Auth   │
│                                                             │
└─────────────┬─────────────────────────────────────────────────┘
              │ HMAC + Redis Pub/Sub (1-3s updates)
              │
┌─────────────▼─────────────────────────────────────────────────┐
│                     AWS (Data Plane)                        │
│                                                             │
│  🐳 ECS Fargate                🌍 Multi-Region Ready        │
│  • Containerized IRC Bot       • us-east-1 (primary)       │
│  • No Inbound Ports           • eu-west-1 (future)        │
│  • Auto-restart/Scale         • preferred_region in D1     │  
│  • Outbound Only              • Logical region assignment (na/eu)│
│                                                             │
│              🤖 IRC Connection                              │
│              • Persistent to irc.chat.twitch.tv            │
│              • Always Joined (Standby ↔ Enforcing)         │
│              • Token Refresh + Error Recovery               │
│              • Chat Commands + Message Processing          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### **Presence Model (Key Innovation)**

**Always-Joined Design**: Bot joins channels immediately after OAuth Connect and stays joined:

- **Standby Mode**: Passive presence, only responds to `!eloward` commands
- **Enforcing Mode**: Active moderation, timeouts users without sufficient rank
- **Instant Switching**: `!eloward on` takes effect in 1-3 seconds via Redis pub/sub
- **Leave Only**: On permission revoke or disconnect - otherwise maintains presence

This solves the "chicken and egg" problem where users couldn't enable the bot because it wasn't in their channel.

## 🔧 **Core Components**

### **1. IRC Bot (AWS ECS Fargate)**
**File**: `bot.js`

**Purpose**: Secure, always-on IRC presence with instant config updates

**Key Responsibilities**:
- Maintain persistent connection to `irc.chat.twitch.tv`
- Process all chat messages (fast prefix check in Standby)
- Handle `!eloward` commands from broadcasters/mods
- Make **local caching decisions** (config + rank lookups)
- Execute timeouts via Twitch Helix API (bot calls Helix directly)
- Subscribe to Redis for instant config updates
- HMAC-signed calls to Workers only on cache misses

**State Machine**:
```javascript
// On OAuth Connect
NotConnected → Standby (joins channel, passive)

// Via Dashboard or Chat Commands  
Standby ↔ Enforcing (instant via Redis)

// Only on revoke/disconnect
Standby/Enforcing → NotConnected (leaves channel)
```

### **2. Bot Worker (Cloudflare Workers)**
**File**: `Backend/workers/elowardbot/bot-worker.ts`

**Purpose**: Central control plane for bot operations

**Key Responsibilities**:
- OAuth token management and automatic refresh
- Process bot configuration updates from Dashboard
- Serve read-through endpoints for config/ranks to bot
- Publish config updates to Redis for instant propagation
- HMAC request validation from bot instances
- Light rate limiting to protect D1

**Critical Endpoints**:
```typescript
GET  /token                    // Bot token sync
POST /bot/config:get           // HMAC, read config for a channel (D1)
POST /bot/config:update        // HMAC, write config (dashboard or chat), publish Redis
POST /rank:get                 // HMAC, read lol_ranks for a user (D1)
GET  /channels                 // Active channel list for ops
```

### **3. Dashboard Integration** 
**File**: `EloWardSite/src/pages/Dashboard.js`

**Flow**: Dashboard → Pages Functions → Bot Worker → D1 → Redis Pub/Sub → Bot (1-3s)

**Features**:
- Real-time bot enable/disable toggle
- Configuration: timeout duration, reason template, enforcement mode
- Minimum rank settings (Iron → Challenger)
- OAuth Connect flow for broadcaster permissions

### **4. Chat Commands**

**Syntax**: `!eloward <command> [args]`

**Permissions**: Broadcaster + Moderators only

**Enforcement Ignore List**: Bot ignores broadcaster/mods (and optionally VIPs/subs if configured) for enforcement

**Supported Commands**:
```bash
!eloward on                    # Enable enforcement
!eloward off                   # Disable (standby mode)
!eloward mode hasrank          # Require any connected rank
!eloward mode minrank gold 4   # Require Gold 4 or higher
!eloward timeout 30            # Set timeout duration (seconds)
```

**Processing Flow**: Chat Command → Bot (validates mod/broadcaster) → Worker (/bot/config:update) → D1 → Redis → All Bots (1-3s)

## 🚀 **Performance & Caching**

### **Hot Path Optimization (Message Processing)**

**Target**: ~200-400ms decision time per message

**Caching Strategy**:
- ✅ **Positive cache only**: Config (1-2s TTL), Rank (30-60s TTL)  
- ❌ **No negative caching**: New users see effects immediately
- 🔄 **Cache invalidation**: Via Redis pub/sub on updates

**Decision Flow**:
```javascript
1. Check local config cache (1-2s TTL) → Cache hit = instant decision
2. On miss: HMAC call to /bot/config:get → D1 → Update cache
3. Check local rank cache (30-60s TTL) → Cache hit = instant decision
4. On miss: HMAC call to /rank:get → D1 → Update cache
5. Apply decision locally: timeout via Helix API or allow (fail-open on errors)
```

### **Config Propagation (Dashboard/Chat Updates)**

**Target**: 1-3 seconds end-to-end

**Flow**:
```
Dashboard/Chat → Worker (/bot/config:update) → D1 Write → Redis Publish → Bot Cache Invalidate → Effect
```

**Redis Message Format**:
```json
{
  "type": "config_update",
  "channel_login": "streamername", 
  "fields": {"bot_enabled": true, "enforcement_mode": "minrank", "min_rank": "GOLD4"},
  "version": 1737849600,
  "updated_at": "2025-01-25T12:00:00Z"
}
```

**Version Handling**: Bot ignores messages if `version <= cached_version` to prevent race conditions.

### **Twitch Limits & Connection Strategy**

**JOIN Rate Limits & Anti-Spam**:
- Max 15 channels per 10 seconds per connection (conservative approach)
- 667ms delay between JOINs to prevent Twitch spam detection
- Progressive startup with detailed logging to track join progress
- Always-on presence model: joins ALL channels regardless of enabled status

**Connection Strategy**:
- Two IRC connections (75-80 channels each) for resilience
- Fast `!eloward` prefix check in Standby mode (minimal CPU)
- Exponential backoff + jitter on reconnection to prevent storms

**Required Helix Scopes**:
- `moderator:manage:banned_users` - For timeout/ban actions via `/moderation/bans`
- `channel:moderate` - For mod/broadcaster context
- If we also delete messages, add `moderator:manage:chat_messages`
- Respect Twitch Helix rate buckets (per-user/app); on `429`, use exponential backoff + jitter

**Self-Healing**:
- Every 60-120s: lightweight reconcile sweep (check `updated_at` for stale cache)
- Sweep checks only channel `updated_at/version` to avoid heavy reads; full config fetch only when stale
- Prevents missed Redis pub/sub messages during brief disconnects

## 🔐 **Security (Open Source Safe)**

### **Zero Inbound Attack Surface**
- ❌ **No open ports** on bot instances
- ✅ **Outbound only**: Twitch IRC, CF Workers HTTPS, Upstash Redis TLS
- ✅ **ECS Fargate**: Managed, patched, isolated containers

### **HMAC Request Security**
```javascript
// Bot → Worker requests are HMAC-SHA256 signed
const signature = hmac_sha256(secret, timestamp + method + path + body);
headers['X-HMAC-Signature'] = signature;
headers['X-Timestamp'] = timestamp; // Allow ±60s clock skew; reject outside window
```

**Benefits**:
- Prevents replay attacks (timestamp window)
- Works with open source (secrets in env only)
- Standard cryptographic approach
- Lightweight validation

### **Secrets Management**
- **Bot Tokens**: CF KV (encrypted at rest)
- **HMAC Keys**: Environment variables only  
- **Database**: D1 with CF security model
- **Redis**: Upstash TLS + auth token

### **Threat Model Summary**
- **No inbound ports** → Port scan/DDoS resistant  
- **HMAC (60s window)** → Replay attack resistant
- **Worker rate limits** → D1 protection from abuse

## 📊 **Monitoring & Health**

### **Key Metrics (Essential 3)**
- **message_decision_ms_p95**: < 400ms (local cache hit performance)
- **config_propagation_ms_p95**: < 3s (Redis pub → cache invalidation)  
- **helix_timeout_failure_rate**: < 2% (API success rate)

### **Health Endpoints**
```bash
# Worker Health
curl -s https://eloward-bot.unleashai.workers.dev/irc/health

# Expected Response (Control Plane Health)
{
  "worker_status": "healthy",
  "architecture": "fargate_redis",  
  "enabled_channels": 5,
  "d1_status": "operational",
  "redis_status": "connected",
  "timestamp": "2025-01-15T10:30:00Z"
}

# IRC socket health is observed via bot logs/metrics; the Worker reports only control-plane status
```

### **Bot Observability**
```bash
# ECS Logs via CloudWatch
aws logs tail /ecs/eloward-bot --follow

# Key Log Patterns
✅ [INFO] Redis notification received: config_update channel:streamer
✅ [INFO] Message decision: allow user:player channel:streamer (45ms)
⚡ [INFO] Config updated: enforcement_mode=minrank (Redis→Cache)
🔍 [WARN] Rank cache miss: player (fetching fresh)
```

## 🌍 **Multi-Region Architecture**

### **Phase 1: North America (Launch)**
- **ECS Fargate**: `us-east-1` (closest to CF edge)
- **Logical Region**: `na` in D1
- **Target**: US/Canada streamers

### **Phase 2: Europe (Future)**
- **ECS Fargate**: `eu-west-1` 
- **Logical Region**: `eu` in D1
- **Target**: EU streamers

### **Channel Assignment**
```sql
-- D1 uses logical regions
ALTER TABLE bot_channels ADD COLUMN preferred_region TEXT DEFAULT 'na';

-- Assignment Logic (in Worker)
const region = request.cf.country in ['US','CA'] ? 'na' : 'eu';
```

## 🚀 **Deployment Guide**

### **Prerequisites**
- AWS Account with ECS permissions
- Cloudflare account with Workers/D1 access
- Upstash Redis database
- Twitch Developer Application

### **1. Cloudflare Setup**
```bash
# Deploy Bot Worker
cd Backend/workers/elowardbot
wrangler deploy

# Configure Environment Variables
wrangler secret put TWITCH_CLIENT_ID
wrangler secret put TWITCH_CLIENT_SECRET  
wrangler secret put BOT_WRITE_KEY
wrangler secret put UPSTASH_REDIS_URL
wrangler secret put UPSTASH_REDIS_TOKEN
```

### **2. D1 Database Schema**
```sql
-- bot_channels: add columns for region assignment and change tracking
ALTER TABLE bot_channels ADD COLUMN preferred_region TEXT DEFAULT 'na';
ALTER TABLE bot_channels ADD COLUMN updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'));
ALTER TABLE bot_channels ADD COLUMN version INTEGER NOT NULL DEFAULT (strftime('%s','now'));

-- Performance indexes
CREATE INDEX idx_bot_channels_enabled ON bot_channels(bot_enabled);
CREATE INDEX idx_lol_ranks_user_login ON lol_ranks(user_login);

-- updated_at and version are set by the Worker on every write (monotonic epoch ms preferred)
-- No DB triggers used
```

### **3. Upstash Redis Setup**
```bash
# Create Redis instance at console.upstash.com
# Enable TLS, get connection details
# Workers use REST; the bot uses the Redis protocol (TLS)

# CF Workers (REST API):
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-rest-token

# Bot (Redis Protocol):
UPSTASH_REDIS_URL=rediss://your-host:6380
UPSTASH_REDIS_PASSWORD=your-password
```

### **4. ECS Fargate Deployment**
```bash
# Build and push container
docker build -t eloward-bot .
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
docker tag eloward-bot:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/eloward-bot:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/eloward-bot:latest

# Deploy ECS Service
aws ecs create-service --cluster eloward --service-name eloward-bot \
  --task-definition eloward-bot:1 --desired-count 1
```

### **5. Environment Configuration**
```bash
# ECS Task Environment Variables
CF_WORKER_URL=https://eloward-bot.unleashai.workers.dev
HMAC_SECRET=your-shared-secret-here
UPSTASH_REDIS_URL=rediss://your-host:6380
UPSTASH_REDIS_PASSWORD=your-password
AWS_REGION=us-east-1
```

## 🔧 **Development Workflow**

### **Local Development**
```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Configure CF_WORKER_URL and other secrets

# Run locally (connects to production CF Worker)
npm start
```

### **Testing Changes**
```bash
# 1. Test bot logic locally
npm start

# 2. Deploy Worker changes  
cd Backend/workers/elowardbot && wrangler deploy

# 3. Build and deploy container
docker build -t eloward-bot . && ./deploy-fargate.sh

# 4. Monitor logs
aws logs tail /ecs/eloward-bot --follow
```

## 📈 **Scale & Performance Targets**

### **Current Capacity (Single Fargate Task)**
- **Channels**: 150+ in Standby, 30 actively Enforcing
- **Messages**: 750 msgs/sec aggregate (5 msgs/sec × 150 channels)  
- **Bandwidth**: ~1.2 Mbps inbound (totally manageable)
- **Memory**: < 100MB (minimal per-channel state)
- **CPU**: < 5% utilization at peak
- **IRC Connections**: 2 concurrent connections by default for resilience; both use JOIN throttling (≤20/10s)

### **Scaling Strategy**
```bash
# Horizontal scaling (if needed)
# Option 1: Increase ECS desired count
aws ecs update-service --cluster eloward --service eloward-bot --desired-count 2

# Option 2: Add second region  
# Deploy eu-west-1 task, use preferred_region for assignment
```

### **Performance Optimizations**
- **IRC Connection Sharding**: 50-100 channels per connection
- **Rate Limited Joins**: 15-20 channels per 10s window
- **Fast Command Parsing**: `startsWith('!eloward')` early exit
- **Connection Pooling**: Reuse HTTP connections to CF Workers

## 🐛 **Troubleshooting**

### **Common Issues**

**Bot Not Joining Channels**:
```bash
# Check ECS task status
aws ecs describe-services --cluster eloward --services eloward-bot

# Check logs  
aws logs tail /ecs/eloward-bot --since 5m

# Check Redis connectivity
redis-cli -u $UPSTASH_REDIS_URL ping
```

**Config Updates Not Propagating**:
```bash
# Check Redis pub/sub
redis-cli -u $UPSTASH_REDIS_URL monitor

# Check Worker logs
wrangler tail eloward-bot

# Test HMAC endpoint directly
curl -X POST https://eloward-bot.unleashai.workers.dev/bot/config:update \
  -H "X-HMAC-Signature: $(generate_hmac)" \
  -H "Content-Type: application/json" \
  -d '{"channel_login":"streamer","fields":{"bot_enabled":true}}'
```

**Slow Message Decisions**:
```bash
# Check cache hit rates in logs
aws logs filter-log-events --log-group-name /ecs/eloward-bot \
  --filter-pattern "cache_miss"

# Check Worker response times
wrangler tail eloward-bot | grep "config:update\|rank:get"
```

### **Emergency Procedures**

**Disable All Timeouts**:
```sql
-- Emergency stop via D1 console
UPDATE bot_channels SET bot_enabled = 0 WHERE bot_enabled = 1;
```

**Rollback Deployment**:
```bash
# Revert to previous ECS task definition
aws ecs update-service --cluster eloward --service eloward-bot \
  --task-definition eloward-bot:previous-version
```

## 🎯 **Success Metrics**

### **User Experience**
- ✅ `!eloward on` takes effect in < 3 seconds
- ✅ New account links stop timeouts on next message  
- ✅ Dashboard toggles propagate in < 2 seconds
- ✅ Chat commands work for all mods/broadcaster

### **Technical Performance** 
- ✅ Message decisions in < 400ms p95
- ✅ 99.9%+ IRC connection uptime
- ✅ < 1% timeout API failure rate
- ✅ Zero security incidents (no exposed ports)

### **Business Impact**
- ✅ Drives account connections to EloWard
- ✅ Increases premium badge engagement  
- ✅ Creates positive stream experience
- ✅ Scales to support growth

---

## 📄 **License**

Apache 2.0 + Commons Clause - see LICENSE file for details.

## 🆘 **Support** 

- **Issues**: GitHub Issues tracker
- **Documentation**: This README + inline code comments
- **Monitoring**: CloudWatch dashboards + Upstash analytics
- **Emergency**: Bot can be disabled instantly via D1 console

---

**EloWardBot: Production-grade Twitch chat moderation that drives user engagement and account connections through smart rank enforcement.**