# 🚀 EloWard Bot - Production Deployment Guide

## Architecture Overview

**NEW: Hybrid SQS + Redis Messaging Architecture**
```
CF Worker → SQS (reliable) + Redis (fast) → Enhanced IRC Bot
```

**Benefits:**
- ✅ **No exposed ports** - Secure by default
- ✅ **Guaranteed delivery** - SQS ensures no lost messages  
- ✅ **Instant notifications** - Redis pub/sub for real-time
- ✅ **Auto-scaling** - ASG handles traffic spikes
- ✅ **Production monitoring** - CloudWatch metrics & alarms

---

## 🏗️ **Phase 1: AWS Infrastructure Setup**

### **1.1 Deploy CloudFormation Stack**

```bash
# Create the infrastructure
aws cloudformation create-stack \
  --stack-name eloward-bot-infrastructure \
  --template-body file://aws-infrastructure.yaml \
  --parameters ParameterKey=KeyName,ParameterValue=your-ec2-keypair \
  --capabilities CAPABILITY_IAM \
  --region us-west-2

# Monitor deployment
aws cloudformation describe-stacks --stack-name eloward-bot-infrastructure
```

### **1.2 Get Infrastructure Outputs**

```bash
# Get SQS Queue URL
SQS_URL=$(aws cloudformation describe-stacks \
  --stack-name eloward-bot-infrastructure \
  --query 'Stacks[0].Outputs[?OutputKey==`QueueURL`].OutputValue' \
  --output text)

# Get Redis Endpoint
REDIS_HOST=$(aws cloudformation describe-stacks \
  --stack-name eloward-bot-infrastructure \
  --query 'Stacks[0].Outputs[?OutputKey==`RedisEndpoint`].OutputValue' \
  --output text)

echo "SQS Queue URL: $SQS_URL"
echo "Redis Host: $REDIS_HOST"
```

---

## ⚙️ **Phase 2: Cloudflare Worker Configuration**

### **2.1 Add Environment Variables to CF Worker**

In your Cloudflare Worker dashboard, add these environment variables:

```bash
# AWS SQS Configuration
SQS_QUEUE_URL=https://sqs.us-west-2.amazonaws.com/ACCOUNT/eloward-bot-queue
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key

# Redis Configuration  
REDIS_URL=https://your-redis-rest-api.com
REDIS_TOKEN=your-redis-rest-token
```

### **2.2 Deploy Updated Worker**

```bash
cd /Users/sunnywang/Desktop/EloWard/Backend/workers/elowardbot
wrangler deploy
```

---

## 🤖 **Phase 3: Enhanced Bot Deployment**

### **3.1 Get EC2 Instance IP**

```bash
# Find your bot instance
INSTANCE_IP=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=EloWard-Bot-Instance" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "Bot Instance IP: $INSTANCE_IP"
```

### **3.2 Update Deployment Script**

```bash
# Update the server IP in deploy-enhanced.sh
sed -i '' "s/SERVER_IP=\"35.94.69.109\"/SERVER_IP=\"$INSTANCE_IP\"/" deploy-enhanced.sh
```

### **3.3 Deploy Enhanced Bot**

```bash
# Make script executable
chmod +x deploy-enhanced.sh

# Deploy the enhanced bot
./deploy-enhanced.sh
```

### **3.4 Configure Environment Variables**

SSH into your instance and update the environment:

```bash
ssh -i ./eloward-bot-key.pem ubuntu@$INSTANCE_IP

# Edit the environment file
nano /home/ubuntu/elowardbot/.env
```

Update with your actual values:
```bash
# Cloudflare Worker Integration
CF_WORKER_URL=https://eloward-bot.unleashai.workers.dev

# AWS Configuration
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXX
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# SQS Configuration
SQS_QUEUE_URL=https://sqs.us-west-2.amazonaws.com/123456789/eloward-bot-queue

# ElastiCache Redis Configuration
REDIS_HOST=eloward-bot.xxxxx.cache.amazonaws.com
REDIS_PORT=6379
```

### **3.5 Restart and Verify**

```bash
# Restart the bot with new configuration
pm2 restart elowardbot

# Check logs
pm2 logs elowardbot

# Verify messaging is working
pm2 logs elowardbot | grep -E "(SQS|Redis)"
```

