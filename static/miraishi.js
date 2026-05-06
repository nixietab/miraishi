function wait(target, listenerName) {
    return new Promise((resolve) => {
        const listener = (event) => {
            target.removeEventListener(listenerName, listener);
            resolve(event);
        };
        target.addEventListener(listenerName, listener);
    });
}

function showPopup(name) {
    const element = document.getElementById(name);
    if (element) element.classList.remove("hidden");
}

function hidePopup(name) {
    const element = document.getElementById(name);
    if (element) element.classList.add("hidden");
}

class Broadcaster {
    constructor(sendMessage, rtcConfig, mediaStream) {
        this.onviewerjoin = null;
        this.onviewerleave = null;
        this.sendMessage = sendMessage;
        this.rtcConfig = rtcConfig;
        this.mediaStream = mediaStream;
        this.viewers = {};
    }

    async handleMessage(msg) {
        switch (msg.type) {
            case "viewer": await this.addViewer(msg.viewerId); break;
            case "viewerdisconnected": await this.removeViewer(msg.viewerId); break;
            case "webrtcbroadcaster": await this.handleWebRTCMessage(msg); break;
        }
    }

    async addViewer(viewerId) {
        const viewerConnection = new RTCPeerConnection(this.rtcConfig);
        this.mediaStream.getTracks().forEach(t => viewerConnection.addTrack(t, this.mediaStream));

        viewerConnection.onicecandidate = (e) => {
            if (e.candidate) this.sendMessage({ type: "webrtcbroadcaster", kind: "candidate", viewerId, message: e.candidate });
        };

        const offer = await viewerConnection.createOffer();
        await viewerConnection.setLocalDescription(offer);
        await this.sendMessage({ type: "webrtcbroadcaster", kind: "offer", viewerId, message: viewerConnection.localDescription });

        this.viewers[viewerId] = viewerConnection;
        if (this.onviewerjoin) this.onviewerjoin(viewerId);
    }

    async removeViewer(viewerId) {
        if (this.viewers[viewerId]) {
            this.viewers[viewerId].close();
            delete this.viewers[viewerId];
            if (this.onviewerleave) this.onviewerleave(viewerId);
        }
    }

    async handleWebRTCMessage(msg) {
        const v = this.viewers[msg.viewerId];
        if (!v) return;
        if (msg.kind === "candidate") await v.addIceCandidate(new RTCIceCandidate(msg.message));
        else if (msg.kind === "answer") await v.setRemoteDescription(msg.message);
    }
}

class Viewer {
    constructor(sendMessage, rtcConfig, videoElement) {
        this.sendMessage = sendMessage;
        this.rtcConfig = rtcConfig;
        this.videoElement = videoElement;
        this.broadcasterPeerConnection = null;
    }

    async handleMessage(msg) {
        if (msg.type === "broadcasterdisconnected") {
            showPopup("broadcaster-disconnected");
            if (this.videoElement.parentNode) this.videoElement.parentNode.removeChild(this.videoElement);
        } else if (msg.type === "webrtcviewer") {
            if (msg.kind === "candidate" && this.broadcasterPeerConnection) await this.broadcasterPeerConnection.addIceCandidate(new RTCIceCandidate(msg.message));
            else if (msg.kind === "offer") await this.handleOffer(msg);
        }
    }

    async handleOffer(msg) {
        this.broadcasterPeerConnection = new RTCPeerConnection(this.rtcConfig);
        this.broadcasterPeerConnection.ontrack = (e) => {
            this.videoElement.srcObject = e.streams[0];
            this.videoElement.style.display = "block";
        };
        this.broadcasterPeerConnection.onicecandidate = (e) => {
            if (e.candidate) this.sendMessage({ type: "webrtcviewer", kind: "candidate", message: e.candidate });
        };
        await this.broadcasterPeerConnection.setRemoteDescription(msg.message);
        const answer = await this.broadcasterPeerConnection.createAnswer();
        await this.broadcasterPeerConnection.setLocalDescription(answer);
        await this.sendMessage({ type: "webrtcviewer", kind: "answer", message: this.broadcasterPeerConnection.localDescription });
    }
}

