#!/bin/bash

# Configuration
IMAGE_NAME="miraishi"
CONTAINER_NAME="miraishi"
MEMORY_LIMIT="512m"
CPU_LIMIT="0.5"
PIDS_LIMIT=200

echo "Stopping and removing existing container..."
docker stop $CONTAINER_NAME 2>/dev/null
docker rm $CONTAINER_NAME 2>/dev/null

echo "Building new image..."
docker build -t $IMAGE_NAME .

if [ $? -ne 0 ]; then
    echo "Error: Build failed. Aborting."
    exit 1
fi

echo "Starting new container with resource limits..."
# Note: --network host maps ports directly to the host machine, this was a setting necesary so it worked on a minimal AWS EC2 instance
docker run -d \
  --name $CONTAINER_NAME \
  --network host \
  --restart unless-stopped \
  --memory="$MEMORY_LIMIT" \
  --cpus="$CPU_LIMIT" \
  --pids-limit=$PIDS_LIMIT \
  $IMAGE_NAME

if [ $? -eq 0 ]; then
    echo "Miraishi was successfully rebuilt and started!"
    echo "Resource limits: Memory=$MEMORY_LIMIT, CPUs=$CPU_LIMIT, PIDs=$PIDS_LIMIT"
    echo "Network Mode: Host"
else
    echo "Error: Failed to start the container."
    exit 1
fi
