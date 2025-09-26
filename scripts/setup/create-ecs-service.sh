#!/bin/bash

# EloWard Bot - ECS Service Creation Script
# Run this after setup-aws-infrastructure.sh and your first deployment

set -e  # Exit on any error

echo "🚀 Creating ECS Service for EloWard Bot..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Load environment variables from .env file
if [ -f .env ]; then
  echo -e "${YELLOW}📝 Loading configuration from .env file...${NC}"
  set -a  # automatically export all variables
  source .env
  set +a  # stop auto-export
else
  echo -e "${RED}⚠️ No .env file found. Copy env-template.txt to .env and configure it.${NC}"
  exit 1
fi

# Check required environment variables
if [ -z "$ELOWARD_ECR_REPO" ]; then
    echo -e "${RED}❌ ELOWARD_ECR_REPO not found in .env file${NC}"
    exit 1
fi

# Get AWS account and region info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}

# Check if required secrets are provided in .env file
if [ -z "$HMAC_SECRET" ]; then
    echo -e "${RED}❌ HMAC_SECRET not found in .env file${NC}"
    exit 1
fi

if [ -z "$UPSTASH_REDIS_URL" ]; then
    echo -e "${RED}❌ UPSTASH_REDIS_URL not found in .env file${NC}"
    exit 1
fi

if [ -z "$UPSTASH_REDIS_PASSWORD" ]; then
    echo -e "${RED}❌ UPSTASH_REDIS_PASSWORD not found in .env file${NC}"
    exit 1
fi

if [ -z "$TWITCH_CLIENT_ID" ]; then
    echo -e "${RED}❌ TWITCH_CLIENT_ID not found in .env file${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 Creating task definition...${NC}"

# Create task definition
cat > task-definition.json << EOF
{
  "family": "elowardbot",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/eloward-bot-execution-role",
  "containerDefinitions": [
    {
      "name": "elowardbot",
      "image": "${ELOWARD_ECR_REPO}:latest",
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/elowardbot",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "environment": [
        {
          "name": "CF_WORKER_URL",
          "value": "https://eloward-bot.unleashai.workers.dev"
        },
        {
          "name": "AWS_REGION", 
          "value": "${REGION}"
        },
        {
          "name": "HMAC_SECRET",
          "value": "${HMAC_SECRET}"
        },
        {
          "name": "UPSTASH_REDIS_URL",
          "value": "${UPSTASH_REDIS_URL}"
        },
        {
          "name": "UPSTASH_REDIS_PASSWORD",
          "value": "${UPSTASH_REDIS_PASSWORD}"
        },
        {
          "name": "TWITCH_CLIENT_ID",
          "value": "${TWITCH_CLIENT_ID}"
        }
      ]
    }
  ]
}
EOF

# Register the task definition
echo -e "${YELLOW}📝 Registering task definition...${NC}"
aws ecs register-task-definition --cli-input-json file://task-definition.json --region $REGION

# Use network information from .env file (set by setup-aws-infrastructure.sh)
VPC_ID="${ELOWARD_VPC_ID}"
SUBNET_ID="${ELOWARD_SUBNET_ID}"
SG_ID="${ELOWARD_SECURITY_GROUP}"

if [ -z "$VPC_ID" ] || [ -z "$SUBNET_ID" ] || [ -z "$SG_ID" ]; then
    echo -e "${RED}❌ Network configuration missing from .env file${NC}"
    echo "Make sure you have run ./setup-aws-infrastructure.sh first"
    exit 1
fi

echo -e "${YELLOW}🌐 Network configuration:${NC}"
echo "VPC: $VPC_ID"
echo "Subnet: $SUBNET_ID"  
echo "Security Group: $SG_ID"

# Create ECS service
echo -e "${YELLOW}🏗️ Creating ECS service...${NC}"
aws ecs create-service \
  --cluster eloward \
  --service-name elowardbot \
  --task-definition elowardbot:1 \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
  --region $REGION

echo -e "${GREEN}✅ ECS service created successfully!${NC}"

echo ""
echo -e "${YELLOW}📊 Checking service status...${NC}"
sleep 10  # Wait a bit for the service to start

aws ecs describe-services --cluster eloward --services elowardbot --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}' --output table --region $REGION

echo ""
echo -e "${YELLOW}📋 To monitor your bot:${NC}"
echo "View logs: aws logs tail /ecs/elowardbot --follow --region $REGION"
echo "Check service: aws ecs describe-services --cluster eloward --services elowardbot --region $REGION"
echo "Update service: ./deploy.sh (after making changes)"

echo ""
echo -e "${GREEN}🎉 ECS Service Setup Complete!${NC}"
echo -e "${YELLOW}Your bot should be starting up now. Check the logs to see if it connects successfully.${NC}"

# Clean up
rm task-definition.json
