/**
 * Live Collaborative Code Studio & Pulse Engine for PulseChat
 * Multi-user live synchronization, Pyodide Python 3 WebAssembly engine,
 * Pulse Activity Bar & Side Panels, Extensions Marketplace integration,
 * Tab Bar, Prettier formatting, Linter diagnostics, and Status bar updates.
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
    this.openEditorsList = document.getElementById('studio-open-editors-list');
    this.editorTextarea = document.getElementById('studio-editor-textarea');
    this.lineNumbersCol = document.getElementById('studio-line-numbers');
    
    // Initialize CodeMirror if available
    this.editor = null;
    if (window.CodeMirror && this.editorTextarea) {
      this.editor = CodeMirror.fromTextArea(this.editorTextarea, {
        lineNumbers: true,
        mode: 'python',
        theme: 'darcula',
        indentUnit: 4,
        matchBrackets: true,
        autoCloseBrackets: true,
        lint: true,
        gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"]
      });
      this.editor.setSize('100%', '100%');
      
      this.editor.on('change', (cm, changeObj) => {
        if (changeObj.origin !== 'setValue') {
          const activeFile = this.getActiveFile();
          if (activeFile) {
            activeFile.content = cm.getValue();
            this.updateStatusBar();
            const pos = cm.getCursor();
            this.socket.emit('code_change', {
              roomId: this.currentRoomId,
              fileId: activeFile.id,
              content: activeFile.content,
              cursorLine: pos.line + 1,
              cursorCol: pos.ch + 1
            });
          }
        }
      });

      // Autocomplete (IntelliSense) bindings
      this.editor.on('keyup', (cm, event) => {
        const ignoreKeys = [8, 9, 13, 16, 17, 18, 20, 27, 37, 38, 39, 40, 91, 93];
        if (!ignoreKeys.includes(event.keyCode) && !cm.state.completionActive) {
          CodeMirror.commands.autocomplete(cm, null, { completeSingle: false });
        }
      });

      // AI Context Menu binding
      this.editor.getWrapperElement().addEventListener('contextmenu', (e) => {
        const selection = this.editor.getSelection();
        if (selection.trim().length > 0) {
          e.preventDefault();
          const menu = document.getElementById('ai-context-menu');
          if (menu) {
            menu.style.display = 'block';
            menu.style.left = e.pageX + 'px';
            menu.style.top = e.pageY + 'px';
            
            window.activeCodeSelection = selection;
            window.activeCodeLanguage = this.getActiveFile()?.language || 'python';
          }
        }
      });

      document.addEventListener('click', () => {
        const menu = document.getElementById('ai-context-menu');
        if (menu) menu.style.display = 'none';
      });

      this.editor.on('cursorActivity', (cm) => {
        const pos = cm.getCursor();
        const activeFile = this.getActiveFile();
        if (activeFile) {
          this.updateStatusBar();
          this.socket.emit('code_cursor_move', {
            roomId: this.currentRoomId,
            fileId: activeFile.id,
            cursorLine: pos.line + 1,
            cursorCol: pos.ch + 1
          });
        }
      });
    }

    this.activeFileNameTag = document.getElementById('studio-active-file-name');
    this.langSelect = document.getElementById('studio-lang-select');
    this.consoleOutput = document.getElementById('studio-console-output');
    this.previewFrame = document.getElementById('studio-html-preview');
    this.cursorsContainer = document.getElementById('studio-cursors-container');
    this.activeTabButtons = document.querySelectorAll('.studio-tab-btn');
    this.tabsBar = document.getElementById('vscode-tabs-bar');
    this.activityButtons = document.querySelectorAll('.activity-btn');
    this.sidePanelSections = document.querySelectorAll('.panel-section');

    // Extension Engine Instance
    if (window.VSCodeExtensionEngine) {
      this.extensions = new window.VSCodeExtensionEngine(this);
    }

    this.initSocketEvents();
    this.initDOMEvents();
    this.initVSCodeUIEvents();
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

  initVSCodeUIEvents() {
    // Activity Bar Navigation
    this.activityButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const panelName = btn.getAttribute('data-panel');
        this.activityButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.sidePanelSections.forEach(sec => {
          sec.style.display = 'none';
        });

        const targetPanel = document.getElementById(`panel-${panelName}`);
        if (targetPanel) {
          targetPanel.style.display = 'block';
        }

        if (panelName === 'extensions') {
          this.renderExtensionsList();
        }
      });
    });

    // Format Document Button (Prettier)
    document.getElementById('btn-format-doc')?.addEventListener('click', () => {
      if (this.extensions) this.extensions.formatActiveDocument();
    });

    // Theme Selector
    const themeSelect = document.getElementById('vscode-theme-select');
    if (themeSelect) {
      themeSelect.value = localStorage.getItem('vscode_theme') || 'vscode-dark';
      themeSelect.addEventListener('change', (e) => {
        if (this.extensions) this.extensions.applyTheme(e.target.value);
      });
    }

    // Snippet Buttons
    document.querySelectorAll('.btn-snippet').forEach(btn => {
      btn.addEventListener('click', () => {
        const snippetKey = btn.getAttribute('data-snippet');
        if (this.extensions) this.extensions.insertSnippet(snippetKey);
      });
    });

    // AI Copilot Quick Actions
    document.querySelectorAll('.btn-copilot-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (this.extensions) this.extensions.askAICopilot(action);
      });
    });

    document.getElementById('btn-ask-copilot')?.addEventListener('click', () => {
      const input = document.getElementById('copilot-custom-prompt');
      if (input && input.value.trim() !== '') {
        this.executeAIAction('explain', input.value.trim());
        input.value = '';
      }
    });

    // AI Context Menu Buttons
    document.getElementById('btn-ai-explain')?.addEventListener('click', () => {
      if (window.activeCodeSelection) {
        this.executeAIAction('explain', 'Explain this specific block of code: \n' + window.activeCodeSelection);
      }
    });

    document.getElementById('btn-ai-fix')?.addEventListener('click', () => {
      if (window.activeCodeSelection) {
        this.executeAIAction('fix', 'Fix any bugs in this code snippet: \n' + window.activeCodeSelection);
      }
    });

    document.getElementById('btn-ai-convert-py')?.addEventListener('click', () => {
      if (window.activeCodeSelection) {
        this.executeAIAction('explain', 'Convert this code to Python 3: \n' + window.activeCodeSelection);
      }
    });

    // Time Travel Logic
    this.sessionHistory = [];
    setInterval(() => {
      const activeFile = this.getActiveFile();
      if (activeFile && activeFile.content.trim() !== '') {
        const lastSnapshot = this.sessionHistory[this.sessionHistory.length - 1];
        if (!lastSnapshot || lastSnapshot.content !== activeFile.content) {
          this.sessionHistory.push({
            timestamp: new Date().toLocaleTimeString(),
            content: activeFile.content
          });
        }
      }
    }, 10000); // Snapshot every 10 seconds if changed

    document.getElementById('btn-studio-time-travel')?.addEventListener('click', () => {
      const modal = document.getElementById('modal-time-travel');
      const list = document.getElementById('time-travel-list');
      if (modal && list) {
        list.innerHTML = '';
        if (this.sessionHistory.length === 0) {
          list.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">No history snapshots recorded yet. Write some code and wait a few seconds!</div>';
        } else {
          this.sessionHistory.slice().reverse().forEach((snap, idx) => {
            const btn = document.createElement('button');
            btn.className = 'btn-panel-btn';
            btn.style.textAlign = 'left';
            btn.style.background = '#1e293b';
            btn.style.border = '1px solid #334155';
            btn.innerHTML = `<strong>Snapshot ${this.sessionHistory.length - idx}</strong> &mdash; ${snap.timestamp}`;
            btn.addEventListener('click', () => {
              if (confirm('Restore this snapshot? This will overwrite the current active file.')) {
                this.editor.setValue(snap.content);
                modal.classList.remove('active');
                window.showToast?.('Snapshot restored!', 'success');
              }
            });
            list.appendChild(btn);
          });
        }
        modal.classList.add('active');
      }
    });

    document.getElementById('btn-close-time-travel')?.addEventListener('click', () => {
      document.getElementById('modal-time-travel')?.classList.remove('active');
    });

    // Split View Toggle
    document.getElementById('btn-toggle-split-view')?.addEventListener('click', () => {
      if (this.previewFrame.style.display === 'none') {
        this.previewFrame.style.display = 'block';
        this.updateHTMLPreview();
      } else {
        this.previewFrame.style.display = 'none';
      }
    });

    // ─── Search & Replace Engine ────────────────────────────────────────────────
    this.isMatchCase = false;

    // Case Sensitivity Toggle
    document.getElementById('search-case-toggle')?.addEventListener('click', (e) => {
      this.isMatchCase = !this.isMatchCase;
      const btn = e.currentTarget;
      if (this.isMatchCase) {
        btn.style.background = 'var(--accent-violet)';
        btn.style.color = '#ffffff';
      } else {
        btn.style.background = 'rgba(255,255,255,0.05)';
        btn.style.color = 'var(--text-muted)';
      }
      this.performSearch();
    });

    // Real-Time Search on Input
    document.getElementById('search-query-input')?.addEventListener('input', () => {
      this.performSearch();
    });

    // Find Matches Button
    document.getElementById('btn-exec-search')?.addEventListener('click', () => {
      this.performSearch();
    });

    // Replace All Button
    document.getElementById('btn-exec-replace')?.addEventListener('click', () => {
      this.executeReplaceAll();
    });

    // Replace Next Button
    document.getElementById('btn-exec-replace-next')?.addEventListener('click', () => {
      this.executeReplaceNext();
    });
  }

  performSearch() {
    const qInput = document.getElementById('search-query-input');
    const badge  = document.getElementById('search-match-badge');
    const list   = document.getElementById('search-results-list');
    if (!list || !qInput) return;

    const q = qInput.value;
    if (!q) {
      list.innerHTML = '';
      if (badge) badge.style.display = 'none';
      return;
    }

    const activeFile = this.getActiveFile();
    if (!activeFile) return;

    const text = activeFile.content;
    const lines = text.split('\n');
    list.innerHTML = '';
    let matchesCount = 0;
    const matchCase = this.isMatchCase;

    lines.forEach((lineText, idx) => {
      const lineNum = idx + 1;
      const haystack = matchCase ? lineText : lineText.toLowerCase();
      const needle   = matchCase ? q : q.toLowerCase();

      if (haystack.includes(needle)) {
        matchesCount++;

        // Highlight snippet match
        const charIdx = haystack.indexOf(needle);
        const before  = lineText.substring(0, charIdx);
        const matchStr= lineText.substring(charIdx, charIdx + q.length);
        const after   = lineText.substring(charIdx + q.length);

        const item = document.createElement('div');
        item.className = 'git-file-item';
        item.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;margin-bottom:4px;background:rgba(255,255,255,0.03);display:flex;align-items:center;gap:6px;font-size:0.75rem;';
        item.innerHTML = `
          <span style="color:#007acc;font-weight:700;font-family:monospace;min-width:32px;">L${lineNum}</span>
          <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${this.escapeHTML(before)}<strong style="background:rgba(56,189,248,0.3);color:#67e8f9;padding:0 2px;border-radius:2px;">${this.escapeHTML(matchStr)}</strong>${this.escapeHTML(after)}
          </span>
        `;

        // Click to jump and highlight in editor
        item.addEventListener('click', () => {
          this.jumpToLineAndMatch(lineNum, charIdx, q.length);
        });

        list.appendChild(item);
      }
    });

    if (badge) {
      badge.style.display = 'inline';
      badge.innerText = `${matchesCount} match${matchesCount !== 1 ? 'es' : ''}`;
      badge.style.color = matchesCount > 0 ? '#38bdf8' : 'var(--text-muted)';
    }

    if (matchesCount === 0) {
      list.innerHTML = '<div style="font-size:0.75rem;color:var(--text-muted);padding:8px 0;text-align:center;">No matches found</div>';
    }
  }

  jumpToLineAndMatch(lineNum, charInLine, matchLength) {
    if (this.editor) {
      this.editor.focus();
      this.editor.setSelection({line: lineNum - 1, ch: charInLine}, {line: lineNum - 1, ch: charInLine + matchLength});
      this.editor.scrollIntoView({line: lineNum - 1, ch: charInLine}, 100);
      return;
    }
    if (!this.editorTextarea) return;
    const text = this.editorTextarea.value;
    const lines = text.split('\n');

    let startIdx = 0;
    for (let i = 0; i < lineNum - 1 && i < lines.length; i++) {
      startIdx += lines[i].length + 1; // +1 for newline
    }

    const matchStart = startIdx + charInLine;
    const matchEnd   = matchStart + matchLength;

    this.editorTextarea.focus();
    this.editorTextarea.setSelectionRange(matchStart, matchEnd);

    // Calculate approximate scroll position
    const lineHeight = 20;
    this.editorTextarea.scrollTop = Math.max(0, (lineNum - 5) * lineHeight);
    this.appendConsoleLine(`🔍 Jumped to Line ${lineNum}, Col ${charInLine + 1}`, 'system');
  }

  executeReplaceAll() {
    const qInput = document.getElementById('search-query-input');
    const rInput = document.getElementById('replace-query-input');
    if (!qInput || !this.editorTextarea) return;

    const q = qInput.value;
    const r = rInput ? rInput.value : '';

    if (!q) {
      this.appendConsoleLine('⚠️ Search query required for Replace All', 'warning');
      return;
    }

    const activeFile = this.getActiveFile();
    if (!activeFile) return;

    const text = this.editor ? this.editor.getValue() : this.editorTextarea.value;
    let newText = '';
    let count = 0;

    if (this.isMatchCase) {
      const parts = text.split(q);
      count = parts.length - 1;
      newText = parts.join(r);
    } else {
      const regex = new RegExp(this.escapeRegExp(q), 'gi');
      const matches = text.match(regex);
      count = matches ? matches.length : 0;
      newText = text.replace(regex, r);
    }

    if (count > 0) {
      if (this.editor) {
        this.editor.setValue(newText);
      } else {
        this.editorTextarea.value = newText;
      }
      activeFile.content = newText;
      this.updateLineNumbers();
      this.broadcastCodeChange();
      this.performSearch();
      this.appendConsoleLine(`⚡ Replaced ${count} occurrence${count !== 1 ? 's' : ''} of "${q}" with "${r}"`, 'system');
    } else {
      this.appendConsoleLine(`⚠️ No occurrences of "${q}" found to replace.`, 'warning');
    }
  }

  executeReplaceNext() {
    const qInput = document.getElementById('search-query-input');
    const rInput = document.getElementById('replace-query-input');
    if (!qInput || !this.editorTextarea) return;

    const q = qInput.value;
    const r = rInput ? rInput.value : '';
    if (!q) return;

    const text = this.editorTextarea.value;
    const selStart = this.editorTextarea.selectionStart;
    const needle   = this.isMatchCase ? q : q.toLowerCase();
    const haystack = this.isMatchCase ? text : text.toLowerCase();

    let nextIdx = haystack.indexOf(needle, selStart);
    if (nextIdx === -1) {
      // Wrap around from beginning
      nextIdx = haystack.indexOf(needle, 0);
    }

    if (nextIdx !== -1) {
      const newText = text.substring(0, nextIdx) + r + text.substring(nextIdx + q.length);
      this.editorTextarea.value = newText;
      this.getActiveFile().content = newText;
      this.updateLineNumbers();
      this.broadcastCodeChange();

      // Highlight replaced string
      this.editorTextarea.focus();
      this.editorTextarea.setSelectionRange(nextIdx, nextIdx + r.length);
      this.performSearch();
      this.appendConsoleLine(`⚡ Replaced match at index ${nextIdx} with "${r}"`, 'system');
    } else {
      this.appendConsoleLine(`⚠️ No match found for "${q}"`, 'warning');
    }
  }

  escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  renderExtensionsList() {
    const list = document.getElementById('vscode-extensions-list');
    if (!list || !this.extensions) return;
    list.innerHTML = '';

    this.extensions.installedExtensions.forEach((ext) => {
      const card = document.createElement('div');
      card.className = 'extension-card';
      card.innerHTML = `
        <div class="ext-title">
          <span>${ext.icon} ${ext.name}</span>
          <span style="font-size:0.65rem;color:var(--text-muted);">${ext.version}</span>
        </div>
        <div class="ext-desc">${ext.desc}</div>
        <div class="ext-footer">
          <span style="font-size:0.68rem;color:var(--text-dim);">by ${ext.author}</span>
          <button class="btn-toggle-ext ${ext.enabled ? '' : 'disabled'}" data-ext="${ext.id}">
            ${ext.enabled ? 'Enabled ✓' : 'Disabled ✗'}
          </button>
        </div>
      `;

      card.querySelector('.btn-toggle-ext').addEventListener('click', () => {
        const isEnabled = this.extensions.toggleExtension(ext.id);
        this.renderExtensionsList();
      });

      list.appendChild(card);
    });
  }

  initSocketEvents() {
    this.socket.on('code_updated', ({ fileId, content, user, cursorLine, cursorCol }) => {
      const activeFile = this.getActiveFile();
      if (activeFile && activeFile.id === fileId) {
        activeFile.content = content;
        if (this.editor) {
          const cursor = this.editor.getCursor();
          if (this.editor.getValue() !== content) {
            this.editor.setValue(content);
            this.editor.setCursor(cursor);
          }
        } else {
          const start = this.editorTextarea.selectionStart;
          const end = this.editorTextarea.selectionEnd;
          this.editorTextarea.value = content;
          this.editorTextarea.setSelectionRange(start, end);
        }
        this.updateLineNumbers();
        this.updateStatusBar();
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
      this.renderTabsBar();
      this.loadActiveFile();
    });

    this.socket.on('code_active_file_changed', ({ fileId }) => {
      this.workspace.activeFileId = fileId;
      this.renderFileTree();
      this.renderTabsBar();
      this.loadActiveFile();
    });
  }

  initDOMEvents() {
    if (!this.editorTextarea) return;

    // We only attach these if CodeMirror is not present
    if (!this.editor) {
      // Real-Time Keystroke Sync
      this.editorTextarea.addEventListener('input', () => {
      const activeFile = this.getActiveFile();
      if (!activeFile) return;

      activeFile.content = this.editorTextarea.value;
      this.updateLineNumbers();
      this.updateStatusBar();

      const { line, col } = this.getCursorPosition();

      this.socket.emit('code_change', {
        roomId: this.currentRoomId,
        fileId: activeFile.id,
        content: activeFile.content,
        cursorLine: line,
        cursorCol: col
      });
    });

    this.editorTextarea.addEventListener('keyup', () => {
      this.broadcastCursorPosition();
      this.updateStatusBar();
    });
    
    this.editorTextarea.addEventListener('click', () => {
      this.broadcastCursorPosition();
      this.updateStatusBar();
    });

    // Auto-closing Brackets & Quotes
    const autoPairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };

    this.editorTextarea.addEventListener('keydown', (e) => {
      const start = this.editorTextarea.selectionStart;
      const end = this.editorTextarea.selectionEnd;
      const val = this.editorTextarea.value;
      const char = e.key;

      if (autoPairs[char]) {
        if (start !== end) {
          e.preventDefault();
          const selectedText = val.substring(start, end);
          const replacement = char + selectedText + autoPairs[char];
          this.editorTextarea.value = val.substring(0, start) + replacement + val.substring(end);
          this.editorTextarea.setSelectionRange(start + 1, end + 1);
          this.editorTextarea.dispatchEvent(new Event('input'));
          return;
        }

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

      if ([')', ']', '}'].includes(char) && val[start] === char && start === end) {
        e.preventDefault();
        this.editorTextarea.setSelectionRange(start + 1, start + 1);
        return;
      }

      if (e.key === 'Enter') {
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const currentLine = val.substring(lineStart, start);
        const indentMatch = currentLine.match(/^(\s*)/);
        let indent = indentMatch ? indentMatch[1] : '';

        if (/[{(\[::]\s*$/.test(currentLine)) {
          indent += '  ';
        }

        e.preventDefault();
        this.editorTextarea.value = val.substring(0, start) + '\n' + indent + val.substring(end);
        this.editorTextarea.selectionStart = this.editorTextarea.selectionEnd = start + 1 + indent.length;
        this.editorTextarea.dispatchEvent(new Event('input'));
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        this.editorTextarea.value = val.substring(0, start) + '  ' + val.substring(end);
        this.editorTextarea.selectionStart = this.editorTextarea.selectionEnd = start + 2;
        this.editorTextarea.dispatchEvent(new Event('input'));
      }
    });

    this.editorTextarea.addEventListener('scroll', () => {
      if (this.lineNumbersCol) this.lineNumbersCol.scrollTop = this.editorTextarea.scrollTop;
    });
    } // End of non-CodeMirror events

    // Create New File
    document.getElementById('btn-studio-new-file')?.addEventListener('click', () => {
      const fileName = prompt('Enter new file name (e.g. script.py, index.js, styles.css):', 'app.py');
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
        this.updateStatusBar();
      }
    });

    // Run Code Button
    document.getElementById('btn-studio-run-code')?.addEventListener('click', () => {
      this.executeCode();
    });

    // Clear Console
    document.getElementById('btn-studio-clear-console')?.addEventListener('click', () => {
      this.consoleOutput.innerHTML = '<div class="console-line system">Console output cleared.</div>';
    });

    // Console / Preview Tabs
    this.activeTabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        this.activeTabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        if (tab === 'console') {
          this.consoleOutput.style.display = 'block';
          this.previewFrame.style.display = 'none';
          if(document.getElementById('studio-stdin-input')) document.getElementById('studio-stdin-input').style.display = 'none';
        } else if (tab === 'stdin') {
          this.consoleOutput.style.display = 'none';
          this.previewFrame.style.display = 'none';
          if(document.getElementById('studio-stdin-input')) document.getElementById('studio-stdin-input').style.display = 'block';
        } else if (tab === 'linter') {
          this.consoleOutput.style.display = 'block';
          this.previewFrame.style.display = 'none';
          if(document.getElementById('studio-stdin-input')) document.getElementById('studio-stdin-input').style.display = 'none';
          this.runLinterCheck();
        } else {
          this.consoleOutput.style.display = 'none';
          this.previewFrame.style.display = 'block';
          if(document.getElementById('studio-stdin-input')) document.getElementById('studio-stdin-input').style.display = 'none';
          this.updateHTMLPreview();
        }
      });
    });

    // Export File Button
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
    this.renderTabsBar();
    this.loadActiveFile();
  }

  getActiveFile() {
    return this.workspace.files.find((f) => f.id === this.workspace.activeFileId) || this.workspace.files[0];
  }

  loadActiveFile() {
    const file = this.getActiveFile();
    if (!file) return;

    if (this.editor) {
      if (this.editor.getValue() !== (file.content || '')) {
        this.editor.setValue(file.content || '');
      }
      
      let mode = 'javascript';
      if (file.name.endsWith('.py')) mode = 'python';
      else if (file.name.endsWith('.html')) mode = 'htmlmixed';
      else if (file.name.endsWith('.css')) mode = 'css';
      else if (file.name.endsWith('.json')) mode = 'javascript';
      else if (file.name.endsWith('.c')) mode = 'text/x-csrc';
      else if (file.name.endsWith('.cpp')) mode = 'text/x-c++src';
      else if (file.name.endsWith('.java')) mode = 'text/x-java';
      this.editor.setOption('mode', mode);
    } else {
      this.editorTextarea.value = file.content || '';
    }
    
    this.activeFileNameTag.innerText = file.name;
    
    if (this.langSelect) {
      if (file.name.endsWith('.py')) this.langSelect.value = 'python';
      else if (file.name.endsWith('.html')) this.langSelect.value = 'html';
      else if (file.name.endsWith('.css')) this.langSelect.value = 'css';
      else if (file.name.endsWith('.json')) this.langSelect.value = 'json';
      else if (file.name.endsWith('.c')) this.langSelect.value = 'c';
      else if (file.name.endsWith('.cpp')) this.langSelect.value = 'cpp';
      else if (file.name.endsWith('.java')) this.langSelect.value = 'java';
      else this.langSelect.value = file.language || 'javascript';
    }

    this.updateLineNumbers();
    this.updateHTMLPreview();
    this.updateStatusBar();
  }

  renderTabsBar() {
    if (!this.tabsBar) return;
    this.tabsBar.innerHTML = '';

    this.workspace.files.forEach((file) => {
      const tab = document.createElement('div');
      const isActive = file.id === this.workspace.activeFileId;
      tab.className = `vscode-tab-item ${isActive ? 'active' : ''}`;
      
      let fileIcon = '<i class="fa-solid fa-file"></i>';
      if (file.name.endsWith('.py')) fileIcon = '<i class="fa-brands fa-python" style="color:#38bdf8;"></i>';
      if (file.name.endsWith('.js')) fileIcon = '<i class="fa-brands fa-js" style="color:#fde047;"></i>';
      if (file.name.endsWith('.css')) fileIcon = '<i class="fa-brands fa-css3-alt" style="color:#60a5fa;"></i>';
      if (file.name.endsWith('.html')) fileIcon = '<i class="fa-brands fa-html5" style="color:#f97316;"></i>';
      if (file.name.endsWith('.c') || file.name.endsWith('.cpp')) fileIcon = '<i class="fa-solid fa-c" style="color:#3b82f6;"></i>';
      if (file.name.endsWith('.java')) fileIcon = '<i class="fa-brands fa-java" style="color:#f43f5e;"></i>';

      tab.innerHTML = `
        <span>${fileIcon}</span>
        <span>${file.name}</span>
        <span class="tab-close-btn">×</span>
      `;

      tab.addEventListener('click', (e) => {
        if (!e.target.classList.contains('tab-close-btn') && file.id !== this.workspace.activeFileId) {
          this.socket.emit('code_switch_file', {
            roomId: this.currentRoomId,
            fileId: file.id
          });
        }
      });

      this.tabsBar.appendChild(tab);
    });
  }

  renderFileTree() {
    if (!this.fileTreeList) return;
    this.fileTreeList.innerHTML = '';
    if (this.openEditorsList) this.openEditorsList.innerHTML = '';

    this.workspace.files.forEach((file) => {
      const li = document.createElement('li');
      const isActive = file.id === this.workspace.activeFileId;
      li.className = `studio-file-item ${isActive ? 'active' : ''}`;
      
      let fileIcon = '<i class="fa-solid fa-file"></i>';
      if (file.name.endsWith('.py')) fileIcon = '<i class="fa-brands fa-python" style="color:#38bdf8;"></i>';
      if (file.name.endsWith('.js')) fileIcon = '<i class="fa-brands fa-js" style="color:#fde047;"></i>';
      if (file.name.endsWith('.css')) fileIcon = '<i class="fa-brands fa-css3-alt" style="color:#60a5fa;"></i>';
      if (file.name.endsWith('.html')) fileIcon = '<i class="fa-brands fa-html5" style="color:#f97316;"></i>';

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

      if (this.openEditorsList) {
        const edLi = li.cloneNode(true);
        edLi.addEventListener('click', () => {
          if (file.id !== this.workspace.activeFileId) {
            this.socket.emit('code_switch_file', { roomId: this.currentRoomId, fileId: file.id });
          }
        });
        this.openEditorsList.appendChild(edLi);
      }
    });
  }

  updateLineNumbers() {
    if (!this.lineNumbersCol || this.editor) return; // CodeMirror handles line numbers
    const linesCount = (this.editorTextarea.value.match(/\n/g) || []).length + 1;
    let numbersHTML = '';
    for (let i = 1; i <= linesCount; i++) {
      numbersHTML += `<div>${i}</div>`;
    }
    this.lineNumbersCol.innerHTML = numbersHTML;
  }

  updateStatusBar() {
    const { line, col } = this.getCursorPosition();
    const posTag = document.getElementById('status-cursor-pos');
    if (posTag) posTag.innerText = `Ln ${line}, Col ${col}`;

    const activeFile = this.getActiveFile();
    const langTag = document.getElementById('status-lang-badge');
    if (langTag && activeFile) {
      langTag.innerText = activeFile.language.toUpperCase();
    }
  }

  runLinterCheck() {
    if (!this.extensions) return;
    const problems = this.extensions.runLinterCheck();
    const countTag = document.getElementById('status-linter-count');

    const errCount = problems.filter(p => p.type === 'error').length;
    const warnCount = problems.filter(p => p.type === 'warning').length;

    if (countTag) countTag.innerText = `${errCount} ❌ ${warnCount} ⚠️`;

    this.consoleOutput.innerHTML = `<div class="console-line system">🚨 Linter Diagnostics Scan Results (${problems.length} items found):</div>`;
    if (problems.length === 0) {
      this.appendConsoleLine('✨ No syntax errors or warnings detected in file!', 'system');
    } else {
      problems.forEach(p => {
        this.appendConsoleLine(`Line ${p.line}: [${p.type.toUpperCase()}] ${p.message}`, p.type === 'error' ? 'error' : 'system');
      });
    }
  }

  getCursorPosition() {
    if (this.editor) {
      const pos = this.editor.getCursor();
      return { line: pos.line + 1, col: pos.ch + 1 };
    }
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

  broadcastCodeChange() {
    const activeFile = this.getActiveFile();
    if (!activeFile) return;
    const { line, col } = this.getCursorPosition();
    this.socket.emit('code_change', {
      roomId: this.currentRoomId,
      fileId: activeFile.id,
      content: activeFile.content,
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

    const consoleBtn = document.querySelector('[data-tab="console"]');
    if (consoleBtn) consoleBtn.click();

    this.consoleOutput.innerHTML = `<div class="console-line system">▶ Executing ${activeFile.name}...</div>`;

    if (activeFile.name.endsWith('.html') || activeFile.language === 'html') {
      this.updateHTMLPreview();
      const tabBtn = document.querySelector('[data-tab="preview"]');
      if (tabBtn) tabBtn.click();
      return;
    }

    const isC = activeFile.name.endsWith('.c') || activeFile.language === 'c';
    const isCpp = activeFile.name.endsWith('.cpp') || activeFile.language === 'cpp';
    const isJava = activeFile.name.endsWith('.java') || activeFile.language === 'java';

    const stdinInputNode = document.getElementById('studio-stdin-input');
    const stdinVal = stdinInputNode ? stdinInputNode.value : '';

    if (isC || isCpp || isJava) {
      this.appendConsoleLine(`⏳ Compiling and running via Cloud Engine...`, 'system');
      try {
        const compiler = isC ? 'gcc-head-c' : (isCpp ? 'gcc-head' : 'openjdk-jdk-22+36');
        const res = await fetch("https://wandbox.org/api/compile.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            compiler: compiler,
            code: activeFile.content,
            stdin: stdinVal
          })
        });
        const data = await res.json();
        if (data.compiler_error && data.compiler_error.trim()) {
          this.appendConsoleLine(data.compiler_error, 'error');
        }
        if (data.program_error && data.program_error.trim()) {
          this.appendConsoleLine(data.program_error, 'error');
        }
        if (data.program_output && data.program_output.trim()) {
          this.appendConsoleLine(data.program_output, 'return');
        }
        if (data.status !== "0" && !data.program_error && !data.compiler_error && !data.program_output) {
          this.appendConsoleLine('Execution failed (Status ' + data.status + ')', 'error');
        } else if (!data.program_output && !data.compiler_error && !data.program_error) {
          this.appendConsoleLine('Program ran successfully (No output)', 'system');
        }
      } catch (err) {
        this.appendConsoleLine(`Execution Error: ${err.message}`, 'error');
      }
      return;
    }

    const isPython = activeFile.name.endsWith('.py') || activeFile.language === 'python';

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

        await this.pyodide.runPythonAsync(`
import sys
import io
sys.stdin = io.StringIO(${JSON.stringify(stdinVal)})
        `);

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
