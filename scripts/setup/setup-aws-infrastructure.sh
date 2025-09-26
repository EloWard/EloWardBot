#!/bin/bash

# EloWard Bot - AWS Infrastructure Setup Script
# This script sets up all the AWS resources needed for the bot

set -e  # Exit on any error

echo "🚀 Setting up AWS infrastructure for EloWard Bot..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed. Please install it first:${NC}"
    echo "Mac: brew install awscli"
    echo "Windows: choco install awscli" 
    echo "Linux: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

# Check if AWS is configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not configured. Please run 'aws configure' first${NC}"
    exit 1
fi

# Get account ID and region
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}

echo -e "${GREEN}✅ AWS Account: $ACCOUNT_ID${NC}"
echo -e "${GREEN}✅ Region: $REGION${NC}"

# Step 1: Create ECR Repository
echo -e "${YELLOW}📦 Creating ECR repository...${NC}"
aws ecr create-repository --repository-name elowardbot --region $REGION 2>/dev/null || echo "Repository already exists"

ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/elowardbot"
echo -e "${GREEN}✅ ECR Repository: $ECR_URI${NC}"

# Step 2: Create ECS Cluster
echo -e "${YELLOW}🏗️ Creating ECS cluster...${NC}"
aws ecs create-cluster --cluster-name eloward --region $REGION 2>/dev/null || echo "Cluster already exists"
echo -e "${GREEN}✅ ECS Cluster: eloward${NC}"

# Step 3: Create IAM Role for ECS Task
echo -e "${YELLOW}🔐 Creating IAM role for ECS tasks...${NC}"

# Create trust policy
cat > /tmp/task-execution-role-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create the role
aws iam create-role \
  --role-name eloward-bot-execution-role \
  --assume-role-policy-document file:///tmp/task-execution-role-trust-policy.json \
  2>/dev/null || echo "Role already exists"

# Attach policies
aws iam attach-role-policy \
  --role-name eloward-bot-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
  2>/dev/null || true

aws iam attach-role-policy \
  --role-name eloward-bot-execution-role \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess \
  2>/dev/null || true

echo -e "${GREEN}✅ IAM Role: eloward-bot-execution-role${NC}"

# Step 4: Create CloudWatch Log Group
echo -e "${YELLOW}📊 Creating CloudWatch log group...${NC}"
aws logs create-log-group --log-group-name /ecs/elowardbot --region $REGION 2>/dev/null || echo "Log group already exists"
echo -e "${GREEN}✅ Log Group: /ecs/elowardbot${NC}"

# Step 5: Get VPC and Subnet info for later
echo -e "${YELLOW}🌐 Getting network information...${NC}"
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text --region $REGION)
SUBNET_ID=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" --query 'Subnets[0].SubnetId' --output text --region $REGION)

echo -e "${GREEN}✅ VPC: $VPC_ID${NC}"
echo -e "${GREEN}✅ Subnet: $SUBNET_ID${NC}"

# Step 6: Create Security Group
echo -e "${YELLOW}🛡️ Creating security group...${NC}"
aws ec2 create-security-group \
  --group-name eloward-bot-sg \
  --description "Security group for EloWard bot - outbound only" \
  --vpc-id $VPC_ID \
  --region $REGION 2>/dev/null || echo "Security group already exists"

SG_ID=$(aws ec2 describe-security-groups --group-names eloward-bot-sg --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
echo -e "${GREEN}✅ Security Group: $SG_ID${NC}"

# Clean up temp files
rm -f /tmp/task-execution-role-trust-policy.json

echo ""
echo -e "${GREEN}🎉 AWS Infrastructure Setup Complete!${NC}"
echo ""
echo -e "${YELLOW}📋 Summary:${NC}"
echo "ECR Repository: $ECR_URI"
echo "ECS Cluster: eloward"  
echo "IAM Role: eloward-bot-execution-role"
echo "Log Group: /ecs/elowardbot"
echo "Security Group: $SG_ID"
echo ""
echo -e "${YELLOW}📝 Next Steps:${NC}"
echo "1. Set environment variable: export ELOWARD_ECR_REPO=\"$ECR_URI\""
echo "2. Configure your .env file with Redis and other credentials"
echo "3. Run ./deploy.sh to build and deploy your bot"
echo ""
echo -e "${YELLOW}💡 Save these values - you'll need them:${NC}"
echo "export ELOWARD_ECR_REPO=\"$ECR_URI\""
echo "export ELOWARD_VPC_ID=\"$VPC_ID\""
echo "export ELOWARD_SUBNET_ID=\"$SUBNET_ID\""
echo "export ELOWARD_SECURITY_GROUP=\"$SG_ID\""
