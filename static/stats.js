class StatsForNerds {
    constructor(room) {
        this.room = room;
        this.element = document.createElement("div");
        this.element.id = "stats-for-nerds";
        this.element.className = "hidden";
        document.body.appendChild(this.element);
        this.interval = null;
        this.lastStats = null;

        document.addEventListener("keydown", (e) => {
            if (e.shiftKey && e.key.toLowerCase() === 's') {
                this.toggle();
            }
        });
    }

    toggle() {
        if (this.element.classList.contains("hidden")) {
            this.element.classList.remove("hidden");
            this.startPolling();
        } else {
            this.element.classList.add("hidden");
            this.stopPolling();
        }
    }

    startPolling() {
        this.lastStats = null;
        this.updateStats();
        this.interval = setInterval(() => this.updateStats(), 1000);
    }

    stopPolling() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    async updateStats() {
        let pc = null;
        if (this.room.client instanceof Viewer) {
            pc = this.room.client.broadcasterPeerConnection;
        } else if (this.room.client instanceof Broadcaster) {
            const viewerKeys = Object.keys(this.room.client.viewers);
            if (viewerKeys.length > 0) {
                pc = this.room.client.viewers[viewerKeys[0]];
            }
        }

        if (!pc) {
            this.element.innerHTML = "No active connection";
            return;
        }

        const stats = await pc.getStats();
        let html = "";
        let videoStat = null;
        let candidatePair = null;
        let remoteInbound = null;
        const codecs = new Map();
        const localCandidates = new Map();
        const remoteCandidates = new Map();

        stats.forEach(report => {
            if ((report.type === "inbound-rtp" || report.type === "outbound-rtp") && report.kind === "video") {
                videoStat = report;
            } else if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
                candidatePair = report;
            } else if (report.type === "candidate-pair" && report.state === "succeeded" && !candidatePair) {
                candidatePair = report;
            } else if (report.type === "codec") {
                codecs.set(report.id, report);
            } else if (report.type === "remote-inbound-rtp" && report.kind === "video") {
                remoteInbound = report;
            } else if (report.type === "local-candidate") {
                localCandidates.set(report.id, report);
            } else if (report.type === "remote-candidate") {
                remoteCandidates.set(report.id, report);
            }
        });

        let bitrate = 0;
        let byteCount = 0;
        if (videoStat) {
            byteCount = videoStat.bytesReceived || videoStat.bytesSent || 0;
            if (this.lastStats) {
                const bytesPast = this.lastStats.bytes || 0;
                const timeDiff = videoStat.timestamp - this.lastStats.timestamp;
                if (timeDiff > 0) {
                    bitrate = (byteCount - bytesPast) * 8 / timeDiff;
                }
            }
            this.lastStats = { bytes: byteCount, timestamp: videoStat.timestamp };
        }

        const isViewer = this.room.client instanceof Viewer;
        html += `Role: ${isViewer ? "Viewer (Inbound)" : "Broadcaster (Outbound)"}<br/>`;

        if (videoStat) {
            html += `<br/><strong style='color:var(--accent-primary)'>Video</strong><br/>`;
            html += `Resolution: ${videoStat.frameWidth || 0}x${videoStat.frameHeight || 0}<br/>`;
            html += `Framerate: ${videoStat.framesPerSecond || 0} fps<br/>`;
            html += `Bitrate: ${Math.round(bitrate)} kbps<br/>`;
            html += `Total Data: ${(byteCount / 1024 / 1024).toFixed(2)} MB<br/>`;

            const codec = codecs.get(videoStat.codecId);
            if (codec) {
                html += `Codec: ${codec.mimeType ? codec.mimeType.split('/')[1] : 'Unknown'} `;
                if (codec.clockRate) html += `(${codec.clockRate} Hz)<br/>`;
                else html += `<br/>`;
            }

            if (isViewer) {
                if (videoStat.framesDecoded !== undefined) html += `Frames Decoded: ${videoStat.framesDecoded}<br/>`;
                if (videoStat.keyFramesDecoded !== undefined) html += `Keyframes Decoded: ${videoStat.keyFramesDecoded}<br/>`;
                if (videoStat.framesDropped !== undefined) html += `Frames Dropped: ${videoStat.framesDropped}<br/>`;
                if (videoStat.jitter !== undefined) html += `Jitter: ${(videoStat.jitter * 1000).toFixed(2)} ms<br/>`;

                if (videoStat.packetsReceived) {
                    const packetsLost = videoStat.packetsLost || 0;
                    const packetLoss = (packetsLost / (packetsLost + videoStat.packetsReceived) * 100).toFixed(2);
                    html += `Packet Loss: ${packetsLost} (${packetLoss}%)<br/>`;
                }
                if (videoStat.pliCount !== undefined) html += `PLI Count: ${videoStat.pliCount}<br/>`;
                if (videoStat.firCount !== undefined) html += `FIR Count: ${videoStat.firCount}<br/>`;
                if (videoStat.nackCount !== undefined) html += `NACK Count: ${videoStat.nackCount}<br/>`;
                if (videoStat.decoderImplementation) html += `Decoder: ${videoStat.decoderImplementation}<br/>`;
            } else {
                if (videoStat.framesEncoded !== undefined) html += `Frames Encoded: ${videoStat.framesEncoded}<br/>`;
                if (videoStat.keyFramesEncoded !== undefined) html += `Keyframes Encoded: ${videoStat.keyFramesEncoded}<br/>`;
                if (videoStat.qualityLimitationReason) html += `Quality Limit: ${videoStat.qualityLimitationReason}<br/>`;

                if (videoStat.pliCount !== undefined) html += `PLI Count: ${videoStat.pliCount}<br/>`;
                if (videoStat.firCount !== undefined) html += `FIR Count: ${videoStat.firCount}<br/>`;
                if (videoStat.nackCount !== undefined) html += `NACK Count: ${videoStat.nackCount}<br/>`;
                if (videoStat.encoderImplementation) html += `Encoder: ${videoStat.encoderImplementation}<br/>`;

                if (remoteInbound) {
                    const remoteLost = remoteInbound.packetsLost || 0;
                    html += `Remote Packet Loss: ${remoteLost}<br/>`;
                    if (remoteInbound.roundTripTime) {
                        html += `Remote RTT: ${(remoteInbound.roundTripTime * 1000).toFixed(0)} ms<br/>`;
                    }
                    if (remoteInbound.jitter) {
                        html += `Remote Jitter: ${(remoteInbound.jitter * 1000).toFixed(2)} ms<br/>`;
                    }
                }
            }
        }

        if (candidatePair) {
            html += `<br/><strong style='color:var(--accent-primary)'>Network</strong><br/>`;
            if (candidatePair.currentRoundTripTime) html += `RTT: ${(candidatePair.currentRoundTripTime * 1000).toFixed(0)} ms<br/>`;
            if (candidatePair.availableOutgoingBitrate) {
                html += `Available Outgoing: ${Math.round(candidatePair.availableOutgoingBitrate / 1000)} kbps<br/>`;
            }
            if (candidatePair.availableIncomingBitrate) {
                html += `Available Incoming: ${Math.round(candidatePair.availableIncomingBitrate / 1000)} kbps<br/>`;
            }
            if (candidatePair.requestsSent !== undefined) html += `STUN Requests: ${candidatePair.requestsSent} sent, ${candidatePair.responsesReceived} received<br/>`;
            if (candidatePair.bytesSent !== undefined) html += `Bytes Sent: ${(candidatePair.bytesSent / 1024 / 1024).toFixed(2)} MB<br/>`;
            if (candidatePair.bytesReceived !== undefined) html += `Bytes Rcvd: ${(candidatePair.bytesReceived / 1024 / 1024).toFixed(2)} MB<br/>`;

            const local = localCandidates.get(candidatePair.localCandidateId);
            const remote = remoteCandidates.get(candidatePair.remoteCandidateId);

            if (local) {
                html += `Local: ${local.candidateType} (${local.protocol})<br/>`;
                html += `&nbsp;&nbsp;${local.address || local.ip}:${local.port}<br/>`;
                if (local.networkType) html += `&nbsp;&nbsp;Network: ${local.networkType}<br/>`;
            }
            if (remote) {
                html += `Remote: ${remote.candidateType} (${remote.protocol})<br/>`;
                html += `&nbsp;&nbsp;${remote.address || remote.ip}:${remote.port}<br/>`;
            }
        }

        this.element.innerHTML = html;
    }
}
