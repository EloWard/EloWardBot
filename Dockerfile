# Production EloWard Twitch Bot - ECS Fargate Container
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY bot.js ./

# Create non-root user
RUN addgroup -g 1001 -S elowardbot && \
    adduser -S elowardbot -u 1001 -G elowardbot

# Change ownership to non-root user
RUN chown -R elowardbot:elowardbot /usr/src/app
USER elowardbot

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "console.log('Bot health: OK')" || exit 1

# No exposed ports (outbound connections only)
EXPOSE

# Start the bot
CMD ["node", "bot.js"]
