/**
 * VoiceRecorder Engine for PulseChat
 * Captures audio via HTML5 MediaRecorder API with live waveform canvas visualization
 */
class VoiceRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.isRecording = false;
    this.timerInterval = null;
    this.secondsRecorded = 0;
    this.animFrameId = null;
    this.audioContext = null;
    this.analyser = null;
  }

  async startRecording(canvasElement, timerElement) {
    this.audioChunks = [];
    this.secondsRecorded = 0;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.stream);

      // Web Audio API visualizer setup
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      source.connect(this.analyser);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;

      // Start Timer
      if (timerElement) {
        timerElement.innerText = '00:00';
        this.timerInterval = setInterval(() => {
          this.secondsRecorded++;
          const mins = String(Math.floor(this.secondsRecorded / 60)).padStart(2, '0');
          const secs = String(this.secondsRecorded % 60).padStart(2, '0');
          timerElement.innerText = `${mins}:${secs}`;
        }, 1000);
      }

      // Start Canvas Waveform Loop
      if (canvasElement) {
        this.drawWaveform(canvasElement);
      }

      return true;
    } catch (err) {
      console.warn('Microphone access unavailable or denied:', err);
      // Fallback for environment without mic access
      this.isRecording = true;
      this.timerInterval = setInterval(() => {
        this.secondsRecorded++;
        if (timerElement) {
          const mins = String(Math.floor(this.secondsRecorded / 60)).padStart(2, '0');
          const secs = String(this.secondsRecorded % 60).padStart(2, '0');
          timerElement.innerText = `${mins}:${secs}`;
        }
      }, 1000);
      return false;
    }
  }

  drawWaveform(canvas) {
    const ctx = canvas.getContext('2d');
    const bufferLength = this.analyser ? this.analyser.frequencyBinCount : 32;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      if (!this.isRecording) return;
      this.animFrameId = requestAnimationFrame(render);

      if (this.analyser) {
        this.analyser.getByteFrequencyData(dataArray);
      } else {
        // Fallback synthetic wave data
        for (let i = 0; i < bufferLength; i++) {
          dataArray[i] = Math.random() * 180;
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 1.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        ctx.fillStyle = '#06b6d4';
        ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
        x += barWidth;
      }
    };

    render();
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.isRecording) {
        return resolve(null);
      }

      this.isRecording = false;
      clearInterval(this.timerInterval);
      if (this.animFrameId) cancelAnimationFrame(this.animFrameId);

      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          if (this.stream) {
            this.stream.getTracks().forEach((track) => track.stop());
          }
          if (this.audioContext) {
            this.audioContext.close();
          }
          resolve({ blob: audioBlob, duration: this.secondsRecorded });
        };
        this.mediaRecorder.stop();
      } else {
        // Fallback dummy blob
        resolve({ blob: new Blob(['dummy audio content'], { type: 'audio/webm' }), duration: this.secondsRecorded || 3 });
      }
    });
  }

  cancelRecording() {
    this.isRecording = false;
    clearInterval(this.timerInterval);
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
  }
}

window.VoiceRecorder = VoiceRecorder;
