class CollaborativeWhiteboard {
  constructor(socket) {
    this.socket = socket;
    this.canvas = document.getElementById('whiteboard-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    
    this.colorInput = document.getElementById('wb-color');
    this.sizeInput = document.getElementById('wb-size');
    this.clearBtn = document.getElementById('wb-clear');
    
    this.currentTool = 'brush'; // 'brush', 'rect', 'circle', 'arrow', 'text', 'eraser'
    this.isDrawing = false;
    this.startX = 0;
    this.startY = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.snapshot = null;
    this.roomId = null;

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    this.initToolButtons();
    this.bindEvents();
    this.initSocketEvents();
  }

  setRoomId(roomId) {
    this.roomId = roomId;
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const imgData = this.ctx.getImageData(0, 0, this.canvas.width || 1, this.canvas.height || 1);
    this.canvas.width = this.canvas.parentElement.clientWidth || 800;
    this.canvas.height = this.canvas.parentElement.clientHeight || 600;
    try { this.ctx.putImageData(imgData, 0, 0); } catch(e){}
  }

  initToolButtons() {
    const toolBtns = document.querySelectorAll('.wb-tool-btn');
    toolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        toolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentTool = btn.getAttribute('data-tool') || 'brush';
      });
    });
  }

  getPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (e.touches && e.touches.length > 0) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      };
    }
    return {
      x: e.offsetX !== undefined ? e.offsetX : (e.clientX - rect.left),
      y: e.offsetY !== undefined ? e.offsetY : (e.clientY - rect.top)
    };
  }

  bindEvents() {
    const onStart = (e) => {
      e.preventDefault();
      const pos = this.getPos(e);
      this.isDrawing = true;
      this.startX = pos.x;
      this.startY = pos.y;
      this.lastX = pos.x;
      this.lastY = pos.y;

      if (this.currentTool === 'text') {
        this.isDrawing = false;
        const text = prompt('Enter text note for whiteboard:');
        if (text && text.trim()) {
          const color = this.colorInput ? this.colorInput.value : '#38bdf8';
          const size = parseInt(this.sizeInput ? this.sizeInput.value : '3', 10);
          this.drawText(text.trim(), pos.x, pos.y, color, size, true);
        }
        return;
      }

      if (['rect', 'circle', 'arrow'].includes(this.currentTool)) {
        this.snapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      }
    };

    const onMove = (e) => {
      if (!this.isDrawing) return;
      e.preventDefault();
      const pos = this.getPos(e);
      const color = this.currentTool === 'eraser' ? '#0f172a' : (this.colorInput ? this.colorInput.value : '#38bdf8');
      const size = parseInt(this.sizeInput ? this.sizeInput.value : '3', 10) * (this.currentTool === 'eraser' ? 4 : 1);

      if (this.currentTool === 'brush' || this.currentTool === 'eraser') {
        this.drawLine(this.lastX, this.lastY, pos.x, pos.y, color, size, true);
        this.lastX = pos.x;
        this.lastY = pos.y;
      } else if (['rect', 'circle', 'arrow'].includes(this.currentTool) && this.snapshot) {
        this.ctx.putImageData(this.snapshot, 0, 0);
        this.drawShapePreview(this.currentTool, this.startX, this.startY, pos.x, pos.y, color, size);
      }
    };

    const onEnd = (e) => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      const pos = this.getPos(e);
      const color = this.colorInput ? this.colorInput.value : '#38bdf8';
      const size = parseInt(this.sizeInput ? this.sizeInput.value : '3', 10);

      if (['rect', 'circle', 'arrow'].includes(this.currentTool) && this.snapshot) {
        this.ctx.putImageData(this.snapshot, 0, 0);
        this.drawShape(this.currentTool, this.startX, this.startY, pos.x, pos.y, color, size, true);
        this.snapshot = null;
      }
    };

    this.canvas.addEventListener('mousedown', onStart);
    this.canvas.addEventListener('mousemove', onMove);
    this.canvas.addEventListener('mouseup', onEnd);
    this.canvas.addEventListener('mouseleave', onEnd);

    this.canvas.addEventListener('touchstart', onStart, { passive: false });
    this.canvas.addEventListener('touchmove', onMove, { passive: false });
    this.canvas.addEventListener('touchend', onEnd);

    this.clearBtn?.addEventListener('click', () => {
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
    this.ctx.lineJoin = 'round';
    this.ctx.stroke();
    this.ctx.closePath();

    if (!emit || !this.roomId) return;
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

  drawShapePreview(shapeType, x0, y0, x1, y1, color, size) {
    this.ctx.beginPath();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = size;
    this.ctx.fillStyle = color + '22';

    if (shapeType === 'rect') {
      const w = x1 - x0;
      const h = y1 - y0;
      this.ctx.strokeRect(x0, y0, w, h);
      this.ctx.fillRect(x0, y0, w, h);
    } else if (shapeType === 'circle') {
      const rx = Math.abs(x1 - x0) / 2;
      const ry = Math.abs(y1 - y0) / 2;
      const cx = Math.min(x0, x1) + rx;
      const cy = Math.min(y0, y1) + ry;
      this.ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.fill();
    } else if (shapeType === 'arrow') {
      this.drawArrowLine(x0, y0, x1, y1, size);
    }
    this.ctx.closePath();
  }

  drawShape(shapeType, x0, y0, x1, y1, color, size, emit) {
    this.drawShapePreview(shapeType, x0, y0, x1, y1, color, size);

    if (!emit || !this.roomId) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.socket.emit('wb_draw_shape', {
      roomId: this.roomId,
      shapeType,
      x0: x0 / w,
      y0: y0 / h,
      x1: x1 / w,
      y1: y1 / h,
      color,
      size
    });
  }

  drawArrowLine(x0, y0, x1, y1, size) {
    const headlen = Math.max(12, size * 3);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const angle = Math.atan2(dy, dx);
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y0);
    this.ctx.lineTo(x1, y1);
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x1 - headlen * Math.cos(angle - Math.PI / 6), y1 - headlen * Math.sin(angle - Math.PI / 6));
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x1 - headlen * Math.cos(angle + Math.PI / 6), y1 - headlen * Math.sin(angle + Math.PI / 6));
    this.ctx.stroke();
  }

  drawText(text, x, y, color, size, emit) {
    const fontSize = Math.max(14, size * 4 + 10);
    this.ctx.font = `600 ${fontSize}px "Outfit", -apple-system, BlinkMacSystemFont, sans-serif`;
    
    // Draw background tag for readability
    this.ctx.textBaseline = 'top';
    const metrics = this.ctx.measureText(text);
    const padding = 6;
    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.roundRect 
      ? this.ctx.roundRect(x - padding, y - padding, metrics.width + padding * 2, fontSize + padding * 2, 6)
      : this.ctx.rect(x - padding, y - padding, metrics.width + padding * 2, fontSize + padding * 2);
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.fillStyle = color;
    this.ctx.fillText(text, x, y);

    if (!emit || !this.roomId) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.socket.emit('wb_draw_text', {
      roomId: this.roomId,
      text,
      x: x / w,
      y: y / h,
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

    this.socket.on('wb_draw_shape_received', (data) => {
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.drawShape(data.shapeType, data.x0 * w, data.y0 * h, data.x1 * w, data.y1 * h, data.color, data.size, false);
    });

    this.socket.on('wb_draw_text_received', (data) => {
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.drawText(data.text, data.x * w, data.y * h, data.color, data.size, false);
    });

    this.socket.on('wb_clear_received', () => {
      this.clearBoard(false);
    });
  }
}

window.CollaborativeWhiteboard = CollaborativeWhiteboard;
