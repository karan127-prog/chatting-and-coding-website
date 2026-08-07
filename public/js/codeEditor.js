/**
 * Live Collaborative Code Studio Engine for PulseChat
 * Multi-user live synchronization, Pyodide Python 3 WebAssembly engine, interactive input(),
 * IDE auto-closing brackets/quotes, smart auto-indentation, and package loader
 */
class CollaborativeCodeStudio {
  constructor(socket) {
    this.socket = socket;
    this.currentRoomId = 'general';
    this.workspace = {
      activeFileId: 'first-py',
      files: []
    };
    this.activeUserCursors = new Map();
    this.pyodide = null;
    this.isPyodideLoading = false;

    // DOM Elements
    this.viewChat = document.querySelector('.chat-main');
    this.viewStudio = document.getElementById('code-studio-view');
    this.fileTreeList = document.getElementById('studio-file-tree');
    this.editorTextarea = document.getElementById('studio-editor-textarea');
    this.lineNumbersCol = document.getElementById('studio-line-numbers');
    this.activeFileNameTag = document.getElementById('studio-active-file-name');
    this.langSelect = document.getElementById('studio-lang-select');
    this.consoleOutput = document.getElementById('studio-console-output');
    this.previewFrame = document.getElementById('studio-html-preview');
    this.cursorsContainer = document.getElementById('studio-cursors-container');
    this.activeTabButtons = document.querySelectorAll('.studio-tab-btn');

    this.initSocketEvents();
    this.initDOMEvents();
    this.initPyodideEngine();
  }

  async initPyodideEngine() {
    if (typeof loadPyodide === 'undefined') {
      console.warn('Pyodide CDN script not present, falling back to server execution.');
      return;
    }

    try {
      this.isPyodideLoading = true;
      console.log('🐍 Initializing Pyodide Python 3 Engine...');
      this.pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/'
      });

      window.jsPythonInputPrompt = (promptText = 'Enter input:') => {
        const userInput = prompt(`🐍 Python input() prompt:\n${promptText}`) || '';
        this.appendConsoleLine(`⌨️ Input provided: ${userInput}`, 'system');
        return userInput;
      };

      await this.pyodide.runPythonAsync(`
import sys
import js
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)
warnings.filterwarnings('ignore', category=UserWarning)

def custom_input(prompt_text=""):
    if prompt_text:
        sys.stdout.write(str(prompt_text))
    val = js.jsPythonInputPrompt(str(prompt_text))
    return val

import builtins
builtins.input = custom_input
`);