---

## 📊 **Phase 4: Monitoring & Verification**

### **4.1 Test the Complete Flow**

1. **Enable a channel via Dashboard**
2. **Check CF Worker logs** - Should show SQS + Redis messages sent
3. **Check Bot logs** - Should show instant Redis notification + SQS backup
4. **Verify bot joins channel** - Should see immediate channel join

### **4.2 Monitor Key Metrics**

```bash
# Check SQS queue metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfVisibleMessages \
  --dimensions Name=QueueName,Value=eloward-bot-queue \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 300 \
  --statistics Average

# Check bot instance health
ssh -i ./eloward-bot-key.pem ubuntu@$INSTANCE_IP "pm2 monit"
```

### **4.3 Set Up CloudWatch Alarms**

The CloudFormation template includes basic alarms. Add more via AWS Console:

- **Bot Instance Health** - CPU, Memory, Network
- **SQS Message Backlog** - Queue depth > 100 messages
- **Redis Connection Failures** - Error rate monitoring

---

## 🔧 **Phase 5: Production Optimizations**

### **5.1 Enable Auto Scaling**

```bash
# The ASG is already configured, but you can tune it:
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name EloWard-Bot-ASG \
  --desired-capacity 2 \
  --min-size 1 \
  --max-size 5
```

### **5.2 Add Application Load Balancer** (Optional)

If you want to expose health endpoints:

```bash
# Create ALB for health checks
aws elbv2 create-load-balancer \
  --name eloward-bot-alb \
  --subnets subnet-xxx subnet-yyy \
  --security-groups sg-xxx
```

### **5.3 Set Up Log Aggregation**

```bash
# Install CloudWatch agent on instances
sudo yum install -y amazon-cloudwatch-agent

# Configure log shipping
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

---

## 🚨 **Troubleshooting**

### **Common Issues:**

**1. SQS Connection Failed**
```bash
# Check IAM permissions
aws sts get-caller-identity
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::ACCOUNT:role/EloWard-Bot-Instance-Role \
  --action-names sqs:ReceiveMessage \
  --resource-arns arn:aws:sqs:us-west-2:ACCOUNT:eloward-bot-queue
```

**2. Redis Connection Failed**
```bash
# Check security groups
aws ec2 describe-security-groups --group-names EloWard-Redis-SG

# Test Redis connectivity from instance
redis-cli -h eloward-bot.xxxxx.cache.amazonaws.com ping
```

**3. Bot Not Joining Channels**
```bash
# Check bot logs
pm2 logs elowardbot | grep -A5 -B5 "channel"

# Test CF Worker manually
curl -X POST https://eloward-bot.unleashai.workers.dev/bot/enable_internal \
  -H "X-Internal-Auth: your-bot-write-key" \
  -H "Content-Type: application/json" \
  -d '{"twitch_id":"123","channel_login":"testchannel"}'
```

---

## 🎯 **Performance Expectations**

| Metric | Target | Monitoring |
|--------|--------|------------|
| **Message Latency** | <1s (Redis), <5s (SQS) | CloudWatch |
| **Channel Join Time** | <2s after dashboard click | Bot logs |
| **Uptime** | >99.9% | ASG health checks |
| **SQS Queue Depth** | <10 messages | CloudWatch alarm |

---

## 🔄 **Rollback Plan**

If issues occur, you can instantly rollback:

```bash
# Rollback is not needed with this architecture, but if issues occur:
pm2 restart elowardbot

# Check logs for troubleshooting
pm2 logs elowardbot
```

---

## ✅ **Success Checklist**

- [ ] CloudFormation stack deployed successfully
- [ ] CF Worker updated with SQS/Redis env vars
- [ ] Enhanced bot deployed and running
- [ ] SQS messages being processed
- [ ] Redis pub/sub working for instant notifications
- [ ] Dashboard enable/disable triggers immediate channel changes
- [ ] CloudWatch monitoring active
- [ ] Auto-scaling configured
- [ ] Backup systems in place

**🎉 Congratulations! You now have a production-grade, horizontally-scalable EloWard bot infrastructure!**
