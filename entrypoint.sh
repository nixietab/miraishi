#!/bin/sh

# Start Coturn in the background
turnserver -c /etc/coturn/turnserver.conf &

# Start the Go application
/app/miraishi
