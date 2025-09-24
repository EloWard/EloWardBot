#!/bin/bash

# Configuration
SERVER_USER="ubuntu"  # Changed from bitnami to ubuntu for better AWS integration
SERVER_IP="YOUR_EC2_INSTANCE_IP"  # Replace with your actual EC2 instance IP from Phase 2
SSH_KEY="./eloward-bot-key.pem"
APP_DIR="/home/ubuntu/elowardbot"

echo "🚀 Deploying Enhanced EloWard Twitch Bot with AWS Messaging..."

# Create app directory on server if it doesn't exist
ssh -i $SSH_KEY $SERVER_USER@$SERVER_IP "mkdir -p $APP_DIR"

# Copy files to server
scp -i $SSH_KEY bot.js package.json $SERVER_USER@$SERVER_IP:$APP_DIR/

# Create enhanced .env file on server
ssh -i $SSH_KEY $SERVER_USER@$SERVER_IP "cat > $APP_DIR/.env << 'EOF'
# Cloudflare Worker Integration
CF_WORKER_URL=https://eloward-bot.unleashai.workers.dev

# AWS Configuration
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY

# SQS Configuration (replace with your queue URL)
SQS_QUEUE_URL=https://sqs.us-west-2.amazonaws.com/ACCOUNT_ID/eloward-bot-queue

# ElastiCache Redis Configuration (replace with your cluster endpoint)
REDIS_HOST=eloward-bot.xxxxx.cache.amazonaws.com
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password-if-auth-enabled
REDIS_URL=https://your-redis-rest-api.com  # For CF Worker Redis API calls

# Optional Redis token for REST API
REDIS_TOKEN=your-redis-rest-token
EOF"

# Install dependencies and restart bot
ssh -i $SSH_KEY $SERVER_USER@$SERVER_IP << 'EOF'
cd /home/ubuntu/elowardbot

# Update system packages
sudo apt-get update

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install dependencies
npm install

# Install AWS CLI for easier management
if ! command -v aws &> /dev/null; then
    sudo apt-get install -y awscli
fi

# Kill existing bot process if running
pkill -f "node bot" || true

# Install PM2 globally if not present
npm list -g pm2 || sudo npm install -g pm2

# Delete existing PM2 process
pm2 delete elowardbot || true

# Start bot with PM2
pm2 start bot.js --name elowardbot

# Save PM2 configuration
pm2 save

# Setup PM2 startup script
pm2 startup

echo "✅ Enhanced Bot deployed and running!"
echo "📊 Bot Status:"
pm2 status

echo "🔍 Recent Logs:"
pm2 logs elowardbot --lines 20

echo ""
echo "🚀 Deployment complete!"
echo "📋 Next Steps:"
echo "1. Update AWS credentials in .env file:"
echo "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_IP 'nano $APP_DIR/.env'"
echo "2. Set up SQS queue and ElastiCache Redis cluster"
echo "3. Update Cloudflare Worker environment variables"
echo "4. Monitor logs: npm run logs"
EOF
