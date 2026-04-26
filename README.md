# Miraishi

Miraishi is a simple and lightweight peer-to-peer screensharing solution. Built with Go and WebRTC to run on potatoes, it allows you to share your screen directly from your browser without anything else.

Miraishi is a former fork of [screensy](https://github.com/screensy/screensy)

## Installation

### Using Docker

If you have Docker installed, you can get Miraishi running in seconds:

```bash
git clone https://github.com/nixietab/miraishi
cd miraishi
./rebuild.sh
```

This will automatically build the image, start the signaling server, and set up the TURN server with resource limits.

### Manual Installation (without Docker)

If you prefer to run Miraishi directly on your host machine, ensure you have **Go** and **coturn** installed.

1. **Clone and build:**
   ```bash
   git clone https://github.com/nixietab/miraishi
   cd miraishi
   go build -o miraishi .
   ```

2. **Run the servers:**
   ```bash
   # Start the TURN server
   turnserver -c turnserver.conf &

   # Start Miraishi
   ./miraishi
   ```

> [!NOTE]
> Ensure you have configured `config.json` and `turnserver.conf` as described in the [Configuration](#configuration) section before starting.


## Configuration

Before deploying to production, edit `config.json` to set your domain and security settings:

```json
{
    "port": 8080,
    "realm": "miraishi",
    "turn_user": "miraishi",
    "turn_pass": "YOUR_STRONG_PASSWORD",
    "public_domain": "yourdomain.com"
}
```

> **IMPORTANT**
> Ensure that `turn_pass` in `config.json` matches the credentials in `turnserver.conf`.

## Production Setup

For production, it is you would need to use a reverse proxy like Nginx. We provide an example site [nginx.conf](nginx.conf) that handles SSL termination and WebSocket support.

### Ports Configuration

To ensure peer-to-peer connections work reliably, you must open the following ports in your hosting platform:

- **Signaling & Connectivity (STUN/TURN)**: `3478` (TCP and UDP)
- **Front End (HTTP/HTTPS)**: `80`, `443` (TCP)
- **UDP Media Relay Range**: `50000-51000` (UDP)


## License

Miraishi is open source software. See the [LICENSE](LICENSE) file for more details.
