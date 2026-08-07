/**
 * MediaCall Engine for PulseChat
 * WebRTC Video/Audio Call Manager with dynamic canvas visualizers and fallbacks
 */
class MediaCallManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.peerConnection = null;
    this.isCallActive = false;
    this.isMicMuted = false;
    this.isCamOff = false;

    this.localVideo = document.getElementById('local-video');
    this.remoteVideo = document.getElementById('remote-video');
    this.modalCall = document.getElementById('modal-call');

    this.initSocketEvents();
  }

  initSocketEvents() {
    this.socket.on('call_incoming', ({ signal, from, callerName, callerAvatar, isVideo }) => {
      if (confirm(`📞 Incoming Video Call from ${callerName}! Accept?`)) {
        this.startCall(true, from);
      }
    });

    this.socket.on('call_accepted', (signal) => {
      console.log('Call accepted by remote peer');
    });

    this.socket.on('call_ended', () => {
      this.endCall();
      alert('The call has been ended.');
    });
  }

  async startCall(isIncoming = false, targetPeerId = null) {
    this.modalCall.classList.add('active');
    this.isCallActive = true;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      this.localVideo.srcObject = this.localStream;
    } catch (err) {
      console.warn('Camera/Microphone not available, initializing interactive demo video feed.');
      this.createDemoCanvasStream();
    }

    this.startAudioVisualizer('local-audio-canvas');

    if (!isIncoming) {
      this.simulateRemotePeerFeed();
    }
  }

  createDemoCanvasStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    let hue = 0;
    const drawDemo = () => {
      if (!this.isCallActive) return;
      hue = (hue + 1) % 360;
      ctx.fillStyle = `hsl(${hue}, 60%, 15%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡ Live Camera Stream', canvas.width / 2, canvas.height / 2 - 20);
      ctx.fillStyle = '#a855f7';
      ctx.font = '16px Inter, sans-serif';
      ctx.fillText(new Date().toLocaleTimeString(), canvas.width / 2, canvas.height / 2 + 20);

      requestAnimationFrame(drawDemo);
    };

    drawDemo();
    const demoStream = canvas.captureStream(30);
    this.localVideo.srcObject = demoStream;
    this.localStream = demoStream;
  }

  simulateRemotePeerFeed() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    let radius = 20;
    let expanding = true;

    const drawRemote = () => {
      if (!this.isCallActive) return;

      if (expanding) {
        radius += 0.5;
        if (radius > 50) expanding = false;
      } else {
        radius -= 0.5;
        if (radius < 20) expanding = true;
      }

      ctx.fillStyle = '#0d1322';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Glowing aura
      const grad = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 5, canvas.width / 2, canvas.height / 2, radius * 3);
      grad.addColorStop(0, 'rgba(99, 102, 241, 0.4)');
      grad.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#6366f1';
      ctx.beginPath();
      ctx.arc(canvas.width / 2, canvas.height / 2, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 20px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🤖 PulseBot Connected Feed', canvas.width / 2, canvas.height / 2 + 90);

      requestAnimationFrame(drawRemote);
    };

    drawRemote();
    const remoteStream = canvas.captureStream(30);
    this.remoteVideo.srcObject = remoteStream;
    this.startAudioVisualizer('remote-audio-canvas');
  }

  startAudioVisualizer(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const drawVisualizer = () => {
      if (!this.isCallActive) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 16;
      const barWidth = canvas.width / bars;

      for (let i = 0; i < bars; i++) {
        const height = Math.random() * (canvas.height * 0.4);
        ctx.fillStyle = i % 2 === 0 ? 'rgba(99, 102, 241, 0.6)' : 'rgba(6, 182, 212, 0.6)';
        ctx.fillRect(i * barWidth, canvas.height - height, barWidth - 2, height);
      }

      setTimeout(() => {
        if (this.isCallActive) requestAnimationFrame(drawVisualizer);
      }, 100);
    };

    drawVisualizer();
  }

  toggleMic() {
    this.isMicMuted = !this.isMicMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => (track.enabled = !this.isMicMuted));
    }
    const btn = document.getElementById('btn-toggle-mic');
    if (this.isMicMuted) {
      btn.classList.add('active-off');
      btn.innerText = '🔇';
    } else {
      btn.classList.remove('active-off');
      btn.innerText = '🎙️';
    }
  }

  toggleCam() {
    this.isCamOff = !this.isCamOff;
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track) => (track.enabled = !this.isCamOff));
    }
    const btn = document.getElementById('btn-toggle-cam');
    if (this.isCamOff) {
      btn.classList.add('active-off');
      btn.innerText = '🚫';
    } else {
      btn.classList.remove('active-off');
      btn.innerText = '📷';
    }
  }

  async toggleScreenShare() {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      this.localVideo.srcObject = screenStream;
    } catch (err) {
      console.warn('Screen sharing cancelled or unavailable');
    }
  }

  endCall() {
    this.isCallActive = false;
    this.modalCall.classList.remove('active');

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }

    this.localVideo.srcObject = null;
    this.remoteVideo.srcObject = null;

    this.socket.emit('end_call', { to: 'all' });
  }
}

window.MediaCallManager = MediaCallManager;