class Room {
    constructor(roomId) {
        this.roomId = roomId;
        this.videoElement = document.getElementById("stream");
        const protocol = window.location.protocol === "http:" ? "ws" : "wss";
        this.webSocket = new WebSocket(`${protocol}://${location.host}${location.pathname}`);
        this.webSocket.onerror = () => showPopup("websocket-connect-failed");
        this.sendMessage = async (m) => { if (this.webSocket.readyState === 1) this.webSocket.send(JSON.stringify(m)); };
        this.rtcConfig = null;
    }

    async join() {
        try {
            const resp = await fetch("/config");
            this.rtcConfig = await resp.json();
        } catch (e) {
            console.error("Failed to fetch ICE config", e);
            showPopup("websocket-connect-failed");
            return;
        }

        if (this.webSocket.readyState !== 1) {
            await wait(this.webSocket, "open");
        }

        this.webSocket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            const isBroadcaster = data.type === "broadcast";
            if (isBroadcaster && !("getDisplayMedia" in navigator.mediaDevices)) {
                showPopup("screensharing-not-supported");
                return;
            }
            const client = isBroadcaster ? await this.setupBroadcaster() : await this.setupViewer();
            this.client = client;
            if (!this.statsForNerds) {
                this.statsForNerds = new StatsForNerds(this);
            }
            this.webSocket.onmessage = (e) => client.handleMessage(JSON.parse(e.data));
            if (isBroadcaster) await this.sendMessage({ type: "requestviewers" });
            this.setDocumentTitle();
        };
        await this.sendMessage({ type: "join", roomId: this.roomId.toLowerCase() });
    }

    setDocumentTitle() { document.title = this.roomId.split(/(?=[A-Z])/).join(" ") + " | Miraishi"; }

    async setupBroadcaster() {
        const stream = await this.getDisplayMediaStream();
        const b = new Broadcaster(this.sendMessage, this.rtcConfig, stream);
        const counter = document.createElement("p");
        counter.id = "counter";
        counter.innerText = "0";

        const updateCounter = () => {
            counter.innerText = Object.keys(b.viewers).length.toString();
        };

        b.onviewerjoin = updateCounter;
        b.onviewerleave = updateCounter;

        document.body.prepend(counter);
        this.videoElement.srcObject = stream;
        this.videoElement.style.display = "block";
        return b;
    }

    async setupViewer() { return new Viewer(this.sendMessage, this.rtcConfig, this.videoElement); }

    async getDisplayMediaStream() {
        showPopup("click-to-share");
        await wait(document, "click");
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            hidePopup("click-to-share");
            return stream;
        } catch (e) {
            hidePopup("click-to-share");
            showPopup("access-denied");
            throw e;
        }
    }
}


function generateRoomName() {
    const adjs = [
        "Fast", "Bright", "Cool", "Clever", "Swift", "Sharp", "Silent", "Vivid", "Wild", "Soft",
        "Brave", "Calm", "Kind", "Bold", "Fair", "Wise", "Grand", "Proud", "Light", "Dark",
        "Green", "Blue", "Red", "Gold", "Silver", "Pure", "Rare", "Quick", "Eager", "Tiny"
    ];
    const nouns = [
        "Bird", "Moon", "Star", "Cloud", "Sun", "Lake", "Palm", "Leaf", "Mist", "Soul",
        "Hawk", "Wolf", "Deer", "Wind", "Rain", "Fire", "Ice", "Rock", "Tree", "Seed",
        "Song", "Dream", "Wave", "Gate", "Path", "Road", "Peak", "Valley", "Ocean", "River"
    ];

    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    // We combine 2 adjectives and 2 nouns for 4 words total.
    // 30 * 30 * 30 * 30 = 810,000 combinations.
    return pick(adjs) + pick(adjs) + pick(nouns) + pick(nouns);
}

window.addEventListener("DOMContentLoaded", async () => {
    if (!window.location.hash) {
        window.location.replace("#" + generateRoomName());
    }

    window.onhashchange = () => location.reload();
    if (!("WebSocket" in window) || !("mediaDevices" in navigator)) {
        showPopup("webrtc-not-supported");
        return;
    }
    const room = new Room(window.location.hash.substring(1));
    await room.join();
});
