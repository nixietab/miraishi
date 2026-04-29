#!/bin/bash
echo "    Miraishi Configuration Setup      "
echo "======================================"

# Check for required files
if [ ! -f "config.json" ]; then
    echo "Creating default config.json..."
    cat > config.json << EOF
{
    "port": 8080,
    "realm": "miraishi",
    "turn_user": "miraishi",
    "turn_pass": "YOUR_STRONG_PASSWORD",
    "turn_secret": "",
    "public_domain": "yourdomain.com",
    "max_rooms": 100,
    "max_viewers_per_room": 200
}
EOF
fi

if [ ! -f "turnserver.conf" ]; then
    echo "Error: turnserver.conf not found in the current directory."
    exit 1
fi

WHITE='\033[1;37m'
NC='\033[0m'

# Ask for domain
printf "${WHITE}Enter your public domain (e.g., example.com) or localhost:${NC} "
read DOMAIN

if [ -z "$DOMAIN" ]; then
    echo "Domain cannot be empty. Exiting."
    exit 1
fi

# Update domain in config.json
sed -i "s/\"public_domain\": \".*\"/\"public_domain\": \"$DOMAIN\"/g" config.json

# Ask for max rooms
printf "${WHITE}Enter max rooms [100]:${NC} "
read MAX_ROOMS
MAX_ROOMS=${MAX_ROOMS:-100}
sed -i "s/\"max_rooms\": [0-9]*/\"max_rooms\": $MAX_ROOMS/g" config.json

# Ask for max viewers per room
printf "${WHITE}Enter max viewers per room [200]:${NC} "
read MAX_VIEWERS
MAX_VIEWERS=${MAX_VIEWERS:-200}
sed -i "s/\"max_viewers_per_room\": [0-9]*/\"max_viewers_per_room\": $MAX_VIEWERS/g" config.json

# Ask about keys
echo ""
echo "Miraishi requires secure credentials for the TURN server (used for WebRTC relay)."
echo "We can automatically generate a secure TURN REST API secret and configure both"
echo "the Go backend and the Coturn server for you."
printf "${WHITE}Do you want to automatically generate and set secure keys? [Y/n]${NC} "
read AUTO_KEYS

AUTO_KEYS=${AUTO_KEYS:-Y}

if [[ "$AUTO_KEYS" =~ ^[Yy]$ ]]; then
    echo "Generating secure keys..."
    
    # Generate a random 32 character string
    if command -v openssl &> /dev/null; then
        SECRET=$(openssl rand -hex 16)
    else
        SECRET=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 32)
    fi
    
    # Update config.json
    sed -i "s/\"turn_secret\": \".*\"/\"turn_secret\": \"$SECRET\"/g" config.json
    sed -i "s/\"turn_pass\": \".*\"/\"turn_pass\": \"\"/g" config.json
    
    # Update turnserver.conf
    # Remove any existing user= or use-auth-secret/static-auth-secret
    sed -i '/^user=/d' turnserver.conf
    sed -i '/^use-auth-secret/d' turnserver.conf
    sed -i '/^static-auth-secret=/d' turnserver.conf
    
    # Add new auth secret configuration
    echo "use-auth-secret" >> turnserver.conf
    echo "static-auth-secret=$SECRET" >> turnserver.conf
    
    echo "Keys generated and configured successfully!"
else
    echo "Skipping key generation. You will need to manually configure:"
    echo "  - config.json (turn_pass or turn_secret)"
    echo "  - turnserver.conf (user= or use-auth-secret/static-auth-secret)"
fi

echo ""
echo "Setup complete! You can now run ./rebuild.sh to build and start Miraishi"
echo "Or follow the steps to run without docker"
printf "${WHITE}Don't forget to set up your Nginx/Reverse Proxy!${NC}\n"
