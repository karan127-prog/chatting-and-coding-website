/**
 * Pulse Extensions Marketplace & Extensions Engine
 * Manages extension state, theme switching, syntax linting, Prettier formatting,
 * AI Copilot, Live Web Server, and Code Snippets.
 */

class VSCodeExtensionEngine {
  constructor(studioEngine) {
    this.studio = studioEngine;
    this.installedExtensions = new Map([
      ['prettier', { id: 'prettier', name: 'Prettier — Code Formatter', author: 'Prettier', desc: 'Opinionated code formatter for JS, Python, HTML & CSS.', version: 'v3.2', enabled: true, icon: '<i class="fa-solid fa-palette"></i>' }],
      ['eslint', { id: 'eslint', name: 'ESLint & Linter', author: 'ESLint Team', desc: 'Finds and fixes syntax errors & code quality warnings.', version: 'v8.5', enabled: true, icon: '<i class="fa-solid fa-triangle-exclamation"></i>' }],
      ['python-runner', { id: 'python-runner', name: 'Python IntelliSense & Pyodide', author: 'Python Foundation', desc: 'Rich Python syntax autocompletion & in-browser WASM runtime.', version: 'v2024.2', enabled: true, icon: '<i class="fa-brands fa-python"></i>' }],
      ['live-preview', { id: 'live-preview', name: 'Live Web Preview Server', author: 'Microsoft', desc: 'Real-time embedded browser preview for HTML/CSS/JS files.', version: 'v0.4', enabled: true, icon: '<i class="fa-solid fa-globe"></i>' }],
      ['ai-copilot', { id: 'ai-copilot', name: 'Pulse AI Code Assistant', author: 'Pulse AI', desc: 'AI code completion, bug solver, code explainer & test generator.', version: 'v1.5', enabled: true, icon: '<i class="fa-solid fa-robot"></i>' }],
      ['theme-pack', { id: 'theme-pack', name: 'Pulse Themes Marketplace', author: 'Pulse', desc: 'Sleek themes: Dark+, One Dark Pro, Cyberpunk, Monokai, Dracula.', version: 'v2.1', enabled: true, icon: '<i class="fa-solid fa-paint-roller"></i>' }],
      ['snippets', { id: 'snippets', name: 'Developer Snippets Library', author: 'Community', desc: 'Instant boilerplate templates for Python, JS, React & Web.', version: 'v1.0', enabled: true, icon: '<i class="fa-solid fa-clipboard-list"></i>' }]
    ]);

    this.currentTheme = localStorage.getItem('vscode_theme') || 'vscode-dark';
    this.applyTheme(this.currentTheme);
    this.initAISettings();
  }

  initAISettings() {
    // Configured natively via backend
  }

  toggleExtension(extId) {
    const ext = this.installedExtensions.get(extId);
    if (ext) {
      ext.enabled = !ext.enabled;
      this.installedExtensions.set(extId, ext);
      this.studio.appendConsoleLine(`🧩 Extension "${ext.name}" is now ${ext.enabled ? 'ENABLED ✅' : 'DISABLED ❌'}`, 'system');
      return ext.enabled;
    }
    return false;
  }

  // 1. Prettier Code Formatter
  formatActiveDocument() {
    const activeFile = this.studio.getActiveFile();
    if (!activeFile || (!this.studio.editorTextarea && !this.studio.editor)) return;

    let code = this.studio.editor ? this.studio.editor.getValue() : this.studio.editorTextarea.value;
    const lang = (activeFile.language || 'python').toLowerCase();

    try {
      if (lang === 'json') {
        code = JSON.stringify(JSON.parse(code), null, 2);
      } else if (lang === 'html' || lang === 'xml') {
        code = this.formatHTML(code);
      } else {
        // General JS/Python Indentation Formatter
        const lines = code.split('\n');
        let indentLevel = 0;
        const formatted = lines.map(line => {
          let trimmed = line.trim();
          if (!trimmed) return '';
          if (trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith(')')) {
            indentLevel = Math.max(0, indentLevel - 1);
          }
          const indented = '  '.repeat(indentLevel) + trimmed;
          if (trimmed.endsWith('{') || trimmed.endsWith(':') || trimmed.endsWith('[')) {
            indentLevel++;
          }
          return indented;
        });
        code = formatted.join('\n');
      }

      if (this.studio.editor) {
        this.studio.editor.setValue(code);
      } else {
        this.studio.editorTextarea.value = code;
      }
      activeFile.content = code;
      this.studio.updateLineNumbers();
      this.studio.broadcastCodeChange();
      this.studio.appendConsoleLine('✨ Prettier: Code formatted successfully!', 'system');
    } catch (e) {
      this.studio.appendConsoleLine(`⚠️ Prettier format error: ${e.message}`, 'error');
    }
  }

