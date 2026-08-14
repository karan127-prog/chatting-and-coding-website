const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const jsonDbPath = path.join(__dirname, 'db_fallback.json');

let sqlite3 = null;
let db = null;
let useJsonFallback = false;

// Initial state for fallback DB
let jsonStore = {
  rooms: {
    general: { id: 'general', name: 'general', description: 'Global public lounge for everyone', icon: '💬', password: '', host_username: 'System', tags: 'general,public', language: 'python', created_at: new Date().toISOString() },
    tech: { id: 'tech', name: 'tech-lounge', description: 'Code, tech & developer discussions', icon: '⚡', password: '', host_username: 'System', tags: 'code,tech,python', language: 'python', created_at: new Date().toISOString() },
    gaming: { id: 'gaming', name: 'gaming-hub', description: 'Gaming squad room & chill space', icon: '🎮', password: '', host_username: 'System', tags: 'gaming,hangout', language: 'javascript', created_at: new Date().toISOString() }
  },
  code_files: [
    { id: 'first-py', room_id: 'general', name: 'main.py', language: 'python', content: '# Welcome to PulseChat VS Code Studio!\nprint("Hello World from Python 3!")\n\nfor i in range(5):\n    print(f"Counting: {i}")\n', updated_at: new Date().toISOString() },
    { id: 'tech-js', room_id: 'tech', name: 'app.js', language: 'javascript', content: '// Tech Lounge JS Workspace\nconsole.log("Welcome to JavaScript Studio!");\nconst techStack = ["Node.js", "Socket.io", "VS Code Engine"];\nconsole.log("Tech Stack:", techStack);\n', updated_at: new Date().toISOString() },
    { id: 'game-html', room_id: 'gaming', name: 'index.html', language: 'html', content: '<!DOCTYPE html>\n<html>\n<head>\n  <style>\n    body { font-family: sans-serif; background: #0f172a; color: #38bdf8; text-align: center; padding: 40px; }\n    h1 { font-size: 2.5rem; text-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }\n  </style>\n</head>\n<body>\n  <h1>🎮 Gaming Hub Preview</h1>\n  <p>Live Web Server Extension Running!</p>\n</body>\n</html>\n', updated_at: new Date().toISOString() }
  ],
  messages: {
    general: [],
    tech: [],
    gaming: []
  },
  user_extensions: {
    'prettier': true,
    'eslint': true,
    'python-runner': true,
    'live-preview': true,
    'ai-copilot': true,
    'theme-pack': true,
    'snippets': true
  }
};

function saveJsonFallback() {
  try {
    fs.writeFileSync(jsonDbPath, JSON.stringify(jsonStore, null, 2));
  } catch (err) {
    console.error('Failed to save JSON database fallback:', err);
  }
}

function loadJsonFallback() {
  if (fs.existsSync(jsonDbPath)) {
    try {
      const data = fs.readFileSync(jsonDbPath, 'utf8');
      jsonStore = JSON.parse(data);
    } catch (err) {
      console.warn('Error reading fallback JSON, using initial state:', err);
    }
  } else {
    saveJsonFallback();
  }
}

function initDB() {
  try {
    sqlite3 = require('sqlite3').verbose();
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.warn('SQLite connection failed, using JSON persistence fallback:', err.message);
        useJsonFallback = true;
        loadJsonFallback();
        return;
      }
      console.log('📦 Connected to SQLite Database successfully!');
      createTables();
    });
  } catch (e) {
    console.warn('sqlite3 package not available, initializing JSON persistence store.');
    useJsonFallback = true;
    loadJsonFallback();
  }
}

