#!/bin/bash

# Configuration
SERVER_USER="bitnami"
SERVER_IP="35.94.69.109"  # Replace with your actual IP
SSH_KEY="./eloward-twitch-bot-key.pem"  # Update this path
APP_DIR="/home/bitnami/elowardbot"

echo "🚀 Deploying EloWard Twitch Bot..."

# Create app directory on server if it doesn't exist
ssh -i $SSH_KEY $SERVER_USER@$SERVER_IP "mkdir -p $APP_DIR"

# Copy files to server
scp -i $SSH_KEY bot.js package.json .env $SERVER_USER@$SERVER_IP:$APP_DIR/

# Install dependencies and restart bot
ssh -i $SSH_KEY $SERVER_USER@$SERVER_IP << 'EOF'
cd /home/bitnami/elowardbot
npm install

# Kill existing bot process if running
pkill -f "node bot.js" || true

# Start bot with PM2
npm install -g pm2 2>/dev/null || sudo npm install -g pm2
pm2 delete elowardbot || true
pm2 start bot.js --name elowardbot
pm2 save
pm2 startup

echo "✅ Bot deployed and running!"
pm2 status
EOF