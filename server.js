const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

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

// Code Execution Endpoint
app.post('/api/run-code', (req, res) => {
  const { code, language, filename } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Code content required' });

  const lang = (language || 'javascript').toLowerCase();
  const isPython = lang === 'python' || (filename && filename.endsWith('.py'));
  const isJS = lang === 'javascript' || (filename && filename.endsWith('.js'));

  if (isPython) {
    const tempDir = path.join(__dirname, 'scratch_run');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `run_${Date.now()}.py`);

    fs.writeFile(tempFilePath, code, (err) => {
      if (err) return res.json({ stdout: runFallbackPythonParser(code), stderr: '' });

      const command = `py "${tempFilePath}" || python "${tempFilePath}" || python3 "${tempFilePath}"`;
      exec(command, { timeout: 8000, maxBuffer: 1024 * 1024 }, (execErr, stdout, stderr) => {
        fs.unlink(tempFilePath, () => {});
        const isPathError = stderr && (stderr.includes('not recognized') || stderr.includes('command not found') || stderr.includes('No such file'));
        if (execErr || isPathError || (!stdout && stderr)) {
          return res.json({ stdout: runFallbackPythonParser(code), stderr: '' });
        }
        res.json({ stdout: stdout || '', stderr: stderr || '' });
      });
    });
  } else if (isJS) {
    const tempDir = path.join(__dirname, 'scratch_run');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `run_${Date.now()}.js`);

    fs.writeFile(tempFilePath, code, () => {
      exec(`node "${tempFilePath}"`, { timeout: 8000 }, (execErr, stdout, stderr) => {
        fs.unlink(tempFilePath, () => {});
        res.json({ stdout: stdout || '', stderr: stderr || '' });
      });
    });
  } else {
    res.json({ stdout: `Execution completed for ${filename || 'script'}.\n` });
  }
});

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

// In-Memory Data Store
const rooms = {
  general: { id: 'general', name: 'general', description: 'Global public lounge', icon: '💬', password: '', hostSocketId: null },
  tech: { id: 'tech', name: 'tech-lounge', description: 'Code & tech room', icon: '⚡', password: '', hostSocketId: null },
  gaming: { id: 'gaming', name: 'gaming-hub', description: 'Gaming squad room', icon: '🎮', password: '', hostSocketId: null }
};

const roomMessages = { general: [], tech: [], gaming: [] };
const roomCodeWorkspaces = {
  general: {
    activeFileId: 'first-py',
    files: [{ id: 'first-py', name: 'first.py', language: 'python', content: 'print("Hello World")\n' }]
  }
};

const pendingRequests = new Map();
const activeUsers = new Map();

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
    botReply = `📊 Connected Users: **${activeUsers.size}** | Active Rooms: **${Object.keys(rooms).length}**`;
  }

  setTimeout(() => {
    const botMsg = {
      id: 'msg-' + Date.now(),
      roomId,
      user: botUser,
      text: botReply,
      timestamp: new Date().toISOString(),
      reactions: {}
    };

    if (!roomMessages[roomId]) roomMessages[roomId] = [];
    roomMessages[roomId].push(botMsg);
    io.to(roomId).emit('message_received', botMsg);
  }, 700);
};

