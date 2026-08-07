/**
 * PulseChat Core Application Controller
 */
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // ─── State ─────────────────────────────────────────────────────────────────
  let currentUser = {
    username: 'Guest_' + Math.floor(Math.random() * 8999 + 1000),
    avatar: ['⚡', '🔥', '🚀', '🔮', '👾', '🦊'][Math.floor(Math.random() * 6)],
    status: 'online',
    customStatus: 'Coding live with group'
  };

  let currentRoom = { id: 'general', name: 'general', icon: '💬', description: 'Global hangout space' };
  let activeRoomsList = [];
  let pendingApprovalQueue = [];
  let isHostOfRoom = false;
  let typingTimeout = null;

  const voiceRecorder = new window.VoiceRecorder();
  const mediaCallManager = new window.MediaCallManager(socket);
  const codeStudio = new window.CollaborativeCodeStudio(socket);

  // ─── DOM References ────────────────────────────────────────────────────────
  const elMainView = document.getElementById('chat-main-view');
  const elStudioView = document.getElementById('code-studio-view');
  const btnModeChat = document.getElementById('btn-mode-chat');
  const btnModeCode = document.getElementById('btn-mode-code');
  const btnStudioBackChat = document.getElementById('studio-btn-back-chat');

  const elTimeline = document.getElementById('chat-timeline');
  const elTextarea = document.getElementById('chat-textarea');
  const elSendBtn = document.getElementById('btn-send-msg');
  const elChannelList = document.getElementById('channel-list');
  const elUserList = document.getElementById('user-list');
  const elUserCount = document.getElementById('user-count');
  const elRoomMemberList = document.getElementById('room-member-list');
  const elRoomMemberCount = document.getElementById('room-member-count');
  const elTypingBar = document.getElementById('typing-bar');
  const elTypingText = document.getElementById('typing-users-text');

  const elCurrentAvatar = document.getElementById('current-user-avatar');
  const elCurrentUsername = document.getElementById('current-username');
  const elCurrentStatusText = document.getElementById('current-status-text');

  const elRoomIcon = document.getElementById('active-room-icon');
  const elRoomTitle = document.getElementById('active-room-title');
  const elRoomDesc = document.getElementById('active-room-desc');

  // Modals
  const modalWelcomePortal = document.getElementById('modal-welcome-portal');
  const modalHostApproval = document.getElementById('modal-host-approval');
  const modalWaitingRoom = document.getElementById('modal-waiting-room');
  const modalCreateRoom = document.getElementById('modal-create-room');
  const modalEditProfile = document.getElementById('modal-edit-profile');

  const elPortalUsername = document.getElementById('portal-username');
  const elPortalRoomName = document.getElementById('portal-room-name');
  const elPortalRoomPass = document.getElementById('portal-room-password');
  // Support both old and new HTML ID
  const elPortalError = document.getElementById('portal-error-msg') || document.getElementById('portal-error');

  const showPortalError = (msg) => {
    if (!elPortalError) return;
    elPortalError.style.display = 'block';
    elPortalError.innerText = msg;
  };
  const hidePortalError = () => {
    if (!elPortalError) return;
    elPortalError.style.display = 'none';
  };

  // ─── Sound Effects ─────────────────────────────────────────────────────────
  const playSoundEffect = (type = 'message') => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'message') {
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.15);
      } else if (type === 'alert') {
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1174.66, audioCtx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.25);
      }
    } catch (e) {}
  };

  // ─── View Switcher ─────────────────────────────────────────────────────────
  const switchViewMode = (mode) => {
    if (mode === 'code') {
      elMainView.style.display = 'none';
      elStudioView.classList.add('active');
      btnModeChat.classList.remove('active');
      btnModeCode.classList.add('active');
    } else {
      elMainView.style.display = 'flex';
      elStudioView.classList.remove('active');
      btnModeCode.classList.remove('active');
      btnModeChat.classList.add('active');
    }
  };

  btnModeChat?.addEventListener('click', () => switchViewMode('chat'));
  btnModeCode?.addEventListener('click', () => switchViewMode('code'));
  btnStudioBackChat?.addEventListener('click', () => switchViewMode('chat'));

  // ─── Welcome Portal ────────────────────────────────────────────────────────
  document.getElementById('portal-btn-enter-room')?.addEventListener('click', () => {
    const name = elPortalUsername.value.trim();
    const roomName = (elPortalRoomName.value.trim().toLowerCase()) || 'general';
    const password = elPortalRoomPass.value.trim();

    if (!name) {
      showPortalError('⚠️ Please enter your display name!');
      return;
    }

    currentUser.username = name;
    hidePortalError();

    // Store room details to use after user is registered (init_payload)
    socket._pendingRoomId = roomName.replace(/[^a-z0-9]/g, '-');
    socket._pendingPassword = password;

    // Register user first — room join is sent once we get init_payload confirmation
    socket.emit('user_join', currentUser);
  });

  document.getElementById('portal-btn-create-mode')?.addEventListener('click', () => {
    const name = elPortalUsername.value.trim();
    if (!name) {
      showPortalError('⚠️ Enter your display name first!');
      return;
    }
    currentUser.username = name;
    // Register user with server, then open create-room modal on init_payload
    socket._openCreateRoomOnInit = true;
    socket.emit('user_join', currentUser);
    modalWelcomePortal.classList.remove('active');
  });

  // ─── Socket Events ─────────────────────────────────────────────────────────
  socket.on('connect', () => {
    console.log('[PulseChat] Connected:', socket.id);
  });

  socket.on('init_payload', (data) => {
    socket._registered = true;
    currentUser = data.user;
    activeRoomsList = data.rooms;
    updateUserProfileUI();
    renderChannelsList(data.rooms);
    renderActiveUsersList(data.activeUsers);

    // Pending: join a room (from Enter Room button)
    if (socket._pendingRoomId) {
      socket.emit('request_join_room', {
        roomId: socket._pendingRoomId,
        password: socket._pendingPassword || ''
      });
      socket._pendingRoomId = null;
      socket._pendingPassword = null;
    }

    // Pending: open Create Room modal (from Create New Room button)
    if (socket._openCreateRoomOnInit) {
      socket._openCreateRoomOnInit = false;
      modalCreateRoom.classList.add('active');
    }

    // Pending: create a specific room (from Create & Become Host button before registration)
    if (socket._pendingCreateRoom) {
      const cr = socket._pendingCreateRoom;
      socket._pendingCreateRoom = null;
      socket.emit('create_room', cr);
    }
  });

  socket.on('join_error', ({ message }) => {
    modalWaitingRoom.classList.remove('active');
    if (modalWelcomePortal.classList.contains('active') || !currentRoom.id) {
      modalWelcomePortal.classList.add('active');
      elPortalError.style.display = 'block';
      elPortalError.style.color = 'var(--status-dnd)';
      elPortalError.innerText = '⚠️ ' + message;
    } else {
      // Show as a toast inside the app
      showToast('⚠️ ' + message, 'error');
    }
  });

  socket.on('join_pending', ({ message }) => {
    modalWelcomePortal.classList.remove('active');
    modalWaitingRoom.classList.add('active');
    document.getElementById('waiting-room-msg').innerText = message;
  });

  // HOST: Approval popup (shown only on host's tab)
  socket.on('host_approval_request', ({ roomId, roomName, requester, requesterSocketId }) => {
    pendingApprovalQueue.push({ roomId, requesterSocketId, name: requester.username, room: roomName });
    showNextApprovalRequest();
  });

  const showNextApprovalRequest = () => {
    if (pendingApprovalQueue.length === 0) {
      modalHostApproval.classList.remove('active');
      return;
    }
    const next = pendingApprovalQueue[0];
    document.getElementById('host-req-name').innerText = next.name;
    document.getElementById('host-req-room').innerText = '#' + next.room;
    modalHostApproval.classList.add('active');
    playSoundEffect('alert');
  };

  document.getElementById('btn-host-approve')?.addEventListener('click', () => {
    const req = pendingApprovalQueue.shift();
    if (req) socket.emit('approve_join_request', { roomId: req.roomId, requesterSocketId: req.requesterSocketId });
    showNextApprovalRequest();
  });

  document.getElementById('btn-host-deny')?.addEventListener('click', () => {
    const req = pendingApprovalQueue.shift();
    if (req) socket.emit('deny_join_request', { roomId: req.roomId, requesterSocketId: req.requesterSocketId });
    showNextApprovalRequest();
  });

  // Kicked from room — sent back to welcome portal
  socket.on('kicked_from_room', ({ message }) => {
    currentRoom = { id: 'general', name: 'general', icon: '💬' };
    isHostOfRoom = false;
    modalWelcomePortal.classList.add('active');
    elPortalError.style.display = 'block';
    elPortalError.style.color = 'var(--status-dnd)';
    elPortalError.innerText = '🚪 ' + message;
  });

  socket.on('room_switched', ({ room, messages, codeWorkspace, members }) => {
    modalWelcomePortal.classList.remove('active');
    modalWaitingRoom.classList.remove('active');
    modalCreateRoom.classList.remove('active');

    currentRoom = room;
    isHostOfRoom = !!room.isHost;

    elRoomIcon.innerText = room.icon || '💬';
    elRoomTitle.innerText = '#' + room.name + (room.isHost ? '  👑 Host' : '');
    elRoomDesc.innerText = room.description || '';

    renderChannelsList(activeRoomsList);
    renderMessages(messages || []);
    renderRoomMembers(members || []);

    if (codeWorkspace) {
      codeStudio.loadWorkspace(codeWorkspace, room.id);
    }
  });

  socket.on('room_members_updated', (members) => {
    renderRoomMembers(members || []);
  });

  socket.on('rooms_updated', (rooms) => {
    activeRoomsList = rooms;
    renderChannelsList(rooms);
  });

  socket.on('message_received', (msg) => {
    if (msg.roomId === currentRoom.id) {
      appendSingleMessage(msg);
      scrollToBottom();
      if (!msg.isSystem && msg.user && msg.user.id !== socket.id) {
        playSoundEffect('message');
      }
    }
  });

  socket.on('reaction_updated', ({ messageId, roomId, reactions }) => {
    if (roomId === currentRoom.id) {
      const msgCard = document.querySelector(`[data-message-id="${messageId}"]`);
      if (msgCard) {
        const reactionsRow = msgCard.querySelector('.reactions-row');
        if (reactionsRow) reactionsRow.innerHTML = renderReactionsHTML(messageId, roomId, reactions);
      }
    }
  });

  socket.on('user_typing', ({ roomId, username, isTyping }) => {
    if (roomId === currentRoom.id) {
      if (isTyping) {
        elTypingBar.style.visibility = 'visible';
        elTypingText.innerText = username + ' is typing...';
      } else {
        elTypingBar.style.visibility = 'hidden';
      }
    }
  });

  socket.on('user_status_change', ({ activeUsers }) => {
    renderActiveUsersList(activeUsers);
  });

  // ─── UI Renderers ──────────────────────────────────────────────────────────
  const updateUserProfileUI = () => {
    elCurrentAvatar.innerText = currentUser.avatar || '⚡';
    elCurrentUsername.innerText = currentUser.username || 'User';
    elCurrentStatusText.innerText = currentUser.customStatus || 'Online';
  };

  const renderChannelsList = (rooms) => {
    elChannelList.innerHTML = '';
    rooms.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'channel-item' + (r.id === currentRoom.id ? ' active' : '');
      li.innerHTML = `
        <span class="channel-icon">${r.icon || '💬'}</span>
        <span class="channel-name">#${r.name}</span>
        ${r.hasPassword ? '<span style="font-size:11px;" title="Password protected">🔒</span>' : ''}
      `;
      li.addEventListener('click', () => {
        if (r.id === currentRoom.id) return;
        let pass = '';
        if (r.hasPassword) {
          pass = prompt('🔒 Enter password for #' + r.name + ':') || '';
          if (pass === null) return; // cancelled
        }
        socket.emit('request_join_room', { roomId: r.id, password: pass });
      });
      elChannelList.appendChild(li);
    });
  };

  const renderActiveUsersList = (users) => {
    elUserList.innerHTML = '';
    elUserCount.innerText = users.length;
    users.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="user-avatar-container" style="width:32px;height:32px;">
          <div class="user-avatar" style="font-size:16px;">${u.avatar || '⚡'}</div>
          <div class="status-dot ${u.status || 'online'}"></div>
        </div>
        <div style="min-width:0;flex:1;">
          <div class="user-name" style="font-size:0.85rem;">${u.username}${u.isBot ? ' <span class="bot-tag">BOT</span>' : ''}</div>
          <div class="user-status-text" style="font-size:0.7rem;">${u.customStatus || 'Online'}</div>
        </div>
      `;
      elUserList.appendChild(li);
    });
  };

  const renderRoomMembers = (members) => {
    if (!elRoomMemberList) return;
    elRoomMemberList.innerHTML = '';
    if (elRoomMemberCount) elRoomMemberCount.innerText = members.length;

    members.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'user-item';
      const isSelf = m.id === socket.id;
      const canKick = isHostOfRoom && !isSelf && !m.isHost;

      li.innerHTML = `
        <div class="user-avatar-container" style="width:28px;height:28px;">
          <div class="user-avatar" style="font-size:14px;">${m.avatar || '⚡'}</div>
          <div class="status-dot online"></div>
        </div>
        <div style="min-width:0;flex:1;">
          <div class="user-name" style="font-size:0.82rem;">
            ${m.username}
            ${m.isHost ? '<span style="font-size:10px;background:rgba(251,191,36,0.2);color:#fbbf24;padding:1px 5px;border-radius:4px;margin-left:4px;">👑</span>' : ''}
            ${isSelf ? '<span style="font-size:10px;color:var(--text-muted);"> (you)</span>' : ''}
          </div>
        </div>
        ${canKick ? `<button class="btn-kick" data-mid="${m.id}" title="Kick ${m.username}">🚫</button>` : ''}
      `;

      if (canKick) {
        li.querySelector('.btn-kick').addEventListener('click', (e) => {
          e.stopPropagation();
          const memberId = e.currentTarget.dataset.mid;
          if (confirm('Kick ' + m.username + ' from #' + currentRoom.name + '?')) {
            socket.emit('kick_member', { roomId: currentRoom.id, memberSocketId: memberId });
          }
        });
      }
      elRoomMemberList.appendChild(li);
    });
  };

  const renderMessages = (messages) => {
    elTimeline.innerHTML = '';
    messages.forEach((msg) => appendSingleMessage(msg));
    scrollToBottom();
  };

  const appendSingleMessage = (msg) => {
    if (msg.isSystem) {
      const sysDiv = document.createElement('div');
      sysDiv.className = 'system-event-pill';
      sysDiv.innerHTML = formatMarkdownText(msg.text);
      elTimeline.appendChild(sysDiv);
      return;
    }

    const isSelf = msg.user && msg.user.id === socket.id;
    const card = document.createElement('div');
    card.className = 'message-card' + (isSelf ? ' self' : '');
    card.setAttribute('data-message-id', msg.id);

    const formattedTime = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let mediaHTML = '';
    if (msg.attachment) {
      if (msg.attachment.mimetype && msg.attachment.mimetype.startsWith('image/')) {
        mediaHTML = `<img src="${msg.attachment.url}" class="message-image-embed" alt="Attachment" onclick="window.open('${msg.attachment.url}','_blank')">`;
      } else {
        mediaHTML = `<div style="margin-top:8px;"><a href="${msg.attachment.url}" target="_blank" style="color:var(--accent-cyan);text-decoration:underline;">📎 ${msg.attachment.filename} (${Math.round(msg.attachment.size / 1024)} KB)</a></div>`;
      }
    }

    if (msg.voiceNote) {
      mediaHTML += `
        <div class="voice-note-player">
          <button class="btn-play-voice" onclick="new Audio('${msg.voiceNote.url}').play()">▶</button>
          <span style="font-size:0.8rem;color:var(--text-muted);">Voice Note (${msg.voiceNote.duration}s)</span>
        </div>
      `;
    }

    if (msg.codeSnippet) {
      const escaped = escapeHTML(msg.codeSnippet.code);
      mediaHTML += `
        <div class="code-snippet-box">
          <div class="code-header">
            <span>${msg.codeSnippet.language || 'code'}</span>
            <button style="background:transparent;border:none;color:var(--accent-cyan);cursor:pointer;" onclick="navigator.clipboard.writeText(this.closest('.code-snippet-box').querySelector('.code-content').innerText)">Copy</button>
          </div>
          <div class="code-content">${escaped}</div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="message-avatar">${msg.user ? msg.user.avatar : '⚡'}</div>
      <div class="message-content-wrapper">
        <div class="message-meta">
          <span class="message-author">${msg.user ? msg.user.username : 'User'}</span>
          ${msg.user && msg.user.isBot ? '<span class="bot-tag">BOT</span>' : ''}
          <span class="message-timestamp">${formattedTime}</span>
          <button class="btn-add-reaction" onclick="window.toggleEmojiPopForMessage('${msg.id}')">➕</button>
        </div>
        <div class="message-bubble">
          ${msg.text ? formatMarkdownText(msg.text) : ''}
          ${mediaHTML}
        </div>
        <div class="reactions-row">
          ${renderReactionsHTML(msg.id, msg.roomId, msg.reactions)}
        </div>
      </div>
    `;

    elTimeline.appendChild(card);
  };

  const renderReactionsHTML = (messageId, roomId, reactions = {}) => {
    let html = '';
    Object.entries(reactions).forEach(([emoji, usersArr]) => {
      if (usersArr && usersArr.length > 0) {
        const hasReacted = usersArr.includes(currentUser.username);
        html += `<span class="reaction-pill ${hasReacted ? 'active' : ''}" onclick="window.toggleReaction('${messageId}','${roomId}','${emoji}')">${emoji} ${usersArr.length}</span>`;
      }
    });
    return html;
  };

  const scrollToBottom = () => { elTimeline.scrollTop = elTimeline.scrollHeight; };

  const escapeHTML = (str) => str.replace(/[&<>'"]/g, (t) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t] || t));

  const formatMarkdownText = (text) => {
    let f = escapeHTML(text);
    f = f.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    f = f.replace(/\*(.*?)\*/g, '<em>$1</em>');
    f = f.replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;font-family:var(--font-code);font-size:0.85rem;">$1</code>');
    return f;
  };

  // Simple toast notification
  const showToast = (message, type = 'info') => {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed;bottom:80px;right:24px;z-index:9999;
      background:${type === 'error' ? 'rgba(239,68,68,0.9)' : 'rgba(99,102,241,0.9)'};
      color:#fff;padding:12px 20px;border-radius:12px;font-size:0.9rem;
      box-shadow:0 8px 24px rgba(0,0,0,0.4);backdrop-filter:blur(12px);
      animation:fadeInUp 0.3s ease;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  };

  // ─── Global helpers ────────────────────────────────────────────────────────
  window.toggleReaction = (messageId, roomId, emoji) => {
    socket.emit('toggle_reaction', { messageId, roomId, emoji });
  };

  window.toggleEmojiPopForMessage = (messageId) => {
    const emojis = ['❤️', '🔥', '👍', '😂', '🚀', '🎉'];
    const chosen = emojis[Math.floor(Math.random() * emojis.length)];
    socket.emit('toggle_reaction', { messageId, roomId: currentRoom.id, emoji: chosen });
  };

  // ─── Message Input ─────────────────────────────────────────────────────────
  const sendMessageHandler = () => {
    const text = elTextarea.value.trim();
    if (!text) return;
    socket.emit('send_message', { roomId: currentRoom.id, text });
    elTextarea.value = '';
    elTextarea.style.height = 'auto';
    socket.emit('typing', { roomId: currentRoom.id, isTyping: false });
  };

  elSendBtn.addEventListener('click', sendMessageHandler);

  elTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessageHandler();
    }
  });

  elTextarea.addEventListener('input', () => {
    elTextarea.style.height = 'auto';
    elTextarea.style.height = Math.min(elTextarea.scrollHeight, 120) + 'px';
    socket.emit('typing', { roomId: currentRoom.id, isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('typing', { roomId: currentRoom.id, isTyping: false });
    }, 1500);
  });

  // ─── Voice Notes ───────────────────────────────────────────────────────────
  document.getElementById('btn-record-voice').addEventListener('click', async () => {
    document.getElementById('input-container').style.display = 'none';
    document.getElementById('voice-recording-dock').classList.add('active');
    await voiceRecorder.startRecording(
      document.getElementById('waveform-canvas'),
      document.getElementById('recording-timer')
    );
  });

  document.getElementById('btn-cancel-voice').addEventListener('click', () => {
    voiceRecorder.cancelRecording();
    document.getElementById('voice-recording-dock').classList.remove('active');
    document.getElementById('input-container').style.display = 'flex';
  });

  document.getElementById('btn-send-voice').addEventListener('click', async () => {
    const result = await voiceRecorder.stopRecording();
    document.getElementById('voice-recording-dock').classList.remove('active');
    document.getElementById('input-container').style.display = 'flex';

    if (result && result.blob) {
      const formData = new FormData();
      formData.append('file', result.blob, 'voice-note.webm');
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        socket.emit('send_message', {
          roomId: currentRoom.id,
          text: '',
          voiceNote: { url: data.url, duration: result.duration || 3 }
        });
      } catch (err) {
        console.error('Audio upload failed:', err);
      }
    }
  });

  // ─── File Upload ───────────────────────────────────────────────────────────
  document.getElementById('btn-attach-file').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  document.getElementById('file-input').addEventListener('change', async () => {
    const fileInput = document.getElementById('file-input');
    if (!fileInput.files || fileInput.files.length === 0) return;
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      socket.emit('send_message', {
        roomId: currentRoom.id,
        text: 'Shared file: **' + file.name + '**',
        attachment: data
      });
      fileInput.value = '';
    } catch (err) {
      console.error('File upload failed:', err);
    }
  });

  // ─── Create Room Modal ─────────────────────────────────────────────────────
  document.getElementById('btn-create-room-modal').addEventListener('click', () => {
    modalCreateRoom.classList.add('active');
  });

  document.getElementById('btn-close-room-modal').addEventListener('click', () => {
    modalCreateRoom.classList.remove('active');
  });

  document.getElementById('btn-confirm-create-room').addEventListener('click', () => {
    const name = document.getElementById('input-room-name').value.trim();
    const password = document.getElementById('input-room-passcode').value.trim();
    const icon = document.getElementById('input-room-icon').value.trim() || '🔒';
    const description = document.getElementById('input-room-desc').value.trim();

    if (!name) {
      alert('Please enter a room name!');
      return;
    }

    const roomPayload = { name, password, icon, description };

    if (socket._registered) {
      // User is already registered — create room immediately
      socket.emit('create_room', roomPayload);
    } else {
      // Not registered yet — register first, create room on init_payload
      const displayName = elPortalUsername ? elPortalUsername.value.trim() : currentUser.username;
      if (displayName) currentUser.username = displayName;
      socket._pendingCreateRoom = roomPayload;
      socket.emit('user_join', currentUser);
    }

    modalCreateRoom.classList.remove('active');
    document.getElementById('input-room-name').value = '';
    document.getElementById('input-room-passcode').value = '';
  });



  // ─── Edit Profile Modal ────────────────────────────────────────────────────
  document.getElementById('btn-edit-profile').addEventListener('click', () => {
    document.getElementById('input-profile-username').value = currentUser.username;
    document.getElementById('input-profile-avatar').value = currentUser.avatar;
    document.getElementById('input-profile-status').value = currentUser.customStatus;
    modalEditProfile.classList.add('active');
  });

  document.getElementById('btn-close-profile-modal').addEventListener('click', () => {
    modalEditProfile.classList.remove('active');
  });

  document.getElementById('btn-save-profile').addEventListener('click', () => {
    const newUsername = document.getElementById('input-profile-username').value.trim();
    const newAvatar = document.getElementById('input-profile-avatar').value.trim() || '⚡';
    const newStatus = document.getElementById('input-profile-status').value.trim();

    if (newUsername) {
      currentUser.username = newUsername;
      currentUser.avatar = newAvatar;
      currentUser.customStatus = newStatus;
      socket.emit('update_profile', { status: 'online', customStatus: newStatus, avatar: newAvatar });
      updateUserProfileUI();
    }
    modalEditProfile.classList.remove('active');
  });

  // ─── Clear chat button ─────────────────────────────────────────────────────
  document.getElementById('btn-clear-chat')?.addEventListener('click', () => {
    elTimeline.innerHTML = '';
  });

  // ─── Video Call ────────────────────────────────────────────────────────────
  document.getElementById('btn-start-call')?.addEventListener('click', () => {
    mediaCallManager.startCall(currentRoom.id, currentUser);
  });
});