  formatHTML(htmlStr) {
    let formatted = '';
    let indent = 0;
    const tokens = htmlStr.replace(/>\s*</g, '>\n<').split('\n');
    tokens.forEach(token => {
      let trimmed = token.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('</')) indent = Math.max(0, indent - 1);
      formatted += '  '.repeat(indent) + trimmed + '\n';
      if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.startsWith('<!') && !trimmed.startsWith('<img') && !trimmed.startsWith('<input')) {
        indent++;
      }
    });
    return formatted.trim();
  }

  // 2. ESLint / Syntax Diagnostics
  runLinterCheck() {
    const activeFile = this.studio.getActiveFile();
    if (!activeFile) return [];

    const code = this.studio.editor ? this.studio.editor.getValue() : (this.studio.editorTextarea ? this.studio.editorTextarea.value : activeFile.content);
    const lines = code.split('\n');
    const problems = [];

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;

      // Check unclosed strings
      const doubleQuotes = (line.match(/"/g) || []).length;
      const singleQuotes = (line.match(/'/g) || []).length;
      if (doubleQuotes % 2 !== 0) {
        problems.push({ line: lineNum, type: 'error', message: 'Unterminated string literal (double quotes)' });
      }
      if (singleQuotes % 2 !== 0) {
        problems.push({ line: lineNum, type: 'error', message: 'Unterminated string literal (single quotes)' });
      }

      // Check missing colons in Python def/if/for/while/class
      if (activeFile.language === 'python') {
        const pyKw = line.trim().match(/^(if|elif|else|for|while|def|class|try|except|finally)\b/);
        if (pyKw && !line.trim().endsWith(':') && !line.trim().startsWith('#')) {
          problems.push({ line: lineNum, type: 'warning', message: `Python block '${pyKw[1]}' missing trailing colon ':'` });
        }
      }

      // Check console.log in JS
      if (activeFile.language === 'javascript' && line.includes('console.log')) {
        problems.push({ line: lineNum, type: 'info', message: 'Consider replacing console.log with proper logger' });
      }
    });

    return problems;
  }

  // 3. Real AI Copilot Engine
  async askAICopilot(promptType, customPrompt = '') {
    const activeFile = this.studio.getActiveFile() || { name: 'main.py', language: 'python', content: '' };
    const code = this.studio.editor ? this.studio.editor.getValue() : (this.studio.editorTextarea ? this.studio.editorTextarea.value : activeFile.content);

    this.studio.appendConsoleLine(`🤖 Pulse AI Copilot is analyzing active file (${activeFile.name})...`, 'system');

    const container = document.getElementById('copilot-response-container');
    const contentBox = document.getElementById('copilot-response-content');
    const btnBox = document.getElementById('copilot-action-buttons');

    if (container) container.style.display = 'block';
    if (contentBox) contentBox.innerHTML = '<div style="color:var(--text-muted);font-style:italic;">🤖 Thinking...</div>';
    if (btnBox) btnBox.innerHTML = '';

    try {
      const res = await fetch('/api/ai-copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: promptType,
          prompt: customPrompt,
          code: code,
          filename: activeFile.name,
          language: activeFile.language || 'python'
        })
      });

      if (!res.ok) throw new Error('AI API request failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let fullResponse = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                fullResponse += parsed.choices[0].delta.content;

                let formattedMD = fullResponse
                  .replace(/### (.*?)\n/g, '<h4 style="color:#38bdf8;margin:6px 0;">$1</h4>')
                  .replace(/#### (.*?)\n/g, '<h5 style="color:#a855f7;margin:4px 0;">$1</h5>')
                  .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                  .replace(/\*(.*?)\*/g, '<em>$1</em>')
                  .replace(/```(\w+)?\n([\s\S]*?)(```|$)/g, '<pre style="background:#0f172a;padding:8px;border-radius:6px;overflow-x:auto;font-family:monospace;font-size:0.78rem;margin:8px 0;border:1px solid rgba(255,255,255,0.06);">$2</pre>')
                  .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:4px;font-family:monospace;font-size:0.8rem;">$1</code>')
                  .replace(/\n/g, '<br>');

                if (contentBox) contentBox.innerHTML = formattedMD;
              }
            } catch (e) { }
          }
        }
      }

      this.studio.appendConsoleLine(`🤖 AI Response ready for [${promptType.toUpperCase()}]`, 'system');

      let extractedCode = '';
      const codeBlockMatch = fullResponse.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        extractedCode = codeBlockMatch[1].trim();
      }

      if (btnBox && extractedCode) {
        btnBox.innerHTML = '';
        
        const btnApply = document.createElement('button');
        btnApply.className = 'btn-panel-btn primary';
        btnApply.style.cssText = 'padding:6px 12px;font-size:0.75rem;';
        btnApply.innerText = '⚡ Apply AI Code to Editor';
        btnApply.addEventListener('click', () => {
          if (this.studio.editor) {
            this.studio.editor.setValue(extractedCode);
            activeFile.content = extractedCode;
            this.studio.updateLineNumbers();
            this.studio.broadcastCodeChange();
            this.studio.appendConsoleLine(`⚡ Applied AI generated code to ${activeFile.name}!`, 'system');
          } else if (this.studio.editorTextarea) {
            this.studio.editorTextarea.value = extractedCode;
            activeFile.content = extractedCode;
            this.studio.updateLineNumbers();
            this.studio.broadcastCodeChange();
            this.studio.appendConsoleLine(`⚡ Applied AI generated code to ${activeFile.name}!`, 'system');
          }
        });
        btnBox.appendChild(btnApply);

        const btnNewFile = document.createElement('button');
        btnNewFile.className = 'btn-panel-btn';
        btnNewFile.style.cssText = 'padding:6px 12px;font-size:0.75rem;';
        btnNewFile.innerText = '📄 Create New File';
        btnNewFile.addEventListener('click', () => {
          const fname = prompt('Enter new file name:', `ai_generated_${Date.now().toString().slice(-4)}.${activeFile.language === 'python' ? 'py' : 'js'}`);
          if (fname) {
            this.studio.createNewFile(fname, extractedCode);
            this.studio.appendConsoleLine(`📄 Created file ${fname} with AI code!`, 'system');
          }
        });
        btnBox.appendChild(btnNewFile);
      }
    } catch (err) {
      if (contentBox) contentBox.innerHTML = `<div style="color:#ef4444;">⚠️ AI Copilot error: ${err.message}</div>`;
      this.studio.appendConsoleLine(`⚠️ AI Copilot call failed: ${err.message}`, 'error');
    }
  }

  // 4. Theme Switcher
  applyTheme(themeName) {
    this.currentTheme = themeName;
    localStorage.setItem('vscode_theme', themeName);

    document.body.classList.remove('theme-vscode-dark', 'theme-onedark', 'theme-cyberpunk', 'theme-dracula', 'theme-monokai');
    document.body.classList.add(`theme-${themeName}`);
  }

  // 5. Code Snippet Generator
  insertSnippet(snippetKey) {
    const snippets = {
      'py-main': `def main():\n    print("Hello from Python Main Function!")\n\nif __name__ == '__main__':\n    main()\n`,
      'py-class': `class Developer:\n    def __init__(self, name, language):\n        self.name = name\n        self.language = language\n\n    def code(self):\n        return f"{self.name} is coding in {self.language}!"\n\ndev = Developer("Karan", "Python")\nprint(dev.code())\n`,
      'js-fetch': `async function fetchData(url) {\n  try {\n    const response = await fetch(url);\n    const data = await response.json();\n    console.log("API Response:", data);\n  } catch (error) {\n    console.error("Fetch Error:", error);\n  }\n}\n`,
      'html5': `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>Live Preview</title>\n  <style>\n    body {\n      background: #1e1e2e;\n      color: #cdd6f4;\n      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      height: 100vh;\n      margin: 0;\n    }\n    .card {\n      background: #313244;\n      padding: 30px;\n      border-radius: 12px;\n      box-shadow: 0 10px 30px rgba(0,0,0,0.4);\n      text-align: center;\n    }\n    h1 { color: #89b4fa; margin-bottom: 10px; }\n  </style>\n</head>\n<body>\n  <div class="card">\n    <h1>🚀 Pulse Live Preview</h1>\n    <p>Edit HTML/CSS to see real-time updates!</p>\n  </div>\n</body>\n</html>\n`
    };

    if (snippets[snippetKey]) {
      if (this.studio.editor) {
        const doc = this.studio.editor.getDoc();
        const cursor = doc.getCursor();
        doc.replaceRange(snippets[snippetKey], cursor);
        this.studio.getActiveFile().content = this.studio.editor.getValue();
        this.studio.updateLineNumbers();
        this.studio.broadcastCodeChange();
        this.studio.appendConsoleLine(`📋 Snippet "${snippetKey}" inserted into editor.`, 'system');
      } else if (this.studio.editorTextarea) {
        const start = this.studio.editorTextarea.selectionStart;
        const end = this.studio.editorTextarea.selectionEnd;
        const val = this.studio.editorTextarea.value;
        const snippet = snippets[snippetKey];

        this.studio.editorTextarea.value = val.substring(0, start) + snippet + val.substring(end);
        this.studio.getActiveFile().content = this.studio.editorTextarea.value;
        this.studio.updateLineNumbers();
        this.studio.broadcastCodeChange();
        this.studio.appendConsoleLine(`📋 Snippet "${snippetKey}" inserted into editor.`, 'system');
      }
    }
  }
}

window.VSCodeExtensionEngine = VSCodeExtensionEngine;