      this.isPyodideLoading = false;
      console.log('✅ Pyodide Python 3 Engine ready!');
    } catch (err) {
      console.warn('Failed to load Pyodide WebAssembly engine:', err);
      this.isPyodideLoading = false;
    }
  }

  initSocketEvents() {
    this.socket.on('code_updated', ({ fileId, content, user, cursorLine, cursorCol }) => {
      const activeFile = this.getActiveFile();
      if (activeFile && activeFile.id === fileId) {
        const start = this.editorTextarea.selectionStart;
        const end = this.editorTextarea.selectionEnd;
        
        activeFile.content = content;
        this.editorTextarea.value = content;
        
        this.editorTextarea.setSelectionRange(start, end);
        this.updateLineNumbers();
      }

      if (user) {
        this.activeUserCursors.set(user.id, { ...user, cursorLine, cursorCol });
        this.renderUserCursors();
      }
    });

    this.socket.on('code_cursor_updated', ({ fileId, user, cursorLine, cursorCol }) => {
      if (user) {
        this.activeUserCursors.set(user.id, { ...user, cursorLine, cursorCol });
        this.renderUserCursors();
      }
    });

    this.socket.on('code_file_created', ({ workspace, newFile }) => {
      this.workspace = workspace;
      this.renderFileTree();
      this.loadActiveFile();
    });

    this.socket.on('code_active_file_changed', ({ fileId }) => {
      this.workspace.activeFileId = fileId;
      this.renderFileTree();
      this.loadActiveFile();
    });
  }

  initDOMEvents() {
    if (!this.editorTextarea) return;

    // Real-Time Keystroke Sync
    this.editorTextarea.addEventListener('input', () => {
      const activeFile = this.getActiveFile();
      if (!activeFile) return;

      activeFile.content = this.editorTextarea.value;
      this.updateLineNumbers();

      const { line, col } = this.getCursorPosition();

      this.socket.emit('code_change', {
        roomId: this.currentRoomId,
        fileId: activeFile.id,
        content: activeFile.content,
        cursorLine: line,
        cursorCol: col
      });
    });

    this.editorTextarea.addEventListener('keyup', () => this.broadcastCursorPosition());
    this.editorTextarea.addEventListener('click', () => this.broadcastCursorPosition());
    
    // IDE Keydown Enhancements: Auto-closing Brackets, Quotes, and Smart Indentation
    const autoPairs = {
      '(': ')',
      '[': ']',
      '{': '}',
      '"': '"',
      "'": "'"
    };

    this.editorTextarea.addEventListener('keydown', (e) => {
      const start = this.editorTextarea.selectionStart;
      const end = this.editorTextarea.selectionEnd;
      const val = this.editorTextarea.value;
      const char = e.key;

      // 1. Auto-close brackets and quotes
      if (autoPairs[char]) {
        // If text is highlighted, wrap selected text
        if (start !== end) {
          e.preventDefault();
          const selectedText = val.substring(start, end);
          const replacement = char + selectedText + autoPairs[char];
          this.editorTextarea.value = val.substring(0, start) + replacement + val.substring(end);
          this.editorTextarea.setSelectionRange(start + 1, end + 1);
          this.editorTextarea.dispatchEvent(new Event('input'));
          return;
        }

        // Skip duplicate quote/bracket if cursor is right before it
        if ((char === '"' || char === "'") && val[start] === char) {
          e.preventDefault();
          this.editorTextarea.setSelectionRange(start + 1, start + 1);
          return;
        }

        e.preventDefault();
        const closePair = autoPairs[char];
        this.editorTextarea.value = val.substring(0, start) + char + closePair + val.substring(end);
        this.editorTextarea.setSelectionRange(start + 1, start + 1);
        this.editorTextarea.dispatchEvent(new Event('input'));
        return;
      }

      // 2. Overwrite closing bracket if typed directly
      if ([')', ']', '}'].includes(char) && val[start] === char && start === end) {
        e.preventDefault();
        this.editorTextarea.setSelectionRange(start + 1, start + 1);
        return;
      }

      // 3. Smart Enter Auto-Indentation
      if (e.key === 'Enter') {
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const currentLine = val.substring(lineStart, start);
        const indentMatch = currentLine.match(/^(\s*)/);
        let indent = indentMatch ? indentMatch[1] : '';

        // Increase indent level after {, (, [, or :
        if (/[{(\[::]\s*$/.test(currentLine)) {
          indent += '  ';
        }

        e.preventDefault();
        this.editorTextarea.value = val.substring(0, start) + '\n' + indent + val.substring(end);
        this.editorTextarea.selectionStart = this.editorTextarea.selectionEnd = start + 1 + indent.length;
        this.editorTextarea.dispatchEvent(new Event('input'));
        return;
      }

      // 4. Tab key spacing
      if (e.key === 'Tab') {
        e.preventDefault();
        this.editorTextarea.value = val.substring(0, start) + '  ' + val.substring(end);
        this.editorTextarea.selectionStart = this.editorTextarea.selectionEnd = start + 2;
        this.editorTextarea.dispatchEvent(new Event('input'));
      }
    });

    this.editorTextarea.addEventListener('scroll', () => {
      this.lineNumbersCol.scrollTop = this.editorTextarea.scrollTop;
    });

    // Create New File Button
    document.getElementById('btn-studio-new-file')?.addEventListener('click', () => {
      const fileName = prompt('Enter new file name (e.g. script.py, index.js, styles.css):', 'first.py');
      if (fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        let lang = 'javascript';
        if (ext === 'py') lang = 'python';
        if (ext === 'html') lang = 'html';
        if (ext === 'css') lang = 'css';
        if (ext === 'json') lang = 'json';

        this.socket.emit('code_create_file', {
          roomId: this.currentRoomId,
          name: fileName,
          language: lang
        });
      }
    });

    // Language Selector
    this.langSelect?.addEventListener('change', () => {
      const activeFile = this.getActiveFile();
      if (activeFile) {
        activeFile.language = this.langSelect.value;
      }
    });

    // Run Code Button
    document.getElementById('btn-studio-run-code')?.addEventListener('click', () => {
      this.executeCode();
    });

    // Clear Console Output
    document.getElementById('btn-studio-clear-console')?.addEventListener('click', () => {
      this.consoleOutput.innerHTML = '<div class="console-line system">Console cleared.</div>';
    });

    // Console / Preview Tabs Switch
    this.activeTabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        this.activeTabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        if (tab === 'console') {
          this.consoleOutput.style.display = 'block';
          this.previewFrame.style.display = 'none';
        } else {
          this.consoleOutput.style.display = 'none';
          this.previewFrame.style.display = 'block';
          this.updateHTMLPreview();
        }
      });
    });

    // Download File Button
    document.getElementById('btn-studio-download-file')?.addEventListener('click', () => {
      const activeFile = this.getActiveFile();
      if (!activeFile) return;
      const blob = new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = activeFile.name;
      a.click();
    });
  }

  loadWorkspace(workspace, roomId) {
    this.workspace = workspace;
    this.currentRoomId = roomId;
    this.renderFileTree();
    this.loadActiveFile();
  }

  getActiveFile() {
    return this.workspace.files.find((f) => f.id === this.workspace.activeFileId) || this.workspace.files[0];
  }

  loadActiveFile() {
    const file = this.getActiveFile();
    if (!file) return;

    this.editorTextarea.value = file.content || '';
    this.activeFileNameTag.innerText = file.name;
    
    if (this.langSelect) {
      if (file.name.endsWith('.py')) this.langSelect.value = 'python';
      else if (file.name.endsWith('.html')) this.langSelect.value = 'html';
      else if (file.name.endsWith('.css')) this.langSelect.value = 'css';
      else if (file.name.endsWith('.json')) this.langSelect.value = 'json';
      else this.langSelect.value = file.language || 'javascript';
    }

    this.updateLineNumbers();
    this.updateHTMLPreview();
  }

  renderFileTree() {
    if (!this.fileTreeList) return;
    this.fileTreeList.innerHTML = '';

    this.workspace.files.forEach((file) => {
      const li = document.createElement('li');
      const isActive = file.id === this.workspace.activeFileId;
      li.className = `studio-file-item ${isActive ? 'active' : ''}`;
      
      let fileIcon = '📄';
      if (file.name.endsWith('.py')) fileIcon = '🐍';
      if (file.name.endsWith('.js')) fileIcon = '🟨';
      if (file.name.endsWith('.css')) fileIcon = '🟦';
      if (file.name.endsWith('.html')) fileIcon = '🟧';

      li.innerHTML = `
        <span class="file-icon">${fileIcon}</span>
        <span class="file-name">${file.name}</span>
      `;

      li.addEventListener('click', () => {
        if (file.id !== this.workspace.activeFileId) {
          this.socket.emit('code_switch_file', {
            roomId: this.currentRoomId,
            fileId: file.id
          });
        }
      });

      this.fileTreeList.appendChild(li);
    });
  }

  updateLineNumbers() {
    if (!this.lineNumbersCol) return;
    const linesCount = (this.editorTextarea.value.match(/\n/g) || []).length + 1;
    let numbersHTML = '';
    for (let i = 1; i <= linesCount; i++) {
      numbersHTML += `<div>${i}</div>`;
    }
    this.lineNumbersCol.innerHTML = numbersHTML;
  }

  getCursorPosition() {
    const pos = this.editorTextarea.selectionStart;
    const lines = this.editorTextarea.value.substring(0, pos).split('\n');
    return {
      line: lines.length,
      col: lines[lines.length - 1].length + 1
    };
  }

  broadcastCursorPosition() {
    const activeFile = this.getActiveFile();
    if (!activeFile) return;
    const { line, col } = this.getCursorPosition();
    this.socket.emit('code_cursor_move', {
      roomId: this.currentRoomId,
      fileId: activeFile.id,
      cursorLine: line,
      cursorCol: col
    });
  }

  renderUserCursors() {
    if (!this.cursorsContainer) return;
    this.cursorsContainer.innerHTML = '';

    this.activeUserCursors.forEach((c) => {
      const cursorTag = document.createElement('div');
      cursorTag.className = 'active-user-cursor-badge';
      cursorTag.innerHTML = `
        <span>${c.avatar || '⚡'}</span>
        <span>${c.username} (L:${c.cursorLine}, C:${c.cursorCol})</span>
      `;
      this.cursorsContainer.appendChild(cursorTag);
    });
  }

  appendConsoleLine(text, type = 'return') {
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    line.innerText = text;
    this.consoleOutput.appendChild(line);
    this.consoleOutput.scrollTop = this.consoleOutput.scrollHeight;
  }

  async executeCode() {
    const activeFile = this.getActiveFile();
    if (!activeFile) return;

    // Switch to Console tab
    const consoleBtn = document.querySelector('[data-tab="console"]');
    if (consoleBtn) consoleBtn.click();

    this.consoleOutput.innerHTML = `<div class="console-line system">▶ Executing ${activeFile.name}...</div>`;

    if (activeFile.name.endsWith('.html') || activeFile.language === 'html') {
      this.updateHTMLPreview();
      const tabBtn = document.querySelector('[data-tab="preview"]');
      if (tabBtn) tabBtn.click();
      return;
    }

    const isPython = activeFile.name.endsWith('.py') || activeFile.language === 'python';

    // 🐍 Python Execution via Pyodide Engine
    if (isPython) {
      if (!this.pyodide) {
        if (this.isPyodideLoading) {
          this.appendConsoleLine('⏳ Loading Pyodide Python 3 Engine... Please wait a second and click Run again.', 'system');
          return;
        }
        return this.executeOnServer(activeFile);
      }

      try {
        await this.pyodide.loadPackagesFromImports(activeFile.content);

        let outputBuffer = '';
        this.pyodide.setStdout({
          batched: (str) => {
            outputBuffer += str + '\n';
          }
        });

        this.pyodide.setStderr({
          batched: (str) => {
            if (str.includes('DeprecationWarning') || str.includes('Pyarrow will become')) return;
            this.appendConsoleLine(str, 'error');
          }
        });

        const result = await this.pyodide.runPythonAsync(activeFile.content);

        if (outputBuffer.trim()) {
          this.appendConsoleLine(outputBuffer.trim(), 'return');
        }

        if (result !== undefined && result !== null && typeof result !== 'function') {
          this.appendConsoleLine(`Result: ${String(result)}`, 'system');
        }
      } catch (err) {
        this.appendConsoleLine(String(err), 'error');
      }

      return;
    }

    // 🟨 JavaScript Execution
    if (activeFile.name.endsWith('.js') || activeFile.language === 'javascript') {
      const logs = [];
      const originalLog = console.log;
      const originalError = console.error;

      console.log = (...args) => {
        logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' '));
        originalLog.apply(console, args);
      };

      console.error = (...args) => {
        this.appendConsoleLine(args.join(' '), 'error');
        originalError.apply(console, args);
      };

      try {
        const res = eval(activeFile.content);
        if (logs.length > 0) {
          logs.forEach((l) => this.appendConsoleLine(l, 'return'));
        }
        if (res !== undefined) {
          this.appendConsoleLine(`Result => ${typeof res === 'object' ? JSON.stringify(res) : String(res)}`, 'system');
        }
      } catch (err) {
        this.appendConsoleLine(`Runtime Error: ${err.message}`, 'error');
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
      return;
    }

    this.executeOnServer(activeFile);
  }

  async executeOnServer(activeFile) {
    try {
      const res = await fetch('/api/run-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: activeFile.content,
          language: activeFile.language || 'python',
          filename: activeFile.name
        })
      });

      const data = await res.json();
      if (data.stdout) this.appendConsoleLine(data.stdout, 'return');
      if (data.stderr) this.appendConsoleLine(data.stderr, 'error');
    } catch (err) {
      this.appendConsoleLine(`Execution Error: ${err.message}`, 'error');
    }
  }

  updateHTMLPreview() {
    if (!this.previewFrame) return;
    const htmlFile = this.workspace.files.find((f) => f.name.endsWith('.html')) || this.getActiveFile();
    const cssFile = this.workspace.files.find((f) => f.name.endsWith('.css'));
    const jsFile = this.workspace.files.find((f) => f.name.endsWith('.js'));

    let fullHTML = htmlFile ? htmlFile.content : '';
    if (cssFile && !fullHTML.includes('<style>')) {
      fullHTML += `<style>${cssFile.content}</style>`;
    }
    if (jsFile && !fullHTML.includes('<script>')) {
      fullHTML += `<script>${jsFile.content}</script>`;
    }

    const doc = this.previewFrame.contentDocument || this.previewFrame.contentWindow.document;
    doc.open();
    doc.write(fullHTML);
    doc.close();
  }
}

window.CollaborativeCodeStudio = CollaborativeCodeStudio;
