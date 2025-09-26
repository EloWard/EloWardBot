#!/bin/bash

# Load environment variables from .env file if it exists
if [ -f .env ]; then
  echo "📝 Loading configuration from .env file..."
  set -a  # automatically export all variables
  source .env
  set +a  # stop auto-export
else
  echo "⚠️ No .env file found. Copy env-template.txt to .env and configure it."
  exit 1
fi

# Configuration for ECS Fargate deployment (with .env overrides)
CLUSTER_NAME="${ELOWARD_ECS_CLUSTER:-eloward}"
SERVICE_NAME="${ELOWARD_ECS_SERVICE:-elowardbot}"
TASK_DEFINITION="${ELOWARD_TASK_DEF:-elowardbot:1}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO="${ELOWARD_ECR_REPO}"

echo "🚀 Deploying Production EloWard Bot to AWS ECS Fargate..."
echo "📍 Cluster: $CLUSTER_NAME"
echo "🔧 Service: $SERVICE_NAME"
echo "📦 Task Definition: $TASK_DEFINITION"

# Verify required environment variables
if [ -z "$ECR_REPO" ]; then
  echo "❌ ELOWARD_ECR_REPO environment variable is required"
  echo "Example: 123456789012.dkr.ecr.us-east-1.amazonaws.com/elowardbot"
  exit 1
fi

echo "🏗️ Building Docker image..."

# Build Docker image for AMD64 (ECS Fargate)
docker buildx build --platform linux/amd64 -t elowardbot:latest --load .

if [ $? -ne 0 ]; then
  echo "❌ Docker build failed"
  exit 1
fi

echo "✅ Docker image built successfully"

echo "🔐 Logging into ECR..."
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO

if [ $? -ne 0 ]; then
  echo "❌ ECR login failed"
  exit 1
fi

echo "🏷️ Tagging and pushing image..."
IMAGE_TAG="latest"
FULL_IMAGE_URI="$ECR_REPO:$IMAGE_TAG"

docker tag elowardbot:latest $FULL_IMAGE_URI
docker push $FULL_IMAGE_URI

if [ $? -ne 0 ]; then
  echo "❌ Docker push failed"
  exit 1
fi

echo "✅ Image pushed to ECR: $FULL_IMAGE_URI"

echo "🚀 Deploying to ECS Fargate..."

# Check if ECS service exists
SERVICE_EXISTS=$(aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $AWS_REGION --query 'services[0].serviceName' --output text 2>/dev/null)

if [ "$SERVICE_EXISTS" = "$SERVICE_NAME" ]; then
  echo "✅ ECS service exists, updating with new image..."
  
  # Update ECS service to use new image
  aws ecs update-service \
    --cluster $CLUSTER_NAME \
    --service $SERVICE_NAME \
    --force-new-deployment \
    --region $AWS_REGION

  if [ $? -ne 0 ]; then
    echo "❌ ECS service update failed"
    exit 1
  fi

  echo "✅ ECS service update initiated"
else
  echo "⚠️ ECS service '$SERVICE_NAME' does not exist yet."
  echo "📋 Next steps:"
  echo "1. Run: chmod +x create-ecs-service.sh"
  echo "2. Run: ./create-ecs-service.sh"
  echo "3. Then run this deploy script again"
  echo ""
  echo "✅ Your Docker image has been successfully pushed to ECR and is ready to deploy!"
  exit 0
fi

echo "⏱️ Waiting for deployment to complete..."
aws ecs wait services-stable \
  --cluster $CLUSTER_NAME \
  --services $SERVICE_NAME \
  --region $AWS_REGION

if [ $? -eq 0 ]; then
  echo "✅ Deployment completed successfully!"
else
  echo "⚠️ Deployment may still be in progress. Check ECS console for status."
fi

echo ""
echo "📊 Service Status:"
aws ecs describe-services \
  --cluster $CLUSTER_NAME \
  --services $SERVICE_NAME \
  --region $AWS_REGION \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}' \
  --output table

echo ""
echo "📋 Deployment Complete!"
echo "🔍 Monitor logs: aws logs tail /ecs/elowardbot --follow --region $AWS_REGION"
echo "📊 ECS Console: https://${AWS_REGION}.console.aws.amazon.com/ecs/home?region=${AWS_REGION}#/clusters/${CLUSTER_NAME}/services"
