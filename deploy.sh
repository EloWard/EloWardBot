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
TASK_FAMILY="${ELOWARD_TASK_FAMILY:-elowardbot}"
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
  echo "✅ ECS service exists, creating new task definition with current .env values..."
  
  # Create new task definition with current environment variables
  echo "🔧 Generating task definition with latest configuration..."
  
  cat > task-definition-deploy.json <<EOF
{
  "family": "$TASK_FAMILY",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::659066864277:role/eloward-bot-execution-role",
  "containerDefinitions": [
    {
      "name": "$TASK_FAMILY",
      "image": "$FULL_IMAGE_URI",
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/$TASK_FAMILY",
          "awslogs-region": "$AWS_REGION",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "environment": [
        {
          "name": "CF_WORKER_URL",
          "value": "${CF_WORKER_URL}"
        },
        {
          "name": "AWS_REGION", 
          "value": "${AWS_REGION}"
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

  echo "📝 Registering new task definition..."
  TASK_DEF_ARN=$(aws ecs register-task-definition \
    --cli-input-json file://task-definition-deploy.json \
    --region $AWS_REGION \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

  if [ $? -ne 0 ]; then
    echo "❌ Task definition registration failed"
    exit 1
  fi

  # Clean up temp file
  rm -f task-definition-deploy.json

  echo "✅ New task definition registered: $TASK_DEF_ARN"

  # Update ECS service to use new task definition
  echo "🔄 Updating service to use new task definition..."
  aws ecs update-service \
    --cluster $CLUSTER_NAME \
    --service $SERVICE_NAME \
    --task-definition $TASK_DEF_ARN \
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

echo "⏱️ Deployment initiated! Checking initial status..."
sleep 5

echo ""
echo "📊 Current Service Status:"
aws ecs describe-services \
  --cluster $CLUSTER_NAME \
  --services $SERVICE_NAME \
  --region $AWS_REGION \
  --query 'services[0].{Desired:desiredCount,Running:runningCount,Status:status,LatestDeployment:deployments[0].rolloutState}' \
  --output table

echo ""
echo "✅ Deployment Successfully Initiated!"
echo ""
echo "📋 Next Steps:"
echo "🔍 Monitor logs: aws logs tail /ecs/elowardbot --follow --region $AWS_REGION"
echo "📊 Check status: aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $AWS_REGION"
echo "📊 ECS Console: https://${AWS_REGION}.console.aws.amazon.com/ecs/home?region=${AWS_REGION}#/clusters/${CLUSTER_NAME}/services"
echo ""
echo "⏳ Deployment typically takes 1-3 minutes to complete."
