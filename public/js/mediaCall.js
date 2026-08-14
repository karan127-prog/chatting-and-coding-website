/**
 * MediaCall Engine for PulseChat
 * Full Mesh Real-Time WebRTC Group Video Call Manager
 */
class MediaCallManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.screenStream = null;
    this.peers = {}; // socketId -> RTCPeerConnection
    this.isCallActive = false;
    this.isMicMuted = false;
    this.isCamOff = false;
    this.isSharingScreen = false;
    this.roomId = null;
    this.currentUser = null;

    this.localVideo = document.getElementById('local-video');
    this.modalCall = document.getElementById('modal-call');
    this.videoGrid = document.getElementById('call-video-grid');
    this.visualizers = {};

    this.bindCallControls();
    this.initSocketEvents();
  }

  bindCallControls() {
    document.getElementById('btn-toggle-mic')?.addEventListener('click', () => this.toggleMic());
    document.getElementById('btn-toggle-cam')?.addEventListener('click', () => this.toggleCam());
    document.getElementById('btn-toggle-share')?.addEventListener('click', () => this.toggleScreenShare());
    document.getElementById('btn-record-call')?.addEventListener('click', () => this.toggleRecording());
    document.getElementById('btn-end-call')?.addEventListener('click', () => this.endCall());
  }

  initSocketEvents() {
    // When someone joins the call, create an offer and send it to them
    this.socket.on('user_joined_call', async ({ socketId, username, avatar }) => {
      if (!this.isCallActive) return;
      this.createPeerConnection(socketId, username, avatar, true);
    });

    this.socket.on('call_incoming', async ({ signal, from, callerName, callerAvatar }) => {
      if (!this.isCallActive) return; // Ignore if we haven't joined the call
      await this.handleOffer(signal, from, callerName, callerAvatar);
    });

    this.socket.on('call_accepted', async ({ signal, from }) => {
      if (this.peers[from]) {
        try {
          await this.peers[from].setRemoteDescription(new RTCSessionDescription(signal));
        } catch (e) {
          console.error('Failed to set remote description on call accepted', e);
        }
      }
    });

    this.socket.on('ice_candidate_received', async ({ candidate, from }) => {
      if (this.peers[from]) {
        try {
          await this.peers[from].addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding received ice candidate', e);
        }
      }
    });

    this.socket.on('user_left_call', ({ socketId }) => {
      this.removePeer(socketId);
    });
  }

  async startCall(roomId, currentUser) {
    this.roomId = roomId;
    this.currentUser = currentUser;
    this.modalCall.classList.add('active');
    this.isCallActive = true;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      this.localVideo.srcObject = this.localStream;
      this.startAudioVisualizer('local-audio-canvas');
    } catch (err) {
      console.error(err);
      alert('Could not access camera/microphone. Please ensure you have given permissions.');
      this.endCall();
      return;
    }

    // Broadcast to the room that we've joined
    this.socket.emit('join_call', { roomId });
  }

  createPeerConnection(targetSocketId, username, avatar, isInitiator = false) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    });

    this.peers[targetSocketId] = pc;
    this.createVideoElement(targetSocketId, username);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice_candidate', { to: targetSocketId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const remoteVid = document.getElementById(`video-${targetSocketId}`);
      if (remoteVid) {
        remoteVid.srcObject = event.streams[0];
        this.startAudioVisualizer(`canvas-${targetSocketId}`);
      }
    };

    const currentStream = this.isSharingScreen && this.screenStream ? this.screenStream : this.localStream;
    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        pc.addTrack(track, currentStream);
      });
    }

    if (isInitiator) {
      this.makeOffer(targetSocketId);
    }

    return pc;
  }

  async makeOffer(targetSocketId) {
    const pc = this.peers[targetSocketId];
    if (!pc) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('call_user', {
        userToCall: targetSocketId,
        signalData: offer,
        from: this.socket.id,
        callerName: this.currentUser.username,
        callerAvatar: this.currentUser.avatar || '⚡',
        isVideo: true
      });
    } catch (err) {
      console.error('Error creating offer', err);
    }
  }

  async handleOffer(offerSignal, fromSocketId, callerName, callerAvatar) {
    const pc = this.createPeerConnection(fromSocketId, callerName, callerAvatar, false);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerSignal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('answer_call', {
        to: fromSocketId,
        signal: answer
      });
    } catch (err) {
      console.error('Error creating answer', err);
    }
  }

  createVideoElement(socketId, username) {
    if (document.getElementById(`card-${socketId}`)) return;

    const card = document.createElement('div');
    card.className = 'video-card';
    card.id = `card-${socketId}`;
    
    const vid = document.createElement('video');
    vid.id = `video-${socketId}`;
    vid.autoplay = true;
    vid.playsInline = true;
    
    const canvas = document.createElement('canvas');
    canvas.className = 'audio-visualizer-canvas';
    canvas.id = `canvas-${socketId}`;
    
    const tag = document.createElement('div');
    tag.className = 'video-user-tag';
    tag.innerHTML = `<span>${username}</span>`;
    
    const pipBtn = document.createElement('button');
    pipBtn.className = 'btn-call-ctrl';
    pipBtn.style.position = 'absolute';
    pipBtn.style.top = '10px';
    pipBtn.style.right = '10px';
    pipBtn.style.width = '30px';
    pipBtn.style.height = '30px';
    pipBtn.style.fontSize = '0.9rem';
    pipBtn.style.background = 'rgba(15, 23, 42, 0.6)';
    pipBtn.title = 'Picture-in-Picture';
    pipBtn.innerHTML = '🔲';
    pipBtn.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement !== vid) {
          await vid.requestPictureInPicture();
        } else {
          await document.exitPictureInPicture();
        }
      } catch (err) {
        console.error('PiP failed', err);
      }
    });
    
    card.appendChild(vid);
    card.appendChild(canvas);
    card.appendChild(tag);
    card.appendChild(pipBtn);
    
    this.videoGrid.appendChild(card);
  }

  removePeer(socketId) {
    const pc = this.peers[socketId];
    if (pc) {
      pc.close();
      delete this.peers[socketId];
    }
    const card = document.getElementById(`card-${socketId}`);
    if (card) {
      card.remove();
    }
  }

  startAudioVisualizer(canvasId) {
    if (!this.visualizers) this.visualizers = {};
    if (this.visualizers[canvasId]) return;
    this.visualizers[canvasId] = true;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const drawVisualizer = () => {
      if (!this.isCallActive || !document.getElementById(canvasId)) {
        this.visualizers[canvasId] = false;
        return;
      }

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
  async toggleRecording() {
    const btn = document.getElementById('btn-record-call');
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
      btn.classList.remove('active');
      btn.innerHTML = '⏺️';
      window.showToast?.('Recording saved to your downloads!', 'success');
      return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.mediaRecorder = new MediaRecorder(displayStream);
      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `PulseChat_Recording_${new Date().getTime()}.webm`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        
        displayStream.getTracks().forEach(track => track.stop());
      };

      this.mediaRecorder.start();
      btn.classList.add('active');
      btn.innerHTML = '⏹️';
      window.showToast?.('Recording started', 'success');
    } catch (e) {
      console.error('Failed to start recording', e);
      window.showToast?.('Could not capture screen for recording.', 'error');
    }
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
    const btn = document.getElementById('btn-toggle-share');

    if (this.isSharingScreen) {
      this.isSharingScreen = false;
      btn.classList.remove('active-off');
      btn.innerText = '🖥️';

      if (this.screenStream) {
        this.screenStream.getTracks().forEach(t => t.stop());
      }
      
      if (this.localStream) {
        const originalVideoTrack = this.localStream.getVideoTracks()[0];
        this.localVideo.srcObject = this.localStream;
        Object.values(this.peers).forEach(pc => {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(originalVideoTrack);
        });
      }
      return;
    }

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      this.localVideo.srcObject = this.screenStream;
      this.isSharingScreen = true;
      btn.classList.add('active-off');
      btn.innerText = '❌ Share';
      
      const videoTrack = this.screenStream.getVideoTracks()[0];
      Object.values(this.peers).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(videoTrack);
      });

      videoTrack.onended = () => {
        if (this.isSharingScreen) this.toggleScreenShare();
      };
    } catch (err) {
      console.warn('Screen sharing cancelled or unavailable');
    }
  }

  endCall() {
    this.isCallActive = false;
    this.modalCall.classList.remove('active');

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop());
    }

    Object.keys(this.peers).forEach(socketId => {
      this.removePeer(socketId);
    });

    this.localVideo.srcObject = null;
    if (this.roomId) {
      this.socket.emit('end_call', { roomId: this.roomId });
    }
    this.roomId = null;
    this.isSharingScreen = false;
    document.getElementById('btn-toggle-share').innerText = '🖥️';
    document.getElementById('btn-toggle-share').classList.remove('active-off');
  }
}

window.MediaCallManager = MediaCallManager;