function createTables() {
  if (useJsonFallback || !db) return;

  db.serialize(() => {
    // Rooms Table
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      password TEXT,
      host_username TEXT,
      tags TEXT,
      language TEXT,
      created_at TEXT
    )`);

    // Code Files Table
    db.run(`CREATE TABLE IF NOT EXISTS code_files (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      language TEXT NOT NULL,
      content TEXT,
      updated_at TEXT
    )`);

    // Messages Table
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      username TEXT NOT NULL,
      user_avatar TEXT,
      text TEXT,
      attachment TEXT,
      code_snippet TEXT,
      timestamp TEXT
    )`);

    // User Extensions Table
    db.run(`CREATE TABLE IF NOT EXISTS user_extensions (
      extension_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1
    )`);

    // Seed default rooms if empty
    db.get('SELECT count(*) AS count FROM rooms', [], (err, row) => {
      if (!err && row && row.count === 0) {
        console.log('🌱 Seeding initial database rooms...');
        const stmt = db.prepare('INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run('general', 'general', 'Global public lounge for everyone', '💬', '', 'System', 'general,public', 'python', new Date().toISOString());
        stmt.run('tech', 'tech-lounge', 'Code, tech & developer discussions', '⚡', '', 'System', 'code,tech,python', 'python', new Date().toISOString());
        stmt.run('gaming', 'gaming-hub', 'Gaming squad room & chill space', '🎮', '', 'System', 'gaming,hangout', 'javascript', new Date().toISOString());
        stmt.finalize();

        // Seed initial files
        const fileStmt = db.prepare('INSERT INTO code_files VALUES (?, ?, ?, ?, ?, ?)');
        fileStmt.run('first-py', 'general', 'main.py', 'python', '# Welcome to PulseChat VS Code Studio!\nprint("Hello World from Python 3!")\n\nfor i in range(5):\n    print(f"Counting: {i}")\n', new Date().toISOString());
        fileStmt.run('tech-js', 'tech', 'app.js', 'javascript', '// Tech Lounge JS Workspace\nconsole.log("Welcome to JavaScript Studio!");\nconst techStack = ["Node.js", "Socket.io", "VS Code Engine"];\nconsole.log("Tech Stack:", techStack);\n', new Date().toISOString());
        fileStmt.run('game-html', 'gaming', 'index.html', 'html', '<!DOCTYPE html>\n<html>\n<head>\n  <style>\n    body { font-family: sans-serif; background: #0f172a; color: #38bdf8; text-align: center; padding: 40px; }\n    h1 { font-size: 2.5rem; text-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }\n  </style>\n</head>\n<body>\n  <h1>🎮 Gaming Hub Preview</h1>\n  <p>Live Web Server Extension Running!</p>\n</body>\n</html>\n', new Date().toISOString());
        fileStmt.finalize();
      }
    });
  });
}

