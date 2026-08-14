class CollaborativeWhiteboard {
  constructor(socket) {
    this.socket = socket;
    this.canvas = document.getElementById('whiteboard-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    
    this.colorInput = document.getElementById('wb-color');
    this.sizeInput = document.getElementById('wb-size');
    this.clearBtn = document.getElementById('wb-clear');
    
    this.isDrawing = false;
    this.lastX = 0;
    this.lastY = 0;
    this.roomId = null;

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    this.bindEvents();
    this.initSocketEvents();
  }

  setRoomId(roomId) {
    this.roomId = roomId;
  }

  resizeCanvas() {
    if (!this.canvas) return;
    // Save image data
    const imgData = this.ctx.getImageData(0, 0, this.canvas.width || 1, this.canvas.height || 1);
    this.canvas.width = this.canvas.parentElement.clientWidth || 800;
    this.canvas.height = this.canvas.parentElement.clientHeight || 600;
    // Restore image data
    try { this.ctx.putImageData(imgData, 0, 0); } catch(e){}
  }

  bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDrawing = true;
      [this.lastX, this.lastY] = [e.offsetX, e.offsetY];
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.isDrawing) return;
      this.drawLine(this.lastX, this.lastY, e.offsetX, e.offsetY, this.colorInput.value, this.sizeInput.value, true);
      [this.lastX, this.lastY] = [e.offsetX, e.offsetY];
    });

    this.canvas.addEventListener('mouseup', () => this.isDrawing = false);
    this.canvas.addEventListener('mouseout', () => this.isDrawing = false);

    this.clearBtn.addEventListener('click', () => {
      this.clearBoard(true);
    });
  }

  drawLine(x0, y0, x1, y1, color, size, emit) {
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y0);
    this.ctx.lineTo(x1, y1);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = size;
    this.ctx.lineCap = 'round';
    this.ctx.stroke();
    this.ctx.closePath();

    if (!emit || !this.roomId) return;
    
    // Normalize coordinates based on canvas size for responsive drawing
    const w = this.canvas.width;
    const h = this.canvas.height;

    this.socket.emit('wb_draw', {
      roomId: this.roomId,
      x0: x0 / w,
      y0: y0 / h,
      x1: x1 / w,
      y1: y1 / h,
      color,
      size
    });
  }

  clearBoard(emit) {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (emit && this.roomId) {
      this.socket.emit('wb_clear', { roomId: this.roomId });
    }
  }

  initSocketEvents() {
    this.socket.on('wb_draw_received', (data) => {
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.drawLine(data.x0 * w, data.y0 * h, data.x1 * w, data.y1 * h, data.color, data.size, false);
    });

    this.socket.on('wb_clear_received', () => {
      this.clearBoard(false);
    });
  }
}

window.CollaborativeWhiteboard = CollaborativeWhiteboard;