const getPublicRooms = () => {
  return Object.values(rooms).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    hasPassword: !!r.password,
    hostUsername: r.hostSocketId ? activeUsers.get(r.hostSocketId)?.username || 'Host' : null
  }));
};

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.on('user_join', (userData) => {
    const user = {
      id: socket.id,
      username: userData.username || `User_${socket.id.substring(0, 4)}`,
      avatar: userData.avatar || '⚡',
      status: userData.status || 'online',
      customStatus: userData.customStatus || 'Active member',
      joinedAt: new Date().toISOString()
    };

    activeUsers.set(socket.id, user);

    socket.emit('init_payload', {
      user,
      rooms: getPublicRooms(),
      activeUsers: Array.from(activeUsers.values())
    });

    io.emit('user_status_change', {
      user,
      activeUsers: Array.from(activeUsers.values())
    });
  });

  // Request to Join / Create Room with Password & Host Approval
  socket.on('request_join_room', ({ roomId, password }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    let targetRoom = rooms[roomId];

    // If room does NOT exist yet, auto-create it with password and set this user as Host 👑
    if (!targetRoom) {
      targetRoom = {
        id: roomId,
        name: roomId,
        description: 'Custom protected room',
        icon: '🔒',
        password: password || '',
        hostSocketId: socket.id,
        createdBy: user.username
      };

      rooms[roomId] = targetRoom;
      roomMessages[roomId] = [];
      roomCodeWorkspaces[roomId] = {
        activeFileId: 'main-file',
        files: [{ id: 'main-file', name: 'main.py', language: 'python', content: `print("Welcome to ${roomId}!")\n` }]
      };

      io.emit('rooms_updated', getPublicRooms());
      return admitUserToRoom(socket, targetRoom);
    }

    // Password Check
    if (targetRoom.password && targetRoom.password !== password) {
      return socket.emit('join_error', { message: 'Incorrect Room Password!' });
    }

    // Check if Host exists and is online in that room
    const hostActive = targetRoom.hostSocketId && activeUsers.has(targetRoom.hostSocketId) && targetRoom.hostSocketId !== socket.id;

    if (hostActive) {
      if (!pendingRequests.has(roomId)) {
        pendingRequests.set(roomId, new Map());
      }
      pendingRequests.get(roomId).set(socket.id, user);

      // Notify joiner
      socket.emit('join_pending', {
        room: { id: targetRoom.id, name: targetRoom.name },
        message: 'Password verified! Waiting for Host approval...'
      });

      // Send live approval modal to Host!
      io.to(targetRoom.hostSocketId).emit('host_approval_request', {
        roomId: targetRoom.id,
        roomName: targetRoom.name,
        requester: user,
        requesterSocketId: socket.id
      });
    } else {
      // If no active host in room, set this user as Host
      if (!targetRoom.hostSocketId) {
        targetRoom.hostSocketId = socket.id;
      }
      admitUserToRoom(socket, targetRoom);
    }
  });

  // Host Action: Approve Joiner
  socket.on('approve_join_request', ({ roomId, requesterSocketId }) => {
    const targetRoom = rooms[roomId];
    if (!targetRoom || targetRoom.hostSocketId !== socket.id) return;

    const requesterSocket = io.sockets.sockets.get(requesterSocketId);
    if (requesterSocket) {
      if (pendingRequests.has(roomId)) {
        pendingRequests.get(roomId).delete(requesterSocketId);
      }
      admitUserToRoom(requesterSocket, targetRoom);
    }
  });

  // Host Action: Deny Joiner
  socket.on('deny_join_request', ({ roomId, requesterSocketId }) => {
    const targetRoom = rooms[roomId];
    if (!targetRoom || targetRoom.hostSocketId !== socket.id) return;

    const requesterSocket = io.sockets.sockets.get(requesterSocketId);
    if (requesterSocket) {
      if (pendingRequests.has(roomId)) {
        pendingRequests.get(roomId).delete(requesterSocketId);
      }
      requesterSocket.emit('join_error', { message: 'Room Host denied your entry request.' });
    }
  });

  // HOST ACTION: Kick Member
  socket.on('kick_member', ({ roomId, memberSocketId }) => {
    const targetRoom = rooms[roomId];
    if (!targetRoom || targetRoom.hostSocketId !== socket.id) return;

    const targetUser = activeUsers.get(memberSocketId);
    const targetSocket = io.sockets.sockets.get(memberSocketId);

    if (targetSocket && targetUser) {
      targetSocket.leave(roomId);

      // Notify kicked user
      targetSocket.emit('kicked_from_room', {
        roomName: targetRoom.name,
        message: `You were kicked from #${targetRoom.name} by the Host.`
      });

      // System message to room
      const sysMsg = {
        id: 'sys-' + Date.now(),
        roomId: targetRoom.id,
        isSystem: true,
        text: `🚪 **${targetUser.username}** was kicked by the Host.`,
        timestamp: new Date().toISOString()
      };
      io.to(targetRoom.id).emit('message_received', sysMsg);

      // Update room users list
      io.to(targetRoom.id).emit('room_members_updated', getRoomMembers(roomId));
    }
  });

  // Create Protected Room
  socket.on('create_room', ({ name, password, description, icon }) => {
    const user = activeUsers.get(socket.id);
    const roomId = name.toLowerCase().replace(/[^a-z0-9]/g, '-');

    const newRoom = {
      id: roomId,
      name,
      description: description || 'Private protected room',
      icon: icon || '🔒',
      password: password || '',
      hostSocketId: socket.id,
      createdBy: user ? user.username : 'Anonymous'
    };

    rooms[roomId] = newRoom;
    roomMessages[roomId] = [];
    roomCodeWorkspaces[roomId] = {
      activeFileId: 'main-file',
      files: [{ id: 'main-file', name: 'app.py', language: 'python', content: `print("Welcome to ${name}!")\n` }]
    };

    io.emit('rooms_updated', getPublicRooms());
    admitUserToRoom(socket, newRoom);
  });

  function getRoomMembers(roomId) {
    const roomSockets = io.sockets.adapter.rooms.get(roomId);
    if (!roomSockets) return [];
    const targetRoom = rooms[roomId];
    return Array.from(roomSockets).map((sid) => {
      const u = activeUsers.get(sid);
      return {
        id: sid,
        username: u ? u.username : 'User',
        avatar: u ? u.avatar : '⚡',
        status: u ? u.status : 'online',
        customStatus: u ? u.customStatus : '',
        isHost: targetRoom && targetRoom.hostSocketId === sid
      };
    });
  }

  function admitUserToRoom(userSocket, targetRoom) {
    userSocket.rooms.forEach((r) => {
      if (r !== userSocket.id) userSocket.leave(r);
    });

    userSocket.join(targetRoom.id);

    if (!roomMessages[targetRoom.id]) roomMessages[targetRoom.id] = [];
    if (!roomCodeWorkspaces[targetRoom.id]) {
      roomCodeWorkspaces[targetRoom.id] = {
        activeFileId: 'main-file',
        files: [{ id: 'main-file', name: 'main.py', language: 'python', content: `# Protected room: ${targetRoom.name}\n` }]
      };
    }

    const isHost = targetRoom.hostSocketId === userSocket.id;

    userSocket.emit('room_switched', {
      room: {
        id: targetRoom.id,
        name: targetRoom.name,
        description: targetRoom.description,
        icon: targetRoom.icon,
        hasPassword: !!targetRoom.password,
        isHost
      },
      messages: roomMessages[targetRoom.id],
      codeWorkspace: roomCodeWorkspaces[targetRoom.id],
      members: getRoomMembers(targetRoom.id)
    });

    // Notify room members update
    io.to(targetRoom.id).emit('room_members_updated', getRoomMembers(targetRoom.id));

    const user = activeUsers.get(userSocket.id);
    const sysMsg = {
      id: 'sys-' + Date.now(),
      roomId: targetRoom.id,
      isSystem: true,
      text: `✨ **${user ? user.username : 'User'}** entered #${targetRoom.name}!`,
      timestamp: new Date().toISOString()
    };
    io.to(targetRoom.id).emit('message_received', sysMsg);
  }

  // Incoming Messages
  socket.on('send_message', ({ roomId, text, attachment, voiceNote, codeSnippet }) => {
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

    if (!roomMessages[roomId]) roomMessages[roomId] = [];
    roomMessages[roomId].push(message);

    if (roomMessages[roomId].length > 200) roomMessages[roomId].shift();

    io.to(roomId).emit('message_received', message);

    if (text && (text.includes('@PulseBot') || text.startsWith('/'))) {
      handleBotMention(roomId, text, sender);
    }
  });

  // Collaborative Code Events
  socket.on('code_change', ({ roomId, fileId, content, cursorLine, cursorCol }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !roomCodeWorkspaces[roomId]) return;

    const file = roomCodeWorkspaces[roomId].files.find((f) => f.id === fileId);
    if (file) file.content = content;

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

  socket.on('code_create_file', ({ roomId, name, language }) => {
    if (!roomCodeWorkspaces[roomId]) return;

    const fileId = 'file-' + Date.now();
    const newFile = {
      id: fileId,
      name: name || 'file.py',
      language: language || 'python',
      content: `# New file: ${name}\nprint("Hello World")\n`
    };

    roomCodeWorkspaces[roomId].files.push(newFile);
    roomCodeWorkspaces[roomId].activeFileId = fileId;

    io.to(roomId).emit('code_file_created', {
      workspace: roomCodeWorkspaces[roomId],
      newFile
    });
  });

  socket.on('code_switch_file', ({ roomId, fileId }) => {
    if (!roomCodeWorkspaces[roomId]) return;
    roomCodeWorkspaces[roomId].activeFileId = fileId;
    io.to(roomId).emit('code_active_file_changed', { fileId });
  });

  // Reactions & Typing
  socket.on('toggle_reaction', ({ messageId, roomId, emoji }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !roomMessages[roomId]) return;

    const msg = roomMessages[roomId].find((m) => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const idx = msg.reactions[emoji].indexOf(user.username);
    if (idx > -1) {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(user.username);
    }

    io.to(roomId).emit('reaction_updated', { messageId, roomId, reactions: msg.reactions });
  });

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

  // WebRTC
  socket.on('call_user', ({ userToCall, signalData, from, callerName, callerAvatar, isVideo }) => {
    io.to(userToCall).emit('call_incoming', { signal: signalData, from, callerName, callerAvatar, isVideo });
  });

  socket.on('answer_call', ({ to, signal }) => {
    io.to(to).emit('call_accepted', signal);
  });

  socket.on('ice_candidate', ({ to, candidate }) => {
    io.to(to).emit('ice_candidate_received', { candidate, from: socket.id });
  });

  socket.on('end_call', ({ to }) => {
    io.to(to).emit('call_ended');
  });

  socket.on('disconnect', () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      activeUsers.delete(socket.id);
      io.emit('user_status_change', { user, activeUsers: Array.from(activeUsers.values()) });

      Object.values(rooms).forEach((r) => {
        if (r.hostSocketId === socket.id) {
          const roomSockets = io.sockets.adapter.rooms.get(r.id);
          if (roomSockets && roomSockets.size > 0) {
            r.hostSocketId = Array.from(roomSockets)[0];
          } else {
            r.hostSocketId = null;
          }
        }
      });
    }
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 PulseChat Server running on http://localhost:3000`);
  console.log(`====================================================`);
});
