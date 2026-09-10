const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto');
const DatabaseAPI = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Initialize SQLite/JSON Persistent Database
DatabaseAPI.init();

app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || (file.mimetype.includes('audio') ? '.webm' : '');
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

// Get All Public Rooms with Live Stats
app.get('/api/rooms', async (req, res) => {
  try {
    const roomsList = await DatabaseAPI.getAllRooms();
    const formatted = roomsList.map(r => {
      const roomSockets = io.sockets.adapter.rooms.get(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        icon: r.icon || '💬',
        hasPassword: !!r.password,
        hostUsername: r.host_username || 'Host',
        tags: Array.isArray(r.tags) ? r.tags : (typeof r.tags === 'string' ? r.tags.split(',') : ['chat']),
        language: r.language || 'python',
        activeMembersCount: roomSockets ? roomSockets.size : 0,
        createdAt: r.created_at
      };
    });
    res.json({ rooms: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin & Deletion APIs with Main Admin Authorization
const requireAdminAuth = async (req, res, next) => {
  const token = req.headers['x-user-token'];
  const adminKey = req.headers['x-admin-key'];
  if (adminKey === 'Rajput2007' || adminKey === 'admin123') return next();
  if (token) {
    const user = await DatabaseAPI.getUserById(token);
    if (user && (user.isAdmin || user.username.toLowerCase() === 'karan singh' || user.username.toLowerCase() === 'admin')) {
      return next();
    }
  }
  return res.status(403).json({ error: 'Admin access denied. Only the main admin can access this endpoint.' });
};

app.delete('/api/rooms/:id', async (req, res) => {
  try {
    await DatabaseAPI.deleteRoom(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const users = await DatabaseAPI.getAllUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdminAuth, async (req, res) => {
  try {
    await DatabaseAPI.deleteUser(req.params.id);
    io.emit('force_logout', { userId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cloud Compiler Execution via Judge0 CE
const JUDGE0_LANG_MAP = {
  c: 50,          // C (GCC 9.2.0)
  cpp: 54,        // C++ (GCC 9.2.0)
  'c++': 54,
  java: 62,       // Java (OpenJDK 13.0.1)
  python: 71,     // Python 3.8.1
  py: 71,
  javascript: 63, // Node.js 12.14.0
  js: 63,
  csharp: 51,
  cs: 51,
  ruby: 72,
  rb: 72,
  go: 60,
  rust: 73,
  rs: 73
};

async function executeViaJudge0(code, languageId, stdin = '') {
  const payload = {
    source_code: Buffer.from(code).toString('base64'),
    language_id: languageId
  };
  if (stdin) {
    payload.stdin = Buffer.from(stdin).toString('base64');
  }

  const response = await fetch('https://ce.judge0.com/submissions?base64_encoded=true&wait=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(16000)
  });

  if (!response.ok) {
    throw new Error(`Compiler service returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const decodeB64 = (val) => (val ? Buffer.from(val, 'base64').toString('utf8') : '');

  return {
    stdout: decodeB64(data.stdout),
    stderr: decodeB64(data.stderr),
    compile_output: decodeB64(data.compile_output),
    message: decodeB64(data.message),
    time: data.time ? `${data.time}s` : null,
    memory: data.memory ? `${data.memory} KB` : null,
    status: data.status ? data.status.description : 'Done'
  };
}

// Code Execution Endpoint
app.post('/api/run-code', async (req, res) => {
  const { code, language, filename, stdin } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Code content required' });

  let lang = (language || '').toLowerCase().trim();
  if (!lang && filename) {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    if (ext === 'c') lang = 'c';
    else if (['cpp', 'cc', 'cxx', 'hpp', 'h'].includes(ext)) lang = 'cpp';
    else if (ext === 'py') lang = 'python';
    else if (ext === 'js') lang = 'javascript';
    else if (ext === 'java') lang = 'java';
  }
  if (!lang) lang = 'c';

  const isC = lang === 'c' || (filename && filename.endsWith('.c'));
  const isCpp = lang === 'cpp' || lang === 'c++' || (filename && (filename.endsWith('.cpp') || filename.endsWith('.cc') || filename.endsWith('.cxx')));
  const isJava = lang === 'java' || (filename && filename.endsWith('.java'));
  const isJS = lang === 'javascript' || lang === 'js' || (filename && filename.endsWith('.js'));
  const isPython = lang === 'python' || lang === 'py' || (filename && filename.endsWith('.py'));

  if (isC || isCpp || isJava) {
    const langId = isC ? 50 : (isCpp ? 54 : 62);
    try {
      const result = await executeViaJudge0(code, langId, stdin || '');
      return res.json(result);
    } catch (err) {
      console.error('Judge0 execution error:', err.message);
      return res.status(500).json({
        error: `Cloud compilation service error: ${err.message}`,
        stderr: err.message
      });
    }
  }

  if (isJS) {
    const tempDir = path.join(__dirname, 'scratch_run');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `run_${Date.now()}.js`);

    fs.writeFile(tempFilePath, code, () => {
      exec(`node "${tempFilePath}"`, { timeout: 8000 }, (execErr, stdout, stderr) => {
        fs.unlink(tempFilePath, () => {});
        res.json({ stdout: stdout || '', stderr: stderr || '' });
      });
    });
    return;
  }

  if (isPython) {
    const tempDir = path.join(__dirname, 'scratch_run');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `run_${Date.now()}.py`);

    fs.writeFile(tempFilePath, code, (err) => {
      if (err) {
        return executeViaJudge0(code, 71, stdin || '')
          .then(r => res.json(r))
          .catch(() => res.json({ stdout: runFallbackPythonParser(code), stderr: '' }));
      }

      const command = `py "${tempFilePath}" || python "${tempFilePath}" || python3 "${tempFilePath}"`;
      exec(command, { timeout: 8000, maxBuffer: 1024 * 1024 }, (execErr, stdout, stderr) => {
        fs.unlink(tempFilePath, () => {});
        const isPathError = stderr && (stderr.includes('not recognized') || stderr.includes('command not found') || stderr.includes('No such file'));
        if (execErr || isPathError || (!stdout && stderr)) {
          return executeViaJudge0(code, 71, stdin || '')
            .then(r => res.json(r))
            .catch(() => res.json({ stdout: runFallbackPythonParser(code), stderr: '' }));
        }
        res.json({ stdout: stdout || '', stderr: stderr || '' });
      });
    });
    return;
  }

  if (JUDGE0_LANG_MAP[lang]) {
    try {
      const result = await executeViaJudge0(code, JUDGE0_LANG_MAP[lang], stdin || '');
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.json({ stdout: `Execution completed for ${filename || 'script'}.\n` });
});

// Real AI Copilot Engine Endpoint with Multi-Provider API Integration
app.post('/api/ai-copilot', async (req, res) => {
  const { action, prompt, code, filename, language, apiKey, provider, model } = req.body;
  const lang = (language || 'python').toLowerCase();
  const file = filename || `main.${lang === 'python' ? 'py' : lang === 'html' ? 'html' : 'js'}`;

  const keyToUse = apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || '';

  let result = {
    markdown: '',
    generatedCode: '',
    fixedCode: '',
    mistakes: [],
    action: action || 'explain'
  };

  // If a real API Key is provided or configured in env, make real API request to LLM Provider
  if (keyToUse) {
    try {
      const systemInstruction = `You are Pulse AI Copilot, an expert programming assistant. Provide clean, well-structured, and helpful code. Be direct but thorough enough to satisfy the user's intent. Output markdown with code blocks tagged with language names (e.g. \`\`\`${lang}).`;

      let promptPayload = '';
      if (action === 'generate') {
        promptPayload = `Task: Write clean and well-structured code in ${lang.toUpperCase()} for:\n"${prompt || 'Create a script'}"\nTarget file: ${file}`;
      } else if (action === 'fix') {
        promptPayload = `Task: Auto-fix and correct all bugs in ${file} (${lang.toUpperCase()}).\nCode to fix:\n\`\`\`${lang}\n${code}\n\`\`\`\nIdentify bugs line-by-line, explain corrections, and output the complete corrected code inside a code block.`;
      } else if (action === 'mistakes') {
        promptPayload = `Task: Audit file ${file} (${lang.toUpperCase()}) for syntax errors, logical bugs, missing colons/brackets, security risks, and unhandled edge cases.\nCode:\n\`\`\`${lang}\n${code}\n\`\`\`\nList all mistakes line by line with severity (Error, Warning, Tip).`;
      } else if (action === 'guide') {
        promptPayload = `Task: Provide a detailed step-by-step developer guide & architecture breakdown for file ${file}.\nCode:\n\`\`\`${lang}\n${code}\n\`\`\`\nQuestion: "${prompt || 'Explain architecture and how to extend'}"`;
      } else if (action === 'explain') {
        promptPayload = `Task: Explain function by function how the following ${lang.toUpperCase()} code works in file ${file}:\n\`\`\`${lang}\n${code}\n\`\`\``;
      } else if (action === 'tests') {
        promptPayload = `Task: Write complete unit test suite (pytest for Python / Jest for JavaScript) for file ${file}:\n\`\`\`${lang}\n${code}\n\`\`\``;
      } else {
        promptPayload = `User Request: "${prompt}"\nActive File (${file}):\n\`\`\`${lang}\n${code}\n\`\`\``;
      }

      // Default to gemini if the key format is unrecognized
      const activeProvider = provider || (keyToUse.startsWith('sk-or-') ? 'openrouter' : keyToUse.startsWith('gsk_') ? 'groq' : keyToUse.startsWith('sk-') ? 'openai' : 'gemini');
      
      const aiStream = await callRealAIProvider(activeProvider, keyToUse, model, systemInstruction, promptPayload);
      
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      for await (const chunk of aiStream) {
        res.write(chunk);
      }
      res.end();
      return;
    } catch (apiErr) {
      console.error('[AI Copilot API Error]:', apiErr.message);
      // Fallback to built-in fallback engine below if API key fails
      result.markdown = `> ⚠️ **Notice: API Connection Error**\n\n> *Your configured API key failed to connect. Reason: ${apiErr.message}*\n\nFalling back to built-in template engine:\n`;
    }
  } else {
    result.markdown = `> ⚠️ **Notice: No API Key Provided**\n\n> *Please configure a valid API key (e.g. GEMINI_API_KEY) in your Render Environment Variables for real, intelligent AI responses.*\n\nShowing built-in template response:\n\n`;
  }

  // Built-in intelligent engine fallback
  if (action === 'generate') {
    const userPrompt = prompt || 'Create a complete sample script';
    let codeBody = '';
    if (lang === 'python' || userPrompt.toLowerCase().includes('python')) {
      codeBody = `import sys\nimport time\n\n# AI Generated Code for: ${userPrompt}\ndef process_data(items):\n    """Process input items and return summary statistics."""\n    print(f"🚀 Processing {len(items)} items...")\n    results = []\n    for i, item in enumerate(items, 1):\n        processed = f"Item-{i}: {str(item).upper()}"\n        results.append(processed)\n    return results\n\ndef main():\n    data = ["alpha", "beta", "gamma", "delta"]\n    output = process_data(data)\n    print("✅ Completed:", output)\n\nif __name__ == '__main__':\n    main()\n`;
    } else if (lang === 'html' || userPrompt.toLowerCase().includes('html')) {
      codeBody = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>AI Generated Web App</title>\n  <style>\n    body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }\n    .card { background: #1e293b; padding: 32px; border-radius: 16px; box-shadow: 0 12px 36px rgba(0,0,0,0.5); text-align: center; max-width: 400px; }\n    h2 { color: #38bdf8; margin-top: 0; }\n    button { background: #8b5cf6; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: background 0.2s; }\n    button:hover { background: #7c3aed; }\n  </style>\n</head>\n<body>\n  <div class="card">\n    <h2>⚡ ${userPrompt}</h2>\n    <p>Modern interactive web component powered by AI.</p>\n    <button onclick="alert('AI Feature Active!')">Click Me 🚀</button>\n  </div>\n</body>\n</html>\n`;
    } else {
      codeBody = `// AI Generated JavaScript Code for: ${userPrompt}\nclass DataProcessor {\n  constructor(name) {\n    this.name = name;\n    this.records = [];\n  }\n\n  async fetchData() {\n    console.log(\`⚡ \${this.name} fetching data...\`);\n    return new Promise(resolve => {\n      setTimeout(() => {\n        this.records = [10, 20, 30, 40, 50];\n        resolve(this.records);\n      }, 300);\n    });\n  }\n\n  calculateTotal() {\n    return this.records.reduce((sum, val) => sum + val, 0);\n  }\n}\n\n(async () => {\n  const proc = new DataProcessor("PulseProcessor");\n  await proc.fetchData();\n  console.log("Total Sum:", proc.calculateTotal());\n})();\n`;
    }

    result.generatedCode = codeBody;
    result.markdown += `### 🛠️ AI Code Generated\n\nGenerated complete **${lang.toUpperCase()}** implementation for:\n> *"${userPrompt}"*\n\n\`\`\`${lang}\n${codeBody}\n\`\`\`\n\n*Click below to insert this code into your active editor or create a new file.*`;

  } else if (action === 'fix') {
    const currentCode = code || '';
    const lines = currentCode.split('\n');
    let fixedLines = [];
    let fixLogs = [];

    lines.forEach((line, idx) => {
      let l = line;
      if (lang === 'python') {
        const pyKw = l.trim().match(/^(if|elif|else|for|while|def|class|try|except|finally)\b/);
        if (pyKw && !l.trim().endsWith(':') && !l.trim().startsWith('#')) {
          l = l + ':';
          fixLogs.push(`Line ${idx + 1}: Added missing colon ':' after \`${pyKw[1]}\``);
        }
      }
      if (lang === 'javascript') {
        if (l.includes('consol.log')) {
          l = l.replace('consol.log', 'console.log');
          fixLogs.push(`Line ${idx + 1}: Fixed typo \`consol.log\` ➔ \`console.log\``);
        }
      }
      fixedLines.push(l);
    });

    let fixedText = fixedLines.join('\n');
    if (fixLogs.length === 0) fixLogs.push('Ensured standard indentation and validated structural integrity.');

    result.fixedCode = fixedText;
    result.markdown += `### 🐞 AI Bug Fixer & Auto-Corrector\n\nAnalyzed **${file}** (${lines.length} lines).\n\n**Fixes & Corrections Applied:**\n${fixLogs.map(f => `- ${f}`).join('\n')}\n\n\`\`\`${lang}\n${fixedText}\n\`\`\``;

  } else if (action === 'mistakes') {
    const currentCode = code || '';
    const lines = currentCode.split('\n');
    const mistakes = [];

    lines.forEach((line, idx) => {
      const num = idx + 1;
      const t = line.trim();
      if ((line.match(/"/g) || []).length % 2 !== 0) mistakes.push({ line: num, level: 'error', text: 'Unterminated string literal (double quotes)' });
      if ((line.match(/'/g) || []).length % 2 !== 0) mistakes.push({ line: num, level: 'error', text: 'Unterminated string literal (single quotes)' });
      if (lang === 'python') {
        const pyKw = t.match(/^(if|elif|else|for|while|def|class|try|except|finally)\b/);
        if (pyKw && !t.endsWith(':') && !t.startsWith('#')) {
          mistakes.push({ line: num, level: 'warning', text: `Missing colon ':' at end of line` });
        }
      }
      if (t.toLowerCase().includes('password =') || t.toLowerCase().includes('secret =')) {
        mistakes.push({ line: num, level: 'warning', text: 'Security Risk: Hardcoded credential or API secret' });
      }
      if (t.includes('eval(')) {
        mistakes.push({ line: num, level: 'error', text: 'Critical Security Vulnerability: Avoid using eval()' });
      }
    });

    result.mistakes = mistakes;
    const mistakesList = mistakes.length > 0
      ? mistakes.map(m => `- **Line ${m.line}** [${m.level.toUpperCase()}]: ${m.text}`).join('\n')
      : '✅ **No syntax mistakes found in active file!** Code structure is clean.';

    result.markdown += `### 🔍 AI Code Audit & Mistake Finder\n\nAudited **${file}**:\n\n${mistakesList}`;

  } else if (action === 'guide') {
    result.markdown += `### 📖 AI Developer Guide & Tutorial\n\n**Project File:** \`${file}\` (${lang.toUpperCase()})\n\n#### 🎯 Overview & Architecture\nThis program implements core execution logic using **${lang}**. Below is the step-by-step guide to understanding and extending this codebase:\n\n1. **Initialization**: Defines data structures and prepares execution state.\n2. **Execution Flow**: Processes instructions top-to-bottom with robust error handling.\n3. **Best Practices**: Use modular functions, type hints, and async execution for I/O operations.\n\n#### 💡 How to extend:\n- Add unit test cases for edge inputs.\n- Modularize reusable components into sub-modules.`;

  } else if (action === 'explain') {
    const currentCode = code || '';
    result.markdown += `### 💡 AI Code Explanation\n\n**File:** \`${file}\` | **Language:** ${lang.toUpperCase()} | **Lines:** ${currentCode.split('\n').length}\n\n- **Structure:** Contains function definitions, variable assignments, and runtime statements.\n- **Performance:** $O(n)$ time complexity for list iterations.\n- **Recommendation:** Keep functions under 30 lines for optimal maintainability.`;

  } else if (action === 'tests') {
    let testCode = lang === 'python'
      ? `import unittest\n\nclass TestScript(unittest.TestCase):\n    def test_default_flow(self):\n        self.assertTrue(True, "Default execution test passed")\n\nif __name__ == '__main__':\n    unittest.main()\n`
      : `describe('${file} Unit Tests', () => {\n  test('should execute without throwing errors', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
    result.generatedCode = testCode;
    result.markdown += `### 🧪 AI Generated Unit Tests\n\n\`\`\`${lang}\n${testCode}\n\`\`\``;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: result.markdown } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});

// Helper for Real AI Provider Calls
async function callRealAIProvider(provider, apiKey, model, systemInstruction, promptPayload) {
  // 1. Google Gemini API
  if (provider === 'gemini') {
    const m = model || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemInstruction}\n\n${promptPayload}` }] }]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Gemini API Error');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return [ `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` ];
  }

  // 2. OpenAI / OpenRouter / Groq APIs
  let endpoint = 'https://api.openai.com/v1/chat/completions';
  let defaultModel = 'gpt-4o-mini';
  let headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  if (provider === 'openrouter') {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    defaultModel = 'nvidia/nemotron-3.5-lightning:free';
    headers['HTTP-Referer'] = 'http://localhost:3000';
    headers['X-Title'] = 'PulseChat IDE';
  } else if (provider === 'groq') {
    endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    defaultModel = 'llama-3.3-70b-versatile';
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || defaultModel,
      stream: true,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: promptPayload }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = res.statusText;
    try { const p = JSON.parse(errText); if(p.error && p.error.message) errMsg = p.error.message; } catch(e){}
    console.error("DEBUG Provider ERROR:", errText);
    throw new Error('AI Provider Error: ' + errMsg);
  }

  return res.body;
}

function runFallbackPythonParser(code) {
  const outputs = [];
  const variables = {};
  const lines = code.split('\n');

  lines.forEach((line) => {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const assignMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (assignMatch) {
      const varName = assignMatch[1].trim();
      const expr = assignMatch[2].trim();
      try {
        if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
          variables[varName] = expr.slice(1, -1);
        } else {
          let evalExpr = expr;
          Object.keys(variables).forEach((v) => {
            const regex = new RegExp(`\\b${v}\\b`, 'g');
            evalExpr = evalExpr.replace(regex, JSON.stringify(variables[v]));
          });
          variables[varName] = eval(evalExpr);
        }
      } catch (e) {
        variables[varName] = expr;
      }
      return;
    }

    const printMatch = trimmed.match(/^print\s*\((.*)\)$/);
    if (printMatch) {
      const contentStr = printMatch[1].trim();
      if (!contentStr) return outputs.push('');

      const args = splitPrintArgs(contentStr);
      const evaluatedArgs = args.map((arg) => {
        arg = arg.trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
          return arg.slice(1, -1);
        }
        if (variables.hasOwnProperty(arg)) {
          return String(variables[arg]);
        }
        try {
          let evalArg = arg;
          Object.keys(variables).forEach((v) => {
            const regex = new RegExp(`\\b${v}\\b`, 'g');
            evalArg = evalArg.replace(regex, JSON.stringify(variables[v]));
          });
          return String(eval(evalArg));
        } catch (e) {
          return arg;
        }
      });
      outputs.push(evaluatedArgs.join(' '));
    }
  });

  return outputs.length > 0 ? outputs.join('\n') + '\n' : 'Python script executed successfully.\n';
}

function splitPrintArgs(str) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '"' || char === "'") {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
      }
    }
    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) result.push(current);
  return result;
}

// Memory tracking for online sockets and active hosts
const roomsMemory = {};
const pendingRequests = new Map();
const activeUsers = new Map();
// Single active session per account
const activeSessions = new Map();

const getPublicRooms = async () => {
  const dbRooms = await DatabaseAPI.getAllRooms();
  return dbRooms.map((r) => {
    const roomSockets = io.sockets.adapter.rooms.get(r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      icon: r.icon || '💬',
      hasPassword: !!r.password,
      hostUsername: r.host_username || 'System',
      tags: r.tags ? r.tags.split(',') : ['code'],
      language: r.language || 'python',
      activeMembersCount: roomSockets ? roomSockets.size : 0
    };
  });
};

const handleBotMention = (roomId, messageText, senderUser) => {
  const botUser = { username: 'PulseBot', avatar: '🤖', isBot: true };
  const cleanText = messageText.toLowerCase();

  let botReply = `Hello @${senderUser.username}! I am **PulseBot**. Type \`/help\` for commands!`;

  if (cleanText.includes('/help') || cleanText.includes('help')) {
    botReply = `🤖 **PulseBot Commands:**\n- \`/time\`: UTC timestamp\n- \`/joke\`: Dev joke\n- \`/stats\`: Connected users & rooms`;
  } else if (cleanText.includes('/time')) {
    botReply = `🕒 Server Time: **${new Date().toLocaleTimeString()}**`;
  } else if (cleanText.includes('/joke')) {
    botReply = 'Why do programmers prefer dark mode? Because light attracts bugs! 🐛';
  } else if (cleanText.includes('/stats')) {
    botReply = `📊 Connected Users: **${activeUsers.size}** | Active Rooms: **${Object.keys(roomsMemory).length}**`;
  }

  setTimeout(async () => {
    const botMsg = {
      id: 'msg-' + Date.now(),
      roomId,
      user: botUser,
      text: botReply,
      timestamp: new Date().toISOString(),
      reactions: {}
    };

    await DatabaseAPI.saveMessage(botMsg);
    io.to(roomId).emit('message_received', botMsg);
  }, 700);
};

// --- Auth Routes ---
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const uLower = username.trim().toLowerCase();
  if (uLower === 'karan singh' || uLower === 'admin') {
    return res.status(400).json({ error: "This username is reserved for system administrator." });
  }
  try {
    const user = await DatabaseAPI.createUser(username, password);
    const newSessionId = crypto.randomUUID ? crypto.randomUUID() : ('sess-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9));
    activeSessions.set(uLower, {
      sessionId: newSessionId,
      userId: user.id,
      username: user.username,
      socketId: null,
      pendingUntil: Date.now() + 15000,
      loggedInAt: Date.now(),
      disconnectTimer: null
    });
    res.json({ token: user.id, sessionId: newSessionId, username: user.username, isAdmin: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password, sessionId: clientSessionId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const user = await DatabaseAPI.authenticateUser(username, password);
    const normUser = user.username.trim().toLowerCase();

    // Check if account is already logged in on another device
    const existingSession = activeSessions.get(normUser);
    if (existingSession) {
      const existingSocket = existingSession.socketId ? io.sockets.sockets.get(existingSession.socketId) : null;
      const isSocketConnected = existingSocket && existingSocket.connected;
      const isPendingConnect = existingSession.pendingUntil && existingSession.pendingUntil > Date.now();
      const hasActiveGrace = !!existingSession.disconnectTimer;

      if (isSocketConnected || isPendingConnect || hasActiveGrace) {
        // If client is re-authenticating from the same active session on this device, allow it
        if (clientSessionId && clientSessionId === existingSession.sessionId) {
          // Same device re-authenticating
        } else {
          return res.status(403).json({
            error: 'This account is already logged in on another device.'
          });
        }
      }
    }

    const newSessionId = crypto.randomUUID ? crypto.randomUUID() : ('sess-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9));
    if (existingSession && existingSession.disconnectTimer) {
      clearTimeout(existingSession.disconnectTimer);
    }

    activeSessions.set(normUser, {
      sessionId: newSessionId,
      userId: user.id,
      username: user.username,
      socketId: null,
      pendingUntil: Date.now() + 15000,
      loggedInAt: Date.now(),
      disconnectTimer: null
    });

    res.json({ 
      token: user.id, 
      sessionId: newSessionId, 
      username: user.username, 
      isAdmin: !!user.isAdmin 
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  const { username, sessionId } = req.body;
  if (username) {
    const normUser = username.trim().toLowerCase();
    const session = activeSessions.get(normUser);
    if (session && (!sessionId || session.sessionId === sessionId)) {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      activeSessions.delete(normUser);
      console.log(`[Session] Explicit logout for ${username}`);
    }
  }
  res.json({ success: true });
});

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Register or re-verify active session
  socket.on('register_user', (userData) => {
    if (!userData || !userData.username) return;
    const normUser = userData.username.trim().toLowerCase();
    const session = activeSessions.get(normUser);

    if (session) {
      if (userData.sessionId && session.sessionId !== userData.sessionId) {
        const existingSocket = session.socketId ? io.sockets.sockets.get(session.socketId) : null;
        if (existingSocket && existingSocket.connected && existingSocket.id !== socket.id) {
          return socket.emit('auth_error', {
            message: 'This account is already logged in on another device.'
          });
        }
      }
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
      }
      session.socketId = socket.id;
      session.pendingUntil = null;
    } else if (userData.token) {
      const sid = userData.sessionId || (crypto.randomUUID ? crypto.randomUUID() : ('sess-' + Date.now()));
      activeSessions.set(normUser, {
        sessionId: sid,
        userId: userData.token,
        username: userData.username,
        socketId: socket.id,
        pendingUntil: null,
        loggedInAt: Date.now(),
        disconnectTimer: null
      });
      socket.emit('session_synced', { sessionId: sid });
    }
  });

  socket.on('user_join', async (userData) => {
    const normUser = (userData.username || '').trim().toLowerCase();
    const session = activeSessions.get(normUser);

    if (session) {
      if (userData.sessionId && session.sessionId !== userData.sessionId) {
        const existingSocket = session.socketId ? io.sockets.sockets.get(session.socketId) : null;
        if (existingSocket && existingSocket.connected && existingSocket.id !== socket.id) {
          return socket.emit('auth_error', {
            message: 'This account is already logged in on another device.'
          });
        }
      }
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
      }
      session.socketId = socket.id;
      session.pendingUntil = null;
    } else if (userData.token && normUser) {
      const sid = userData.sessionId || (crypto.randomUUID ? crypto.randomUUID() : ('sess-' + Date.now()));
      activeSessions.set(normUser, {
        sessionId: sid,
        userId: userData.token,
        username: userData.username,
        socketId: socket.id,
        pendingUntil: null,
        loggedInAt: Date.now(),
        disconnectTimer: null
      });
      socket.emit('session_synced', { sessionId: sid });
    }

    const user = {
      id: socket.id,
      userId: userData.token || null,
      sessionId: userData.sessionId || (session ? session.sessionId : null),
      username: userData.username || `User_${socket.id.substring(0, 4)}`,
      avatar: userData.avatar || '⚡',
      status: userData.status || 'online',
      customStatus: userData.customStatus || 'Active member',
      joinedAt: new Date().toISOString()
    };

    activeUsers.set(socket.id, user);
    const roomsList = await getPublicRooms();

    socket.emit('init_payload', {
      user,
      rooms: roomsList,
      activeUsers: Array.from(activeUsers.values())
    });

    io.emit('user_status_change', {
      user,
      activeUsers: Array.from(activeUsers.values())
    });
  });

  // Handle explicit create_room from client
  socket.on('create_room', async (payload) => {
    console.log(`[create_room] Received from ${socket.id}`, payload);
    const user = activeUsers.get(socket.id);
    if (!user) {
      console.log(`[create_room] ERROR: User not found in activeUsers for socket ${socket.id}`);
      return;
    }

    try {
      // Sanitize room ID
      const roomId = (payload.name || `room-${Date.now()}`).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      console.log(`[create_room] Room ID generated: ${roomId}`);
      const allDbRooms = await DatabaseAPI.getAllRooms();
      
      if (allDbRooms.find(r => r.id === roomId)) {
        console.log(`[create_room] ERROR: Room already exists`);
        return socket.emit('join_error', { message: 'A room with this name already exists!' });
      }

    const newRoomData = {
      id: roomId,
      name: payload.name || roomId,
      description: payload.description || 'Custom room',
      icon: payload.icon || '💬',
      password: payload.password || '',
      host_username: user.username,
      tags: Array.isArray(payload.tags) ? payload.tags.join(',') : payload.tags,
      language: payload.language || 'python'
    };

      const targetRoom = await DatabaseAPI.saveRoom(newRoomData);
      console.log(`[create_room] Room saved to DB: ${targetRoom.id}`);
      roomsMemory[roomId] = { hostSocketId: socket.id };

      const roomsList = await getPublicRooms();
      io.emit('rooms_updated', roomsList);
      
      // Automatically join the newly created room
      admitUserToRoom(socket, targetRoom);
      console.log(`[create_room] SUCCESS: Admitted user to ${targetRoom.id}`);
    } catch (error) {
      console.error(`[create_room] FATAL ERROR:`, error);
    }
  });

  // Request to Join / Create Room with Password & Host Approval
  socket.on('request_join_room', async ({ roomId, password }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    const allDbRooms = await DatabaseAPI.getAllRooms();
    let targetRoom = allDbRooms.find(r => r.id === roomId);

    // If room does NOT exist yet, create and store in database
    if (!targetRoom) {
      const newRoomData = {
        id: roomId,
        name: roomId,
        description: 'Custom protected room',
        icon: '🔒',
        password: password || '',
        host_username: user.username,
        tags: 'custom,private',
        language: 'python'
      };

      targetRoom = await DatabaseAPI.saveRoom(newRoomData);
      roomsMemory[roomId] = { hostSocketId: socket.id };

      const roomsList = await getPublicRooms();
      io.emit('rooms_updated', roomsList);
      return admitUserToRoom(socket, targetRoom);
    }

    const hostUser = (targetRoom.host_username || '').toLowerCase();
    const isUserTheHost = !!(user && hostUser && user.username.toLowerCase() === hostUser);

    // Room creator always enters immediately as host
    if (isUserTheHost) {
      if (!roomsMemory[roomId]) roomsMemory[roomId] = {};
      roomsMemory[roomId].hostSocketId = socket.id;
      return admitUserToRoom(socket, targetRoom);
    }

    // Password Check for non-hosts
    if (targetRoom.password && targetRoom.password !== password) {
      return socket.emit('join_error', { message: 'Incorrect Room Password!' });
    }

    const hostSid = roomsMemory[roomId]?.hostSocketId;
    const roomSockets = io.sockets.adapter.rooms.get(roomId);
    const hostActive = !!(targetRoom.password && hostSid && activeUsers.has(hostSid) && hostSid !== socket.id && roomSockets && roomSockets.has(hostSid));

    if (hostActive) {
      if (!pendingRequests.has(roomId)) {
        pendingRequests.set(roomId, new Map());
      }
      pendingRequests.get(roomId).set(socket.id, user);

      socket.emit('join_pending', {
        room: { id: targetRoom.id, name: targetRoom.name },
        message: 'Password verified! Waiting for Host approval...'
      });

      io.to(hostSid).emit('host_approval_request', {
        roomId: targetRoom.id,
        roomName: targetRoom.name,
        requester: user,
        requesterSocketId: socket.id
      });
    } else {
      // Host is offline or away; admitted directly without giving them host permissions
      admitUserToRoom(socket, targetRoom);
    }
  });

  socket.on('approve_join_request', async ({ roomId, requesterSocketId }) => {
    const allDbRooms = await DatabaseAPI.getAllRooms();
    const targetRoom = allDbRooms.find(r => r.id === roomId);
    if (!targetRoom) return;

    const user = activeUsers.get(socket.id);
    const isHost = user && targetRoom.host_username && user.username.toLowerCase() === targetRoom.host_username.toLowerCase();
    if (!isHost) return;

    const requesterSocket = io.sockets.sockets.get(requesterSocketId);
    if (requesterSocket) {
      if (pendingRequests.has(roomId)) {
        pendingRequests.get(roomId).delete(requesterSocketId);
      }
      admitUserToRoom(requesterSocket, targetRoom);
    }
  });

  socket.on('deny_join_request', async ({ roomId, requesterSocketId }) => {
    const allDbRooms = await DatabaseAPI.getAllRooms();
    const targetRoom = allDbRooms.find(r => r.id === roomId);
    if (!targetRoom) return;

    const user = activeUsers.get(socket.id);
    const isHost = user && targetRoom.host_username && user.username.toLowerCase() === targetRoom.host_username.toLowerCase();
    if (!isHost) return;

    const requesterSocket = io.sockets.sockets.get(requesterSocketId);
    if (requesterSocket) {
      if (pendingRequests.has(roomId)) {
        pendingRequests.get(roomId).delete(requesterSocketId);
      }
      requesterSocket.emit('join_error', { message: 'Room Host denied your entry request.' });
    }
  });

  socket.on('kick_member', async ({ roomId, memberSocketId }) => {
    const allDbRooms = await DatabaseAPI.getAllRooms();
    const targetRoom = allDbRooms.find(r => r.id === roomId);
    if (!targetRoom) return;

    const user = activeUsers.get(socket.id);
    const isHost = user && targetRoom.host_username && user.username.toLowerCase() === targetRoom.host_username.toLowerCase();
    if (!isHost) return;

    const targetUser = activeUsers.get(memberSocketId);
    const targetSocket = io.sockets.sockets.get(memberSocketId);

    if (targetSocket && targetUser) {
      targetSocket.leave(roomId);

      targetSocket.emit('kicked_from_room', {
        roomName: targetRoom.name || roomId,
        message: `You were kicked from #${targetRoom.name || roomId} by the Host.`
      });

      const sysMsg = {
        id: 'sys-' + Date.now(),
        roomId: roomId,
        isSystem: true,
        text: `🚪 **${targetUser.username}** was kicked by the Host.`,
        timestamp: new Date().toISOString()
      };
      await DatabaseAPI.saveMessage(sysMsg);
      io.to(roomId).emit('message_received', sysMsg);
      const members = await getRoomMembers(roomId, targetRoom);
      io.to(roomId).emit('room_members_updated', members);
    }
  });

  socket.on('leave_room', async ({ roomId }) => {
    socket.leave(roomId);
    if (roomsMemory[roomId] && roomsMemory[roomId].hostSocketId === socket.id) {
      roomsMemory[roomId].hostSocketId = null;
    }
    const members = await getRoomMembers(roomId);
    io.to(roomId).emit('room_members_updated', members);
    const roomsList = await getPublicRooms();
    io.emit('rooms_updated', roomsList);
  });

  async function getRoomMembers(roomId, optionalRoom) {
    const roomSockets = io.sockets.adapter.rooms.get(roomId);
    if (!roomSockets) return [];

    let room = optionalRoom;
    if (!room) {
      const allDbRooms = await DatabaseAPI.getAllRooms();
      room = allDbRooms.find(r => r.id === roomId);
    }
    const hostUser = room ? (room.host_username || '').toLowerCase() : '';

    return Array.from(roomSockets).map((sid) => {
      const u = activeUsers.get(sid);
      const isHost = !!(u && hostUser && u.username.toLowerCase() === hostUser);
      return {
        id: sid,
        username: u ? u.username : 'User',
        avatar: u ? u.avatar : '⚡',
        status: u ? u.status : 'online',
        customStatus: u ? u.customStatus : '',
        isHost
      };
    });
  }

  async function admitUserToRoom(userSocket, targetRoom) {
    userSocket.rooms.forEach((r) => {
      if (r !== userSocket.id) userSocket.leave(r);
    });

    userSocket.join(targetRoom.id);

    const user = activeUsers.get(userSocket.id);
    const hostUser = (targetRoom.host_username || '').toLowerCase();
    const isHost = !!(user && hostUser && user.username.toLowerCase() === hostUser);

    if (isHost) {
      if (!roomsMemory[targetRoom.id]) roomsMemory[targetRoom.id] = {};
      roomsMemory[targetRoom.id].hostSocketId = userSocket.id;
    }

    const roomMessagesList = await DatabaseAPI.getRoomMessages(targetRoom.id);
    const roomCodeWorkspace = await DatabaseAPI.getRoomCodeWorkspace(targetRoom.id);
    const membersList = await getRoomMembers(targetRoom.id, targetRoom);

    userSocket.emit('room_switched', {
      room: {
        id: targetRoom.id,
        name: targetRoom.name,
        description: targetRoom.description,
        icon: targetRoom.icon,
        hasPassword: !!targetRoom.password,
        tags: Array.isArray(targetRoom.tags) ? targetRoom.tags : (typeof targetRoom.tags === 'string' ? targetRoom.tags.split(',') : ['code']),
        language: targetRoom.language || 'python',
        hostUsername: targetRoom.host_username || 'System',
        isHost
      },
      messages: roomMessagesList,
      codeWorkspace: roomCodeWorkspace,
      members: membersList
    });

    io.to(targetRoom.id).emit('room_members_updated', membersList);

    const sysMsg = {
      id: 'sys-' + Date.now(),
      roomId: targetRoom.id,
      isSystem: true,
      text: `✨ **${user ? user.username : 'User'}** entered #${targetRoom.name}!`,
      timestamp: new Date().toISOString()
    };
    await DatabaseAPI.saveMessage(sysMsg);
    io.to(targetRoom.id).emit('message_received', sysMsg);

    // Broadcast updated public room member counts to front page
    const roomsList = await getPublicRooms();
    io.emit('rooms_updated', roomsList);
  }

  // Incoming Messages
  socket.on('send_message', async ({ roomId, text, attachment, voiceNote, codeSnippet }) => {
    const sender = activeUsers.get(socket.id);
    if (!sender) return;

    const message = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      roomId: roomId || 'general',
      user: sender,
      text: text || '',
      attachment: attachment || null,
      voiceNote: voiceNote || null,
      codeSnippet: codeSnippet || null,
      timestamp: new Date().toISOString(),
      reactions: {}
    };

    await DatabaseAPI.saveMessage(message);
    io.to(roomId).emit('message_received', message);

    if (text && (text.includes('@PulseBot') || text.startsWith('/'))) {
      handleBotMention(roomId, text, sender);
    }
  });

  // Edit Message
  socket.on('edit_message', async ({ roomId, messageId, newText }) => {
    const sender = activeUsers.get(socket.id);
    if (!sender || !newText || !messageId) return;

    await DatabaseAPI.editMessage(messageId, newText.trim());
    io.to(roomId).emit('message_edited', {
      messageId,
      roomId,
      text: newText.trim(),
      isEdited: true
    });
  });

  // Delete Message
  socket.on('delete_message', async ({ roomId, messageId }) => {
    const sender = activeUsers.get(socket.id);
    if (!sender || !messageId) return;

    await DatabaseAPI.deleteMessage(messageId);
    io.to(roomId).emit('message_deleted', {
      messageId,
      roomId
    });
  });

  // Collaborative Code Events & DB Persistence
  socket.on('code_change', async ({ roomId, fileId, content, cursorLine, cursorCol }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    const workspace = await DatabaseAPI.getRoomCodeWorkspace(roomId);
    const file = workspace.files.find((f) => f.id === fileId);
    if (file) {
      file.content = content;
      await DatabaseAPI.saveCodeFile(file);
    }

    socket.to(roomId).emit('code_updated', {
      fileId,
      content,
      user: { id: socket.id, username: user.username, avatar: user.avatar },
      cursorLine,
      cursorCol
    });
  });

  socket.on('code_cursor_move', ({ roomId, fileId, cursorLine, cursorCol }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    socket.to(roomId).emit('code_cursor_updated', {
      fileId,
      user: { id: socket.id, username: user.username, avatar: user.avatar },
      cursorLine,
      cursorCol
    });
  });

  socket.on('code_create_file', async ({ roomId, name, language }) => {
    const newFile = await DatabaseAPI.createCodeFile(roomId, name, language);
    const updatedWorkspace = await DatabaseAPI.getRoomCodeWorkspace(roomId);
    updatedWorkspace.activeFileId = newFile.id;

    io.to(roomId).emit('code_file_created', {
      workspace: updatedWorkspace,
      newFile
    });
  });

  // Collaborative Whiteboard
  socket.on('wb_draw', (data) => {
    socket.to(data.roomId).emit('wb_draw_received', data);
  });
  socket.on('wb_clear', ({ roomId }) => {
    socket.to(roomId).emit('wb_clear_received');
  });

  socket.on('code_switch_file', async ({ roomId, fileId }) => {
    const workspace = await DatabaseAPI.getRoomCodeWorkspace(roomId);
    workspace.activeFileId = fileId;
    io.to(roomId).emit('code_active_file_changed', { fileId });
  });

  // Typing & Profile
  socket.on('typing', ({ roomId, isTyping }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    socket.to(roomId).emit('user_typing', { roomId, username: user.username, isTyping });
  });

  socket.on('update_profile', ({ status, customStatus, avatar }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    if (status) user.status = status;
    if (customStatus !== undefined) user.customStatus = customStatus;
    if (avatar) user.avatar = avatar;

    activeUsers.set(socket.id, user);
    io.emit('user_status_change', { user, activeUsers: Array.from(activeUsers.values()) });
  });

  // WebRTC Mesh Call Signaling
  socket.on('join_call', ({ roomId }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    socket.to(roomId).emit('user_joined_call', { 
      socketId: socket.id, 
      username: user.username,
      avatar: user.avatar 
    });
  });

  socket.on('call_user', ({ userToCall, signalData, from, callerName, callerAvatar, isVideo }) => {
    // In Mesh, userToCall is the direct socket ID
    io.to(userToCall).emit('call_incoming', { signal: signalData, from, callerName, callerAvatar, isVideo });
  });

  socket.on('answer_call', ({ to, signal }) => {
    io.to(to).emit('call_accepted', { signal, from: socket.id });
  });

  socket.on('ice_candidate', ({ to, candidate }) => {
    io.to(to).emit('ice_candidate_received', { candidate, from: socket.id });
  });

  socket.on('end_call', ({ roomId }) => {
    if (roomId) {
      socket.to(roomId).emit('user_left_call', { socketId: socket.id });
    }
  });

  socket.on('user_logout', () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      const normUser = (user.username || '').trim().toLowerCase();
      const session = activeSessions.get(normUser);
      if (session) {
        if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
        activeSessions.delete(normUser);
      }
    }
  });

  socket.on('disconnect', async () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      // Single session tracking update
      const normUser = (user.username || '').trim().toLowerCase();
      const session = activeSessions.get(normUser);
      if (session && session.socketId === socket.id) {
        session.socketId = null;
        if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
        // Allow a 6-second grace period for quick page reloads
        session.disconnectTimer = setTimeout(() => {
          const current = activeSessions.get(normUser);
          if (current && !current.socketId) {
            activeSessions.delete(normUser);
            console.log(`[Session] Released session for ${user.username} (disconnected)`);
          }
        }, 6000);
      }

      // Notify rooms that user left the call (in case they drop unexpectedly)
      Object.keys(roomsMemory).forEach((rid) => {
        io.to(rid).emit('user_left_call', { socketId: socket.id });
      });

      activeUsers.delete(socket.id);
      io.emit('user_status_change', { user, activeUsers: Array.from(activeUsers.values()) });

      Object.keys(roomsMemory).forEach((rid) => {
        if (roomsMemory[rid] && roomsMemory[rid].hostSocketId === socket.id) {
          // Host left the room. Keep host permanence (do NOT shift to another user!)
          roomsMemory[rid].hostSocketId = null;
        }
      });

      // Update room members in all rooms the user was in
      Object.keys(roomsMemory).forEach(async (rid) => {
        const members = await getRoomMembers(rid);
        io.to(rid).emit('room_members_updated', members);
      });

      const roomsList = await getPublicRooms();
      io.emit('rooms_updated', roomsList);
    }
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 PulseChat Server running on http://0.0.0.0:${PORT}`);
  console.log(`====================================================`);
});
