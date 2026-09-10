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
        gutters: ["CodeMirror-linenumbers", "CodeMirror-lint-markers"]
      });
      this.editor.setSize('100%', '100%');

      // Auto-refresh CodeMirror whenever the studio view becomes visible or resizes
      if (window.ResizeObserver) {
        this.studioResizeObserver = new ResizeObserver(() => {
          if (this.viewStudio && (this.viewStudio.offsetWidth > 0 || this.viewStudio.offsetParent !== null)) {
            this.refreshEditor();
          }
        });
        if (this.viewStudio) this.studioResizeObserver.observe(this.viewStudio);
        const editorMain = document.querySelector('.studio-editor-main');
        if (editorMain) this.studioResizeObserver.observe(editorMain);
      }
      window.addEventListener('resize', () => this.refreshEditor());
      
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

            // Live Web Playground: Debounced real-time preview update
            if (this.previewDebounceTimer) clearTimeout(this.previewDebounceTimer);
            this.previewDebounceTimer = setTimeout(() => {
              const af = this.getActiveFile();
              if (af && (af.name.endsWith('.html') || af.name.endsWith('.css') || af.name.endsWith('.js') || af.language === 'html')) {
                this.updateHTMLPreview();
              }
            }, 300);
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

          // Multi-User Live Cursor & Selection Sync
          const sel = cm.somethingSelected() ? {
            anchor: cm.getCursor('anchor'),
            head: cm.getCursor('head')
          } : null;

          this.socket.emit('code_cursor_activity', {
            roomId: this.currentRoomId,
            fileId: activeFile.id,
            cursor: { line: pos.line, ch: pos.ch },
            selection: sel
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
    this.remoteCursors = new Map();

    // Listen to logs from Web Playground iframe
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'playground-log') {
        this.appendConsoleLine(`[Web Preview] ${e.data.message}`, e.data.logType === 'error' ? 'error' : 'return');
      }
    });

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
        
        if (panelName === 'whiteboard') {
          if (window.switchViewMode) window.switchViewMode('whiteboard');
          return;
        }
      });
    });

    // Search and Replace Logic
    const searchInput = document.getElementById('search-query-input');
    const replaceInput = document.getElementById('replace-query-input');
    const btnReplaceNext = document.getElementById('btn-exec-replace-next');
    const btnReplaceAll = document.getElementById('btn-exec-replace');

    btnReplaceAll?.addEventListener('click', () => {
      if (!this.editor) return;
      const query = searchInput?.value;
      const replacement = replaceInput?.value;
      if (!query) return;
      const content = this.editor.getValue();
      const newContent = content.split(query).join(replacement);
      if (content !== newContent) {
        this.editor.setValue(newContent);
        window.showToast?.('Replaced all occurrences!', 'success');
      } else {
        window.showToast?.('No matches found.', 'info');
      }
    });

    btnReplaceNext?.addEventListener('click', () => {
      if (!this.editor) return;
      const query = searchInput?.value;
      const replacement = replaceInput?.value;
      if (!query) return;
      const content = this.editor.getValue();
      const newContent = content.replace(query, replacement);
      if (content !== newContent) {
        this.editor.setValue(newContent);
        window.showToast?.('Replaced one occurrence!', 'success');
      } else {
        window.showToast?.('No matches found.', 'info');
      }
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
        if (this.extensions) this.extensions.askAICopilot('custom', input.value.trim());
        input.value = '';
      }
    });

    // AI Context Menu Buttons
    document.getElementById('btn-ai-explain')?.addEventListener('click', () => {
      if (window.activeCodeSelection) {
        if (this.extensions) this.extensions.askAICopilot('explain', 'Explain this specific block of code: \n' + window.activeCodeSelection);
      }
    });

    document.getElementById('btn-ai-fix')?.addEventListener('click', () => {
      if (window.activeCodeSelection) {
        if (this.extensions) this.extensions.askAICopilot('fix', 'Fix any bugs in this code snippet: \n' + window.activeCodeSelection);
      }
    });

    document.getElementById('btn-ai-convert-py')?.addEventListener('click', () => {
      if (window.activeCodeSelection) {
        if (this.extensions) this.extensions.askAICopilot('explain', 'Convert this code to Python 3: \n' + window.activeCodeSelection);
      }
    });

    // Time Travel Logic
    this.sessionHistory = [];
    setInterval(() => {
      const activeFile = this.getActiveFile();
      if (activeFile && this.editor) {
        const currentContent = this.editor.getValue();
        if (currentContent.trim() !== '') {
          const lastSnapshot = this.sessionHistory[this.sessionHistory.length - 1];
          if (!lastSnapshot || lastSnapshot.content !== currentContent) {
            this.sessionHistory.push({
              timestamp: new Date().toLocaleTimeString(),
              content: currentContent
            });
          }
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
      const editorMain = document.querySelector('.studio-editor-main');
      if (!editorMain) return;
      editorMain.classList.toggle('split-active');
      const isSplit = editorMain.classList.contains('split-active');
      if (this.previewFrame) {
        this.previewFrame.style.display = isSplit ? 'block' : 'none';
      }
      if (isSplit) {
        this.updateHTMLPreview();
      }
      this.refreshEditor();
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

  escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
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

    this.socket.on('code_cursor_activity_received', ({ fileId, user, cursor, selection, color }) => {
      if (!user || user.id === this.socket.id) return;
      const activeFile = this.getActiveFile();
      if (activeFile && activeFile.id === fileId) {
        this.renderRemoteCursor(user, cursor, selection, color);
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

  renderRemoteCursor(user, cursor, selection, color = '#38bdf8') {
    if (this.remoteCursors.has(user.id)) {
      const prev = this.remoteCursors.get(user.id);
      if (prev.bookmark) prev.bookmark.clear();
      if (prev.mark) prev.mark.clear();
      if (prev.timer) clearTimeout(prev.timer);
    }

    if (this.editor && cursor) {
      const cursorEl = document.createElement('div');
      cursorEl.className = 'cm-remote-cursor';
      cursorEl.style.borderLeftColor = color;

      const flag = document.createElement('span');
      flag.className = 'cm-remote-cursor-flag';
      flag.style.backgroundColor = color;
      flag.innerText = `${user.avatar || '⚡'} ${user.username || 'Coder'}`;
      cursorEl.appendChild(flag);

      const bookmark = this.editor.setBookmark({ line: cursor.line, ch: cursor.ch }, { widget: cursorEl, insertLeft: true });
      let mark = null;
      if (selection && selection.anchor && selection.head) {
        mark = this.editor.markText(selection.anchor, selection.head, {
          className: 'cm-remote-selection',
          css: `background-color: ${color}33 !important;`
        });
      }

      const timer = setTimeout(() => {
        if (this.remoteCursors.has(user.id)) {
          const itm = this.remoteCursors.get(user.id);
          if (itm.bookmark) itm.bookmark.clear();
          if (itm.mark) itm.mark.clear();
          this.remoteCursors.delete(user.id);
        }
      }, 7000);

      this.remoteCursors.set(user.id, { bookmark, mark, timer });
    }

    if (user && cursor) {
      this.activeUserCursors.set(user.id, { ...user, cursorLine: cursor.line + 1, cursorCol: cursor.ch + 1, color });
      this.renderUserCursors();
    }
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
        else if (ext === 'c') lang = 'c';
        else if (['cpp', 'cc', 'cxx', 'hpp', 'h'].includes(ext)) lang = 'cpp';
        else if (ext === 'java') lang = 'java';
        else if (ext === 'html') lang = 'html';
        else if (ext === 'css') lang = 'css';
        else if (ext === 'json') lang = 'json';

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
        if (this.editor) {
          let mode = 'javascript';
          if (activeFile.language === 'python') mode = 'python';
          else if (activeFile.language === 'c') mode = 'text/x-csrc';
          else if (activeFile.language === 'cpp') mode = 'text/x-c++src';
          else if (activeFile.language === 'java') mode = 'text/x-java';
          else if (activeFile.language === 'html') mode = 'htmlmixed';
          else if (activeFile.language === 'css') mode = 'css';
          else if (activeFile.language === 'json') mode = 'javascript';
          this.editor.setOption('mode', mode);
        }
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
    this.refreshEditor();
  }

  refreshEditor() {
    if (this.editor) {
      this.editor.refresh();
      requestAnimationFrame(() => {
        if (this.editor) this.editor.refresh();
      });
      setTimeout(() => {
        if (this.editor) this.editor.refresh();
      }, 50);
      setTimeout(() => {
        if (this.editor) this.editor.refresh();
      }, 200);
    }
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
    const isCpp = activeFile.name.endsWith('.cpp') || activeFile.name.endsWith('.cc') || activeFile.name.endsWith('.cxx') || activeFile.language === 'cpp';
    const isJava = activeFile.name.endsWith('.java') || activeFile.language === 'java';

    const stdinInputNode = document.getElementById('studio-stdin-input');
    const stdinVal = stdinInputNode ? stdinInputNode.value : '';

    if (isC || isCpp || isJava) {
      const langLabel = isC ? 'C (GCC 9.2)' : (isCpp ? 'C++ (G++ 9.2)' : 'Java 13');
      this.appendConsoleLine(`⏳ Compiling and executing ${activeFile.name} with ${langLabel}...`, 'system');
      try {
        const langCode = isC ? 'c' : (isCpp ? 'cpp' : 'java');
        const res = await fetch("/api/run-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language: langCode,
            filename: activeFile.name,
            code: activeFile.content,
            stdin: stdinVal
          })
        });
        const data = await res.json();
        
        if (data.compile_output && data.compile_output.trim()) {
          this.appendConsoleLine(data.compile_output.trim(), 'error');
        }
        if (data.stderr && data.stderr.trim()) {
          this.appendConsoleLine(data.stderr.trim(), 'error');
        }
        if (data.stdout && data.stdout.trim()) {
          this.appendConsoleLine(data.stdout.trim(), 'return');
        }
        if (data.message && data.message.trim()) {
          this.appendConsoleLine(data.message.trim(), 'system');
        }

        if (data.time || data.memory) {
          const stats = [];
          if (data.time) stats.push(`Time: ${data.time}`);
          if (data.memory) stats.push(`Memory: ${data.memory}`);
          this.appendConsoleLine(`⚡ Finished (${stats.join(', ')}) [Status: ${data.status || 'Done'}]`, 'system');
        } else if (!data.stdout && !data.compile_output && !data.stderr && !data.error) {
          this.appendConsoleLine('Program ran successfully with no output.', 'system');
        }

        if (data.error && !data.compile_output && !data.stderr) {
          this.appendConsoleLine(`Error: ${data.error}`, 'error');
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
    const htmlFile = this.workspace.files.find((f) => f.name.endsWith('.html')) || (this.getActiveFile()?.name.endsWith('.html') ? this.getActiveFile() : null);
    const cssFiles = this.workspace.files.filter((f) => f.name.endsWith('.css'));
    const jsFiles = this.workspace.files.filter((f) => f.name.endsWith('.js'));

    let fullHTML = htmlFile ? htmlFile.content : `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>CodeCanvas Playground</title></head>
<body style="font-family:sans-serif;padding:24px;color:#f8fafc;background:#0f172a;">
  <h2 style="color:#38bdf8;margin-top:0;">🌐 CodeCanvas Live Web Playground</h2>
  <p style="color:#94a3b8;font-size:0.95rem;">Real-time sandbox preview executing HTML, CSS, and JS files from your workspace.</p>
  <div style="background:rgba(255,255,255,0.05);padding:16px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);margin-top:16px;">
    <strong>Quick Tip:</strong> Create <code>index.html</code>, <code>styles.css</code>, and <code>script.js</code> files to see live interactive rendering!
  </div>
</body>
</html>`;

    // Inject CSS files
    cssFiles.forEach(css => {
      if (fullHTML.includes('</head>')) {
        fullHTML = fullHTML.replace('</head>', `<style>/* ${css.name} */\n${css.content}\n</style></head>`);
      } else {
        fullHTML = `<style>${css.content}</style>` + fullHTML;
      }
    });

    // Inject Console Interceptor Script
    const consoleInterceptor = `
<script>
(function() {
  const sendLog = (type, args) => {
    try {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      window.parent.postMessage({ type: 'playground-log', logType: type, message: msg }, '*');
    } catch(e) {}
  };
  const _l = console.log, _w = console.warn, _e = console.error;
  console.log = function(...args) { _l.apply(console, args); sendLog('log', args); };
  console.warn = function(...args) { _w.apply(console, args); sendLog('warn', args); };
  console.error = function(...args) { _e.apply(console, args); sendLog('error', args); };
  window.onerror = function(msg, url, line) { sendLog('error', [msg + ' (line ' + line + ')']); };
})();
<\/script>`;

    if (fullHTML.includes('</head>')) {
      fullHTML = fullHTML.replace('</head>', `${consoleInterceptor}</head>`);
    } else {
      fullHTML = consoleInterceptor + fullHTML;
    }

    // Inject JS files safely
    jsFiles.forEach(js => {
      fullHTML += `\n<script>/* ${js.name} */\ntry {\n${js.content}\n} catch(err) { console.error(err.message); }\n<\/script>`;
    });

    try {
      const doc = this.previewFrame.contentDocument || this.previewFrame.contentWindow.document;
      doc.open();
      doc.write(fullHTML);
      doc.close();
    } catch (e) {
      console.warn('Playground update warning:', e);
    }
  }
}

window.CollaborativeCodeStudio = CollaborativeCodeStudio;