// Database API Methods
const DatabaseAPI = {
  init: initDB,

  // Rooms
  getAllRooms: () => {
    return new Promise((resolve) => {
      if (useJsonFallback || !db) {
        return resolve(Object.values(jsonStore.rooms));
      }
      db.all('SELECT * FROM rooms ORDER BY created_at DESC', [], (err, rows) => {
        if (err || !rows) resolve(Object.values(jsonStore.rooms));
        else resolve(rows);
      });
    });
  },

  saveRoom: (room) => {
    return new Promise((resolve) => {
      const roomData = {
        id: room.id,
        name: room.name || room.id,
        description: room.description || '',
        icon: room.icon || '🔒',
        password: room.password || '',
        host_username: room.host_username || room.createdBy || 'Host',
        tags: room.tags || 'custom',
        language: room.language || 'python',
        created_at: new Date().toISOString()
      };

      jsonStore.rooms[room.id] = roomData;
      saveJsonFallback();

      if (!useJsonFallback && db) {
        db.run(
          `INSERT OR REPLACE INTO rooms (id, name, description, icon, password, host_username, tags, language, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [roomData.id, roomData.name, roomData.description, roomData.icon, roomData.password, roomData.host_username, roomData.tags, roomData.language, roomData.created_at],
          (err) => resolve(roomData)
        );
      } else {
        resolve(roomData);
      }
    });
  },

  // Code Workspace & Files
  getRoomCodeWorkspace: (roomId) => {
    return new Promise((resolve) => {
      if (useJsonFallback || !db) {
        const files = jsonStore.code_files.filter(f => f.room_id === roomId);
        if (files.length === 0) {
          const defaultFile = {
            id: 'file-' + Date.now(),
            room_id: roomId,
            name: 'main.py',
            language: 'python',
            content: `# Room Workspace: ${roomId}\nprint("Hello World!")\n`,
            updated_at: new Date().toISOString()
          };
          jsonStore.code_files.push(defaultFile);
          saveJsonFallback();
          return resolve({ activeFileId: defaultFile.id, files: [defaultFile] });
        }
        return resolve({ activeFileId: files[0].id, files });
      }

      db.all('SELECT * FROM code_files WHERE room_id = ? ORDER BY updated_at ASC', [roomId], (err, rows) => {
        if (err || !rows || rows.length === 0) {
          const defaultFile = {
            id: 'file-' + Date.now(),
            room_id: roomId,
            name: 'main.py',
            language: 'python',
            content: `# Room Workspace: ${roomId}\nprint("Hello World!")\n`,
            updated_at: new Date().toISOString()
          };
          db.run('INSERT INTO code_files VALUES (?, ?, ?, ?, ?, ?)', [defaultFile.id, roomId, defaultFile.name, defaultFile.language, defaultFile.content, defaultFile.updated_at]);
          return resolve({ activeFileId: defaultFile.id, files: [defaultFile] });
        }
        resolve({ activeFileId: rows[0].id, files: rows });
      });
    });
  },

  saveCodeFile: (file) => {
    return new Promise((resolve) => {
      const idx = jsonStore.code_files.findIndex(f => f.id === file.id);
      if (idx > -1) jsonStore.code_files[idx] = { ...jsonStore.code_files[idx], ...file, updated_at: new Date().toISOString() };
      else jsonStore.code_files.push({ ...file, updated_at: new Date().toISOString() });
      saveJsonFallback();

      if (!useJsonFallback && db) {
        db.run(
          `INSERT OR REPLACE INTO code_files (id, room_id, name, language, content, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [file.id, file.room_id || 'general', file.name, file.language, file.content, new Date().toISOString()],
          () => resolve(true)
        );
      } else {
        resolve(true);
      }
    });
  },

  createCodeFile: (roomId, name, language) => {
    return new Promise((resolve) => {
      const newFile = {
        id: 'file-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
        room_id: roomId,
        name: name || 'file.py',
        language: language || 'python',
        content: `# New File: ${name}\nprint("Welcome to ${name}")\n`,
        updated_at: new Date().toISOString()
      };

      jsonStore.code_files.push(newFile);
      saveJsonFallback();

      if (!useJsonFallback && db) {
        db.run(
          `INSERT INTO code_files VALUES (?, ?, ?, ?, ?, ?)`,
          [newFile.id, newFile.room_id, newFile.name, newFile.language, newFile.content, newFile.updated_at],
          () => resolve(newFile)
        );
      } else {
        resolve(newFile);
      }
    });
  },

  // Messages
  getRoomMessages: (roomId) => {
    return new Promise((resolve) => {
      if (useJsonFallback || !db) {
        return resolve(jsonStore.messages[roomId] || []);
      }
      db.all('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC LIMIT 200', [roomId], (err, rows) => {
        if (err || !rows) resolve(jsonStore.messages[roomId] || []);
        else {
          const parsed = rows.map(r => ({
            ...r,
            user: { username: r.username, avatar: r.user_avatar }
          }));
          resolve(parsed);
        }
      });
    });
  },

  saveMessage: (msg) => {
    return new Promise((resolve) => {
      if (!jsonStore.messages[msg.roomId]) jsonStore.messages[msg.roomId] = [];
      jsonStore.messages[msg.roomId].push(msg);
      if (jsonStore.messages[msg.roomId].length > 200) jsonStore.messages[msg.roomId].shift();
      saveJsonFallback();

      if (!useJsonFallback && db) {
        const username = msg.user ? msg.user.username : (msg.isSystem ? 'System' : 'Anonymous');
        const avatar = msg.user ? (msg.user.avatar || '⚡') : '🤖';

        db.run(
          `INSERT INTO messages (id, room_id, username, user_avatar, text, attachment, code_snippet, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [msg.id, msg.roomId, username, avatar, msg.text || '', JSON.stringify(msg.attachment || null), JSON.stringify(msg.codeSnippet || null), msg.timestamp],
          () => resolve(msg)
        );
      } else {
        resolve(msg);
      }
    });
  }
};

module.exports = DatabaseAPI;
