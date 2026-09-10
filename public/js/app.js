/**
 * PulseChat Core Application Controller
 * Flow: Lobby loads immediately. Name only asked when joining/creating a room.
 */
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Global Theme Customizer
  const themeSelect = document.getElementById('global-theme-select');
  const lobbyThemeToggle = document.getElementById('lobby-theme-toggle');
  const chatThemeToggle = document.getElementById('chat-theme-toggle');
  let currentTheme = localStorage.getItem('pulsechat_theme') || 'aurora';

  const applyTheme = (theme) => {
    currentTheme = theme;
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('pulsechat_theme', theme);
    if (themeSelect) themeSelect.value = theme;
    const isLight = theme === 'light';
    if (lobbyThemeToggle) lobbyThemeToggle.innerHTML = isLight ? '🌙 Dark Theme' : '☀️ Light Theme';
    if (chatThemeToggle) chatThemeToggle.innerHTML = isLight ? '🌙 Dark' : '☀️ Light';

    // Sync active theme chip in profile menu
    document.querySelectorAll('.profile-theme-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.themeId === theme);
    });
  };

  applyTheme(currentTheme);

  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
  }
  const toggleThemeMode = () => {
    const nextTheme = currentTheme === 'light' ? 'aurora' : 'light';
    applyTheme(nextTheme);
  };
  if (lobbyThemeToggle) lobbyThemeToggle.addEventListener('click', toggleThemeMode);
  if (chatThemeToggle) chatThemeToggle.addEventListener('click', toggleThemeMode);

  // State
  let currentUser = {
    username: '',
    token: '',
    sessionId: '',
    isAdmin: false,
    badge: '',
    avatar: ['🦊','🐼','🦁','🐸','🐵','🦄','🐰','🐶'][Math.floor(Math.random()*8)],
    status: 'online',
    customStatus: 'Coding live'
  };
  let currentRoom = null, activeRoomsList = [], pendingApprovalQueue = [];
  let isHostOfRoom = false, typingTimeout = null, _pendingJoinRoom = null;
  let currentReplyMessage = null;

  // --- Auth Flow ---
  const authView = document.getElementById('auth-view');
  const appContainer = document.querySelector('.app-container');
  const authError = document.getElementById('auth-error-msg');

  // Purge legacy localStorage user so old admin sessions do not auto-login
  try {
    localStorage.removeItem('pulsechat_user');
  } catch (e) {}

  // Check tab session (persists across page reloads/F5, but is completely empty on fresh site visits)
  let sessionUser = null;
  try {
    sessionUser = sessionStorage.getItem('pulsechat_session');
  } catch (e) {}
  
  if (sessionUser) {
    try {
      const data = JSON.parse(sessionUser);
      if (data && data.username) {
        currentUser.username = data.username;
        currentUser.token = data.token || '';
        currentUser.sessionId = data.sessionId || '';
        currentUser.isAdmin = !!data.isAdmin || (data.username && (data.username.toLowerCase() === 'karan singh' || data.username.toLowerCase() === 'admin'));
        authView.style.display = 'none';
        socket.emit('register_user', currentUser);
        socket.emit('user_join', currentUser);
        socket._registered = true;
      } else {
        sessionStorage.removeItem('pulsechat_session');
        currentUser.username = '';
        currentUser.token = '';
        currentUser.sessionId = '';
        currentUser.isAdmin = false;
        authView.style.display = 'flex';
      }
    } catch (e) {
      sessionStorage.removeItem('pulsechat_session');
      currentUser.username = '';
      currentUser.token = '';
      currentUser.sessionId = '';
      currentUser.isAdmin = false;
      authView.style.display = 'flex';
    }
  } else {
    // First time opening website: MUST ask to log in (no default account)
    currentUser.username = '';
    currentUser.token = '';
    currentUser.sessionId = '';
    currentUser.isAdmin = false;
    authView.style.display = 'flex';
  }

  const updateAuthUI = () => {
    const userContainer = document.getElementById('lobby-auth-user');
    const guestContainer = document.getElementById('lobby-auth-guest');
    const authCloseBtn = document.getElementById('btn-auth-close');
    if (currentUser.username) {
      if(userContainer) userContainer.style.display = 'flex';
      if(guestContainer) guestContainer.style.display = 'none';
      const b=document.getElementById('lobby-username'); if(b) b.innerText=currentUser.username;
      const av=document.getElementById('lobby-user-avatar'); if(av) av.innerText=(currentUser.username[0]||'?').toUpperCase();
      if(authCloseBtn) authCloseBtn.style.display = 'block';
    } else {
      if(userContainer) userContainer.style.display = 'none';
      if(guestContainer) guestContainer.style.display = 'flex';
      if(authCloseBtn) authCloseBtn.style.display = 'none';
    }

    // Admin Dashboard Option: ONLY shown to main admin
    const adminBtn = document.getElementById('menu-btn-admin-shortcut');
    if (adminBtn) {
      const isMainAdmin = !!currentUser.isAdmin || (currentUser.username && (currentUser.username.toLowerCase() === 'karan singh' || currentUser.username.toLowerCase() === 'admin'));
      adminBtn.style.display = isMainAdmin ? 'flex' : 'none';
    }
  };

  updateAuthUI();

  const requireAuth = (requireFullAccount = false) => {
    if (!currentUser.username) {
      showToast('Please login or provide a guest name.', 'error');
      authView.style.display = 'flex';
      return false;
    }
    if (requireFullAccount && !currentUser.token) {
      showToast('Guest users cannot do this. Please log in or create an account.', 'error');
      authView.style.display = 'flex';
      return false;
    }
    return true;
  };
  const handleAuth = async (action) => {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    if (!username || !password) {
      authError.textContent = 'Please enter both username and password.';
      authError.style.display = 'block';
      return;
    }

    try {
      const res = await fetch(`/api/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          username, 
          password,
          sessionId: currentUser.sessionId || ''
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed');

      currentUser.username = data.username;
      currentUser.token = data.token;
      currentUser.sessionId = data.sessionId || '';
      currentUser.isAdmin = !!data.isAdmin || data.username.toLowerCase() === 'karan singh' || data.username.toLowerCase() === 'admin';
      sessionStorage.setItem('pulsechat_session', JSON.stringify({
        username: data.username,
        token: data.token,
        sessionId: currentUser.sessionId,
        isAdmin: currentUser.isAdmin
      }));
      
      authError.style.display = 'none';
      authView.style.display = 'none';
      socket.emit('register_user', currentUser);
      socket.emit('user_join', currentUser);
      socket._registered = true;
      updateAuthUI();
      fetchAndRenderLobbyRooms();
      showToast(`Welcome back, ${currentUser.username}!`, 'success');
    } catch (err) {
      authError.textContent = err.message;
      authError.style.display = 'block';
    }
  };

  document.getElementById('btn-auth-login')?.addEventListener('click', () => handleAuth('login'));
  document.getElementById('btn-auth-signup')?.addEventListener('click', () => handleAuth('signup'));
  document.getElementById('auth-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAuth('login');
  });
  document.getElementById('btn-auth-guest')?.addEventListener('click', () => {
    const guestName = document.getElementById('auth-guest-name').value.trim();
    if (!guestName) {
      authError.textContent = 'Please enter a display name to join as a guest.';
      authError.style.display = 'block';
      return;
    }
    currentUser.username = guestName;
    currentUser.token = ''; 
    currentUser.sessionId = 'guest-' + Date.now();
    currentUser.isAdmin = false;
    sessionStorage.setItem('pulsechat_session', JSON.stringify({
      username: currentUser.username,
      token: '',
      sessionId: currentUser.sessionId,
      isAdmin: false
    }));
    socket.emit('register_user', currentUser);
    socket.emit('user_join', currentUser);
    socket._registered = true;
    updateAuthUI();
    authError.style.display = 'none';
    authView.style.display = 'none';
    showToast(`Welcome, Guest ${guestName}!`, 'success');
  });

  document.getElementById('lobby-btn-login-prompt')?.addEventListener('click', () => { authView.style.display = 'flex'; });
  document.getElementById('lobby-btn-signup-prompt')?.addEventListener('click', () => { authView.style.display = 'flex'; });
  document.getElementById('btn-auth-close')?.addEventListener('click', () => { 
    if (!currentUser.username) {
      showToast('Please log in or create an account to access the platform.', 'info');
      return;
    }
    authView.style.display = 'none'; 
  });

  // Managers
  const voiceRecorder    = new window.VoiceRecorder();
  const mediaCallManager = new window.MediaCallManager(socket);
  window.collaborativeWhiteboard = window.CollaborativeWhiteboard ? new CollaborativeWhiteboard(socket) : null;
  const codeStudio       = new window.CollaborativeCodeStudio(socket);

  // DOM Refs
  const elLobbyView    = document.getElementById('front-page-lobby');
  const elSidebar      = document.getElementById('sidebar');
  const elMainView     = document.getElementById('chat-main-view');
  const elStudioView   = document.getElementById('code-studio-view');
  const elWhiteboardView = document.getElementById('whiteboard-main-view');
  const btnModeChat    = document.getElementById('btn-mode-chat');
  const btnModeCode    = document.getElementById('btn-mode-code');
  const btnModeWhiteboard = document.getElementById('btn-mode-whiteboard');
  const btnStudioBackChat = document.getElementById('studio-btn-back-chat');
  const btnBackToLobby    = document.getElementById('btn-back-to-lobby');
  const elTimeline     = document.getElementById('chat-timeline');
  const elTextarea     = document.getElementById('chat-textarea');
  const elSendBtn      = document.getElementById('btn-send-msg');
  const elChannelList  = document.getElementById('channel-list');
  const elUserList     = document.getElementById('user-list');
  const elUserCount    = document.getElementById('user-count');
  const elRoomMemberList  = document.getElementById('room-member-list');
  const elRoomMemberCount = document.getElementById('room-member-count');
  const elTypingBar    = document.getElementById('typing-bar');
  const elTypingText   = document.getElementById('typing-users-text');
  const elCurrentAvatar     = document.getElementById('current-user-avatar');
  const elCurrentUsername   = document.getElementById('current-username');
  const elCurrentStatusText = document.getElementById('current-status-text');
  const elRoomIcon  = document.getElementById('active-room-icon');
  const elRoomTitle = document.getElementById('active-room-title');
  const elRoomDesc  = document.getElementById('active-room-desc');

  // Modals
  const modalWelcome      = document.getElementById('modal-welcome-portal');
  const modalJoinRoom     = document.getElementById('modal-join-room');
  const modalHostApproval = document.getElementById('modal-host-approval');
  const modalWaitingRoom  = document.getElementById('modal-waiting-room');
  const modalCreateRoom   = document.getElementById('modal-create-room');
  const modalEditProfile  = document.getElementById('modal-edit-profile');

  const openModal  = el => el && el.classList.add('active');
  const closeModal = el => el && el.classList.remove('active');
  const closeAllModals = () => [modalWelcome,modalJoinRoom,modalHostApproval,modalWaitingRoom,modalCreateRoom,modalEditProfile].forEach(closeModal);

  // Close on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => {
      if (e.target === ov && ov.id !== 'modal-host-approval' && ov.id !== 'modal-waiting-room') closeModal(ov);
    });
  });

  // Toast
  const showToast = (msg, type = 'info') => {
    const el = document.createElement('div');
    const bg = {error:'rgba(239,68,68,0.95)',success:'rgba(34,197,94,0.95)',info:'rgba(99,102,241,0.95)'}[type]||'rgba(99,102,241,0.95)';
    el.style.cssText = 'position:fixed;bottom:80px;right:24px;z-index:9999;background:'+bg+';color:#fff;padding:13px 22px;border-radius:12px;font-size:0.88rem;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,0.45);max-width:340px;line-height:1.4;';
    el.innerText = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.transition='opacity 0.4s'; el.style.opacity='0'; setTimeout(()=>el.remove(),400); }, 3500);
  };

  // Sound
  const playSoundEffect = (type='message') => {
    if (localStorage.getItem('pulsechat_sound') === 'false') return;
    try {
      const ctx=new(window.AudioContext||window.webkitAudioContext)(),osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      if(type==='message'){ osc.frequency.setValueAtTime(587,ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(880,ctx.currentTime+0.1); gain.gain.setValueAtTime(0.07,ctx.currentTime); gain.gain.linearRampToValueAtTime(0.001,ctx.currentTime+0.15); osc.start(); osc.stop(ctx.currentTime+0.15); }
      else{ osc.frequency.setValueAtTime(880,ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(1174,ctx.currentTime+0.2); gain.gain.setValueAtTime(0.09,ctx.currentTime); gain.gain.linearRampToValueAtTime(0.001,ctx.currentTime+0.25); osc.start(); osc.stop(ctx.currentTime+0.25); }
    } catch(e) {}
  };

  // View management
  const showLobbyView = () => {
    if (currentRoom) {
      socket.emit('leave_room', { roomId: currentRoom.id });
      currentRoom = null;
      isHostOfRoom = false;
    }
    clearReply();
    closeEmojiPicker();
    elLobbyView.style.display = 'block';
    if (elSidebar)    elSidebar.style.display    = 'none';
    if (elMainView)   elMainView.style.display   = 'none';
    if (elStudioView) elStudioView.style.display = 'none';
    if (elWhiteboardView) elWhiteboardView.style.display = 'none';
    fetchAndRenderLobbyRooms();
  };
  const hideLobbyView = () => {
    elLobbyView.style.display = 'none';
    if (elSidebar)  elSidebar.style.display  = 'flex';
    if (elMainView) elMainView.style.display = 'flex';
  };
  const switchViewMode = (mode) => {
    if(!currentRoom) return;
    if(mode === 'code') {
      if(elMainView) elMainView.style.display = 'none';
      if(elWhiteboardView) elWhiteboardView.style.display = 'none';
      if(elStudioView) elStudioView.style.display = 'flex';
      btnModeChat?.classList.remove('active'); 
      btnModeWhiteboard?.classList.remove('active'); 
      btnModeCode?.classList.add('active');
      codeStudio?.refreshEditor();
    } else if(mode === 'whiteboard') {
      if(elMainView) elMainView.style.display = 'none';
      if(elStudioView) elStudioView.style.display = 'none';
      if(elWhiteboardView) elWhiteboardView.style.display = 'flex';
      btnModeChat?.classList.remove('active'); 
      btnModeCode?.classList.remove('active'); 
      btnModeWhiteboard?.classList.add('active');
      if (window.collaborativeWhiteboard) window.collaborativeWhiteboard.resizeCanvas();
    } else {
      if(elStudioView) elStudioView.style.display = 'none';
      if(elWhiteboardView) elWhiteboardView.style.display = 'none';
      if(elMainView) elMainView.style.display = 'flex';
      btnModeCode?.classList.remove('active'); 
      btnModeWhiteboard?.classList.remove('active'); 
      btnModeChat?.classList.add('active');
    }
  };
  btnModeChat?.addEventListener('click', ()=>switchViewMode('chat'));
  btnModeCode?.addEventListener('click', ()=>switchViewMode('code'));
  btnModeWhiteboard?.addEventListener('click', ()=>switchViewMode('whiteboard'));
  btnStudioBackChat?.addEventListener('click', ()=>switchViewMode('chat'));
  btnBackToLobby?.addEventListener('click', ()=>showLobbyView());
  document.querySelectorAll('.btn-go-home').forEach(btn => btn.addEventListener('click', ()=>showLobbyView()));

  // Tabs for lobby filtering
  let activeLobbyTab = 'public-hubs';

  const setLobbyTab = (tab) => {
    activeLobbyTab = tab;
    document.getElementById('tab-public-hubs')?.classList.toggle('active', tab === 'public-hubs');
    document.getElementById('tab-my-envs')?.classList.toggle('active', tab === 'my-envs');
    fetchAndRenderLobbyRooms();
  };

  document.getElementById('tab-my-envs')?.addEventListener('click', () => setLobbyTab('my-envs'));
  document.getElementById('tab-public-hubs')?.addEventListener('click', () => setLobbyTab('public-hubs'));

  // Fetch & Render Lobby Rooms
  const fetchAndRenderLobbyRooms = async () => {
    const grid = document.getElementById('lobby-rooms-grid');
    if (!grid) return;

    try { 
      const res = await fetch('/api/rooms'); 
      const d = await res.json(); 
      activeRoomsList = d.rooms || activeRoomsList; 
    } catch(e) {}

    const q = (document.getElementById('lobby-room-search')?.value || '').toLowerCase().trim();
    const activePill = document.querySelector('.filter-pills .pill.active');
    const pillFilter = activePill ? (activePill.getAttribute('data-filter') || 'all') : 'all';

    let filtered = activeRoomsList.filter(r => {
      const n = (r.name || '').toLowerCase(), desc = (r.description || '').toLowerCase();
      const t = (Array.isArray(r.tags) ? r.tags.join(' ') : r.tags || '').toLowerCase();
      const m = !q || n.includes(q) || desc.includes(q) || t.includes(q);
      if (!m) return false;

      if (pillFilter !== 'all') {
        if (pillFilter === 'protected') {
          if (!r.hasPassword) return false;
        } else {
          const lang = (r.language || '').toLowerCase();
          if (!lang.includes(pillFilter) && !t.includes(pillFilter)) return false;
        }
      }
      return true;
    });

    if (activeLobbyTab === 'my-envs') {
      filtered = filtered.filter(r => r.host_username === currentUser.username || r.hostUsername === currentUser.username);
    }

    const lbl = document.getElementById('lobby-room-count-label');
    if (lbl) lbl.innerText = filtered.length + ' room' + (filtered.length !== 1 ? 's' : '') + ' available';

    grid.innerHTML = '';
    if (!filtered.length) {
      if (activeLobbyTab === 'my-envs') {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px 20px;color:var(--text-muted);"><div style="font-size:3rem;margin-bottom:14px;">🛠️</div><div style="font-size:1.1rem;font-weight:700;color:var(--text-primary);margin-bottom:8px;">No custom environments yet</div><div style="margin-bottom:18px;">Rooms you create will appear here. Start your own room now!</div><button class="btn-lobby-action primary" style="margin:0 auto;display:inline-flex;" onclick="document.getElementById(\'lobby-btn-create-room\')?.click()">➕ Create New Room</button></div>';
      } else {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px 20px;color:var(--text-muted);"><div style="font-size:3rem;margin-bottom:14px;">🏚️</div><div style="font-size:1.05rem;font-weight:600;margin-bottom:8px;color:var(--text-primary);">No rooms found</div><div>Try adjusting your search or create a new room!</div></div>';
      }
      return;
    }

    const langColors={python:'#3b82f6',javascript:'#f59e0b',html:'#ef4444',css:'#8b5cf6'};
    filtered.forEach(room => {
      const card=document.createElement('div'); card.className='room-card';
      const tags=Array.isArray(room.tags)?room.tags:(room.tags||'').split(',').filter(Boolean);
      const tagH=tags.slice(0,4).map(t=>'<span class="room-tag">#'+t.trim()+'</span>').join('');
      const cnt=room.activeMembersCount||0;
      const cntH=cnt>0?'<span style="color:#22c55e;font-weight:600">● '+cnt+' online</span>':'<span style="color:var(--text-dim)">● empty</span>';
      const lc=langColors[room.language]||'#64748b', prot=room.hasPassword;
      card.innerHTML=
        '<div>'+
          '<div class="room-card-header">'+
            '<div class="room-card-icon">'+(room.icon||'💬')+'</div>'+
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">'+
              '<div style="font-size:0.72rem;color:'+(prot?'#f59e0b':'#22c55e')+';background:'+(prot?'rgba(245,158,11,0.1)':'rgba(34,197,94,0.1)')+';border:1px solid '+(prot?'rgba(245,158,11,0.3)':'rgba(34,197,94,0.3)')+';padding:2px 8px;border-radius:10px;">'+(prot?'🔒 Protected':'🌐 Public')+'</div>'+
              '<div style="font-size:0.68rem;padding:2px 7px;border-radius:8px;background:rgba(255,255,255,0.05);color:'+lc+';border:1px solid '+lc+'44;">'+(room.language||'code')+'</div>'+
            '</div>'+
          '</div>'+
          '<div class="room-card-title">#'+room.name+'</div>'+
          '<div class="room-card-desc">'+(room.description||'A live collaborative workspace')+'</div>'+
          '<div class="room-card-tags">'+tagH+'</div>'+
        '</div>'+
        '<div class="room-card-footer">'+
          '<div class="room-card-meta">'+
            '<div style="margin-bottom:2px;">👤 '+(room.hostUsername||'Host')+'</div>'+
            '<div>'+cntH+'</div>'+
          '</div>'+
          '<div style="display:flex; gap:6px;">'+
            ((room.host_username === currentUser.username || room.hostUsername === currentUser.username) ? '<button class="btn-delete-room-card" style="background:rgba(239, 68, 68, 0.1); border:1px solid rgba(239, 68, 68, 0.3); color:#ef4444; border-radius:6px; padding:8px 12px; font-weight:600; cursor:pointer;" data-id="'+room.id+'" title="Delete Room">🗑️</button>' : '') +
            '<button class="btn-join-room-card">'+(prot?'🔒 Enter Password':'Join Room →')+'</button>'+
          '</div>'+
        '</div>';
      card.querySelector('.btn-join-room-card').addEventListener('click', ()=>handleJoinRoomClick(room));
      card.querySelector('.btn-delete-room-card')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm("Are you sure you want to delete this room? This cannot be undone.")) {
          try {
            await fetch(`/api/rooms/${room.id}`, { method: 'DELETE' });
            showToast("Room deleted.", "success");
            fetchAndRenderLobbyRooms();
          } catch (err) {
            showToast("Failed to delete room.", "error");
          }
        }
      });
      grid.appendChild(card);
    });
  };

  // Join Room Flow
  const handleJoinRoomClick = room => {
    if (!requireAuth()) return;
    if (room.hasPassword) {
      _pendingJoinRoom=room;
      const sub=document.getElementById('join-room-modal-subtitle'); if(sub) sub.innerText='Enter password for #'+room.name;
      const pw=document.getElementById('join-room-password-input');  if(pw) pw.value='';
      const err=document.getElementById('join-room-error-msg');      if(err) err.style.display='none';
      openModal(modalJoinRoom); setTimeout(()=>pw&&pw.focus(),100);
    } else {
      socket.emit('request_join_room', { roomId: room.id, password: '' });
    }
  };
  document.getElementById('btn-confirm-join-room')?.addEventListener('click', () => {
    if(!_pendingJoinRoom) return;
    const pw=document.getElementById('join-room-password-input')?.value.trim()||'';
    closeModal(modalJoinRoom); socket.emit('request_join_room',{roomId:_pendingJoinRoom.id,password:pw}); _pendingJoinRoom=null;
  });
  document.getElementById('btn-close-join-modal')?.addEventListener('click', ()=>{ closeModal(modalJoinRoom); _pendingJoinRoom=null; });
  document.getElementById('join-room-password-input')?.addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('btn-confirm-join-room')?.click(); });

  // Lobby Buttons
  document.getElementById('lobby-room-search')?.addEventListener('input', fetchAndRenderLobbyRooms);
  document.querySelectorAll('.filter-pills .pill').forEach(pill => {
    pill.addEventListener('click', ()=>{ document.querySelectorAll('.filter-pills .pill').forEach(p=>p.classList.remove('active')); pill.classList.add('active'); fetchAndRenderLobbyRooms(); });
  });
  document.getElementById('lobby-btn-scratchpad')?.addEventListener('click', ()=>{ 
    if (!requireAuth()) return; 
    socket.emit('request_join_room',{roomId:'general',password:''}); 
    setTimeout(() => {
      switchViewMode('code');
      codeStudio?.refreshEditor();
    }, 350); 
  });
  document.getElementById('lobby-btn-create-room')?.addEventListener('click', ()=>{ if (!requireAuth(true)) return; openModal(modalCreateRoom); });

  // Quick Join
  const quickJoinInput = document.getElementById('lobby-quick-join-input');
  const handleQuickJoin = () => {
    if (!requireAuth()) return;
    const roomId = quickJoinInput?.value.trim().toLowerCase();
    if (!roomId) return;
    const room = activeRoomsList.find(r => r.id === roomId || r.name.toLowerCase() === roomId);
    if (room) {
      handleJoinRoomClick(room);
    } else {
      socket.emit('request_join_room', { roomId, password: '' });
    }
    if (quickJoinInput) quickJoinInput.value = '';
  };
  document.getElementById('lobby-quick-join-btn')?.addEventListener('click', handleQuickJoin);
  quickJoinInput?.addEventListener('keydown', e => { if (e.key === 'Enter') handleQuickJoin(); });

  // Socket
  socket.on('connect', ()=>{ 
    if (currentUser.username) {
      socket.emit('user_join', currentUser);
    }
    // Chat Drag & Drop File Uploads
    if (elTimeline) {
      elTimeline.addEventListener('dragover', (e) => {
        e.preventDefault();
        elTimeline.style.border = '2px dashed #8b5cf6';
      });
      elTimeline.addEventListener('dragleave', (e) => {
        e.preventDefault();
        elTimeline.style.border = 'none';
      });
      elTimeline.addEventListener('drop', (e) => {
        e.preventDefault();
        elTimeline.style.border = 'none';
        if(!currentRoom) return;
        
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          const file = files[0];
          
          // Safety: Limit file size to 5MB
          if (file.size > 5 * 1024 * 1024) {
            showToast('File is too large! Maximum allowed is 5MB.', 'error');
            return;
          }

          const reader = new FileReader();
          reader.onload = (e) => {
            const fileData = {
              filename: file.name,
              mimetype: file.type,
              url: e.target.result
            };
            socket.emit('send_message', { roomId: currentRoom.id, attachment: fileData });
          };
          reader.readAsDataURL(file);
        }
      });
    }

    fetchAndRenderLobbyRooms(); 
  });

  socket.on('init_payload', data => {
    socket._registered=true;
    if(data.user && data.user.username) {
      currentUser={...currentUser,...data.user};
    }
    activeRoomsList=data.rooms||[];
    updateUserProfileUI(); 
    updateAuthUI();
    renderChannelsList(activeRoomsList); 
    renderDMList();
    renderActiveUsersList(data.activeUsers||[]);
    fetchAndRenderLobbyRooms();
    const ln=document.getElementById('lobby-username'); if(ln&&currentUser.username) ln.innerText=currentUser.username;
    const la=document.getElementById('lobby-user-avatar'); if(la&&currentUser.username) la.innerText=currentUser.avatar;
    if(socket._pendingAction){ const a=socket._pendingAction; socket._pendingAction=null; setTimeout(a,100); }
  });

  socket.on('room_switched', ({room,messages,codeWorkspace,members}) => {
    closeAllModals(); currentRoom=room; isHostOfRoom=!!room.isHost; hideLobbyView();
    clearReply();
    closeEmojiPicker();
    updatePinnedBanner(room.pinnedMessage);
    if(elRoomIcon)  elRoomIcon.innerText =(room.icon||'💬');
    if(elRoomTitle) elRoomTitle.innerText='#'+room.name+(isHostOfRoom ? '  👑 (Host)' : (room.hostUsername ? `  [Host: ${room.hostUsername}]` : ''));
    if(elRoomDesc)  elRoomDesc.innerText =(room.description||'');
    renderChannelsList(activeRoomsList); renderDMList(); renderMessages(messages||[]); renderRoomMembers(members||[]);
    if(codeWorkspace) codeStudio.loadWorkspace(codeWorkspace,room.id);
    
    // Switch view if first time entering room
    switchViewMode('chat');

    // Notify Whiteboard
    if (window.collaborativeWhiteboard) {
      window.collaborativeWhiteboard.setRoomId(currentRoom.id);
      window.collaborativeWhiteboard.clearBoard(false); // clear UI board safely
    }

    // Mark unseen messages from other members as seen
    const unseenIds = (messages || [])
      .filter(m => m.user && m.user.username !== currentUser.username && (!m.seenBy || !m.seenBy.includes(currentUser.username)))
      .map(m => m.id);
    if (unseenIds.length > 0) {
      socket.emit('mark_seen', { roomId: room.id, messageIds: unseenIds });
    }

    showToast('Joined #'+room.name,'success');
  });

  socket.on('join_error', ({message}) => {
    closeModal(modalWaitingRoom);
    const errEl=document.getElementById('join-room-error-msg');
    if(modalJoinRoom?.classList.contains('active')&&errEl){errEl.style.display='block';errEl.innerText=message;}
    else showToast(message,'error');
  });
  socket.on('join_pending', ({message}) => { closeModal(modalJoinRoom); openModal(modalWaitingRoom); const el=document.getElementById('waiting-room-msg'); if(el) el.innerText=message; });
  socket.on('host_approval_request', ({roomId,roomName,requester,requesterSocketId}) => { pendingApprovalQueue.push({roomId,requesterSocketId,name:requester.username,room:roomName}); showNextApprovalRequest(); });
  const showNextApprovalRequest = () => { if(!pendingApprovalQueue.length){closeModal(modalHostApproval);return;} const nx=pendingApprovalQueue[0]; const ne=document.getElementById('host-req-name');if(ne) ne.innerText=nx.name; const re=document.getElementById('host-req-room');if(re) re.innerText='#'+nx.room; openModal(modalHostApproval); playSoundEffect('alert'); };
  document.getElementById('btn-host-approve')?.addEventListener('click', ()=>{ const r=pendingApprovalQueue.shift(); if(r) socket.emit('approve_join_request',{roomId:r.roomId,requesterSocketId:r.requesterSocketId}); showNextApprovalRequest(); });
  document.getElementById('btn-host-deny')?.addEventListener('click', ()=>{ const r=pendingApprovalQueue.shift(); if(r) socket.emit('deny_join_request',{roomId:r.roomId,requesterSocketId:r.requesterSocketId}); showNextApprovalRequest(); });
  socket.on('kicked_from_room', ({message})=>{ currentRoom=null; isHostOfRoom=false; showLobbyView(); showToast(message,'error'); });
  socket.on('room_members_updated', members=>renderRoomMembers(members||[]));
  socket.on('rooms_updated', rooms=>{ activeRoomsList=rooms; renderChannelsList(rooms); fetchAndRenderLobbyRooms(); const s=document.getElementById('stat-active-rooms');if(s) s.innerText=rooms.length; });
  socket.on('connect', () => {
    if (currentUser.username) {
      socket.emit('register_user', currentUser);
      socket.emit('user_join', currentUser);
    } else {
      socket.emit('user_join', {});
    }
  });

  socket.on('session_synced', ({ sessionId }) => {
    if (sessionId) {
      currentUser.sessionId = sessionId;
      const stored = sessionStorage.getItem('pulsechat_session');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          parsed.sessionId = sessionId;
          sessionStorage.setItem('pulsechat_session', JSON.stringify(parsed));
        } catch (e) {}
      }
    }
  });

  socket.on('auth_error', ({ message }) => {
    sessionStorage.removeItem('pulsechat_session');
    localStorage.removeItem('pulsechat_user');
    currentUser.username = '';
    currentUser.token = '';
    currentUser.sessionId = '';
    currentUser.isAdmin = false;
    updateAuthUI();
    showToast(message, 'error');
    if (authError) {
      authError.textContent = message;
      authError.style.display = 'block';
    }
    if (authView) {
      authView.style.display = 'flex';
    }
  });

  socket.on('force_logout', data => {
    if (currentUser.token === data.userId) {
      alert("Your account has been deleted by an administrator.");
      document.getElementById('lobby-btn-logout')?.click();
      setTimeout(() => location.reload(), 1000);
    }
  });

  socket.on('message_received', msg=>{ 
    if(currentRoom&&msg.roomId===currentRoom.id){ 
      appendSingleMessage(msg); 
      scrollToBottom(); 
      if(!msg.isSystem&&msg.user&&msg.user.id!==socket.id) {
        playSoundEffect('message'); 
        socket.emit('mark_seen', { roomId: currentRoom.id, messageIds: [msg.id] });
      }
    } 
  });
  socket.on('messages_seen', ({ roomId, messageIds, seenBy }) => {
    if (currentRoom && roomId === currentRoom.id && messageIds) {
      messageIds.forEach(mid => {
        const tick = document.getElementById(`delivery-${mid}`);
        if (tick) {
          tick.classList.add('seen');
          tick.innerText = '✓✓';
        }
      });
    }
  });
  socket.on('pinned_message_updated', (pinnedMsg) => {
    updatePinnedBanner(pinnedMsg);
    if (pinnedMsg) {
      showToast(`📌 Pinned message from ${pinnedMsg.user?.username || 'User'}`, 'info');
    } else {
      showToast('Message unpinned', 'info');
    }
  });
  socket.on('message_edited', ({ messageId, roomId, text, isEdited }) => {
    if (currentRoom && roomId === currentRoom.id) {
      const card = document.querySelector('[data-message-id="' + messageId + '"]');
      if (card) {
        card.setAttribute('data-raw-text', text);
        const textSpan = card.querySelector('.message-text-content');
        if (textSpan) {
          textSpan.innerHTML = fmt(text);
        } else {
          const bubble = card.querySelector('.message-bubble');
          if (bubble) bubble.innerHTML = '<span class="message-text-content">' + fmt(text) + '</span>';
        }
        const editBox = card.querySelector('.message-edit-container');
        if (editBox) editBox.remove();
        const bubble = card.querySelector('.message-bubble');
        if (bubble) bubble.style.display = 'block';

        const meta = card.querySelector('.message-meta');
        if (meta && !meta.querySelector('.message-edited-tag')) {
          const tag = document.createElement('span');
          tag.className = 'message-edited-tag';
          tag.innerText = '(edited)';
          const ts = meta.querySelector('.message-timestamp');
          if (ts) ts.insertAdjacentElement('afterend', tag);
          else meta.appendChild(tag);
        }
      }
    }
  });
  socket.on('message_deleted', ({ messageId, roomId }) => {
    if (currentRoom && roomId === currentRoom.id) {
      const card = document.querySelector('[data-message-id="' + messageId + '"]');
      if (card) {
        card.classList.add('deleting');
        setTimeout(() => card.remove(), 260);
      }
    }
  });
  socket.on('reaction_updated', ({messageId,roomId,reactions})=>{ if(currentRoom&&roomId===currentRoom.id){const c=document.querySelector('[data-message-id="'+messageId+'"]');if(c){const r=c.querySelector('.reactions-row');if(r) r.innerHTML=renderReactionsHTML(messageId,roomId,reactions);}} });
  socket.on('user_typing', ({roomId,username,isTyping})=>{ if(currentRoom&&roomId===currentRoom.id){if(elTypingBar) elTypingBar.style.visibility=isTyping?'visible':'hidden';if(isTyping&&elTypingText) elTypingText.innerText=username+' is typing…';} });
  socket.on('user_status_change', ({activeUsers})=>{ renderActiveUsersList(activeUsers); const s=document.getElementById('stat-active-users');if(s) s.innerText=activeUsers.length; });

  // ─── Helper Functions for Badges, Links, DMs, Search & Pins ──────────────
  const renderUserBadgeHTML = (user) => {
    if (!user) return '';
    let html = '';
    const isMainAdmin = !!user.isAdmin || (user.username && (user.username.toLowerCase() === 'karan singh' || user.username.toLowerCase() === 'admin'));
    if (user.isHost) {
      html += '<span class="user-badge host">👑 Host</span>';
    }
    if (isMainAdmin) {
      html += '<span class="user-badge admin">🛡️ Admin</span>';
    }
    if (user.badge && user.badge.trim() && !user.badge.includes('Admin') && !user.badge.includes('Host')) {
      html += '<span class="user-badge custom">' + escapeHTML(user.badge.trim()) + '</span>';
    }
    return html;
  };

  const generateLinkPreviewHTML = (text) => {
    if (!text) return '';
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/i);
    if (!urlMatch) return '';
    const url = urlMatch[0];
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace(/^www\./, '');
      let icon = '🔗';
      if (domain.includes('github')) icon = '🐙';
      else if (domain.includes('youtube') || domain.includes('youtu.be')) icon = '▶️';
      else if (domain.includes('google')) icon = '🔍';
      else if (domain.includes('twitter') || domain.includes('x.com')) icon = '🐦';
      else if (domain.includes('wikipedia')) icon = '📖';

      return `
        <a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" class="link-preview-card">
          <div class="link-preview-icon">${icon}</div>
          <div class="link-preview-info">
            <div class="link-preview-domain">${escapeHTML(domain)}</div>
            <div class="link-preview-title">${escapeHTML(parsed.pathname.length > 1 ? parsed.pathname : domain)}</div>
          </div>
          <div class="link-preview-arrow">↗</div>
        </a>
      `;
    } catch(e) {
      return '';
    }
  };

  // ─── Direct Messages (DMs) Manager ────────────────────────────────────────
  const dmList = document.getElementById('sidebar-dm-list');
  const knownDMs = new Set(JSON.parse(localStorage.getItem('pulsechat_dms') || '[]'));

  const saveKnownDMs = () => {
    localStorage.setItem('pulsechat_dms', JSON.stringify(Array.from(knownDMs)));
  };

  const renderDMList = () => {
    if (!dmList) return;
    dmList.innerHTML = '';
    if (knownDMs.size === 0) {
      dmList.innerHTML = '<li style="padding:6px 12px; font-size:0.75rem; color:var(--text-dim);">No direct messages yet. Click an online user to chat!</li>';
      return;
    }

    knownDMs.forEach(dmUser => {
      const li = document.createElement('li');
      const dmRoomId = 'dm_' + [currentUser.username, dmUser].sort().join('__').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const isActive = currentRoom && currentRoom.id === dmRoomId;
      li.className = 'channel-item' + (isActive ? ' active' : '');
      li.innerHTML = `
        <span class="channel-icon">💬</span>
        <span class="channel-name">@${escapeHTML(dmUser)}</span>
      `;
      li.addEventListener('click', () => {
        openDirectMessage(dmUser);
      });
      dmList.appendChild(li);
    });
  };

  const openDirectMessage = (targetUsername) => {
    if (!currentUser.username || !targetUsername || targetUsername === currentUser.username) return;
    knownDMs.add(targetUsername);
    saveKnownDMs();
    renderDMList();

    const dmRoomId = 'dm_' + [currentUser.username, targetUsername].sort().join('__').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    socket.emit('request_join_room', {
      roomId: dmRoomId,
      password: '',
      name: `${currentUser.username} & ${targetUsername}`,
      description: `Direct conversation with @${targetUsername}`
    });
  };

  // ─── Pinned Message Manager ───────────────────────────────────────────────
  let currentPinnedMessageId = null;

  const updatePinnedBanner = (pinnedMsg) => {
    const banner = document.getElementById('chat-pinned-banner');
    const authorEl = document.getElementById('chat-pinned-author');
    const textEl = document.getElementById('chat-pinned-text');
    if (!banner) return;

    if (pinnedMsg && pinnedMsg.id) {
      currentPinnedMessageId = pinnedMsg.id;
      if (authorEl) authorEl.innerText = pinnedMsg.user?.username || 'User';
      if (textEl) {
        const t = pinnedMsg.text || (pinnedMsg.attachment ? `[Attachment: ${pinnedMsg.attachment.filename}]` : '[Message]');
        textEl.innerText = t.length > 70 ? t.substring(0, 70) + '…' : t;
      }
      banner.style.display = 'flex';
    } else {
      currentPinnedMessageId = null;
      banner.style.display = 'none';
    }
  };

  document.getElementById('btn-jump-pinned')?.addEventListener('click', () => {
    if (currentPinnedMessageId) {
      window.scrollToMessage(currentPinnedMessageId);
    }
  });

  document.getElementById('btn-unpin-msg')?.addEventListener('click', () => {
    if (currentRoom) {
      socket.emit('unpin_message', { roomId: currentRoom.id });
    }
  });

  window.pinMessage = (mid) => {
    if (currentRoom) {
      socket.emit('pin_message', { roomId: currentRoom.id, messageId: mid });
    }
  };

  // ─── In-Chat Search Manager ───────────────────────────────────────────────
  const searchBar = document.getElementById('chat-search-bar');
  const searchInput = document.getElementById('chat-search-input');
  const searchCount = document.getElementById('chat-search-count');
  const searchPrevBtn = document.getElementById('chat-search-prev');
  const searchNextBtn = document.getElementById('chat-search-next');
  const searchCloseBtn = document.getElementById('chat-search-close');
  const searchToggleBtn = document.getElementById('btn-toggle-chat-search');

  let chatSearchMatches = [];
  let currentSearchIdx = -1;

  const clearChatSearchHighlights = () => {
    if (!elTimeline) return;
    const marks = elTimeline.querySelectorAll('.chat-search-match');
    marks.forEach(m => {
      const parent = m.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      }
    });
  };

  const performChatSearch = () => {
    clearChatSearchHighlights();
    chatSearchMatches = [];
    currentSearchIdx = -1;

    const q = searchInput?.value.trim().toLowerCase();
    if (!q || !elTimeline) {
      if (searchCount) searchCount.style.display = 'none';
      return;
    }

    const messageCards = elTimeline.querySelectorAll('.message-card');
    messageCards.forEach(card => {
      const textSpan = card.querySelector('.message-text-content');
      if (!textSpan) return;
      const originalText = textSpan.innerText;
      const lower = originalText.toLowerCase();

      if (lower.includes(q)) {
        let newHTML = '';
        let lastIdx = 0;
        let matchPos = lower.indexOf(q, lastIdx);

        while (matchPos !== -1) {
          newHTML += escapeHTML(originalText.substring(lastIdx, matchPos));
          newHTML += `<mark class="chat-search-match">${escapeHTML(originalText.substring(matchPos, matchPos + q.length))}</mark>`;
          lastIdx = matchPos + q.length;
          matchPos = lower.indexOf(q, lastIdx);
        }
        newHTML += escapeHTML(originalText.substring(lastIdx));
        textSpan.innerHTML = newHTML;

        card.querySelectorAll('.chat-search-match').forEach(matchEl => {
          chatSearchMatches.push({ card, el: matchEl });
        });
      }
    });

    if (searchCount) {
      searchCount.style.display = 'inline-block';
      searchCount.innerText = `${chatSearchMatches.length} match${chatSearchMatches.length !== 1 ? 'es' : ''}`;
    }

    if (chatSearchMatches.length > 0) {
      jumpToChatMatch(0);
    }
  };

  const jumpToChatMatch = (idx) => {
    if (chatSearchMatches.length === 0) return;
    if (idx < 0) idx = chatSearchMatches.length - 1;
    if (idx >= chatSearchMatches.length) idx = 0;
    currentSearchIdx = idx;

    chatSearchMatches.forEach(m => m.el.classList.remove('current'));
    const current = chatSearchMatches[currentSearchIdx];
    current.el.classList.add('current');
    current.card.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if (searchCount) {
      searchCount.innerText = `${currentSearchIdx + 1} of ${chatSearchMatches.length}`;
    }
  };

  searchToggleBtn?.addEventListener('click', () => {
    if (!searchBar) return;
    const isVis = searchBar.style.display !== 'none';
    searchBar.style.display = isVis ? 'none' : 'flex';
    if (!isVis) {
      searchInput?.focus();
      if (searchInput?.value) performChatSearch();
    } else {
      clearChatSearchHighlights();
    }
  });

  searchInput?.addEventListener('input', performChatSearch);
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) jumpToChatMatch(currentSearchIdx - 1);
      else jumpToChatMatch(currentSearchIdx + 1);
    } else if (e.key === 'Escape') {
      searchBar.style.display = 'none';
      clearChatSearchHighlights();
    }
  });

  searchPrevBtn?.addEventListener('click', () => jumpToChatMatch(currentSearchIdx - 1));
  searchNextBtn?.addEventListener('click', () => jumpToChatMatch(currentSearchIdx + 1));
  searchCloseBtn?.addEventListener('click', () => {
    if (searchBar) searchBar.style.display = 'none';
    clearChatSearchHighlights();
  });

  // Renderers
  const updateUserProfileUI = () => {
    const avatar = currentUser.avatar || '⚡';
    const username = currentUser.username || '';
    const statusText = currentUser.customStatus || 'Online';

    if(elCurrentAvatar)     elCurrentAvatar.innerText    = avatar;
    if(elCurrentUsername)   elCurrentUsername.innerText  = username;
    if(elCurrentStatusText) elCurrentStatusText.innerText= statusText;

    const lobbyAvatar = document.getElementById('lobby-user-avatar');
    const lobbyName = document.getElementById('lobby-username');
    if (lobbyAvatar) lobbyAvatar.innerText = avatar;
    if (lobbyName) lobbyName.innerText = username;

    const chatAvatar = document.getElementById('chat-user-avatar');
    const chatName = document.getElementById('chat-username');
    if (chatAvatar) chatAvatar.innerText = avatar;
    if (chatName) chatName.innerText = username;

    const menuAvatar = document.getElementById('menu-user-avatar');
    const menuName = document.getElementById('menu-username');
    const menuStatus = document.getElementById('menu-user-status');
    if (menuAvatar) menuAvatar.innerText = avatar;
    if (menuName) menuName.innerText = username;
    if (menuStatus) menuStatus.innerText = '🟢 ' + statusText;
  };

  const renderChannelsList = rooms => {
    if(!elChannelList) return; elChannelList.innerHTML='';
    rooms.forEach(r=>{ const li=document.createElement('li'); li.className='channel-item'+(currentRoom&&r.id===currentRoom.id?' active':''); li.innerHTML='<span class="channel-icon">'+(r.icon||'💬')+'</span><span class="channel-name">#'+r.name+'</span>'+(r.hasPassword?'<span style="font-size:11px;">🔒</span>':''); li.addEventListener('click',()=>{ if(currentRoom&&r.id===currentRoom.id) return; if(r.hasPassword) handleJoinRoomClick(r); else socket.emit('request_join_room',{roomId:r.id,password:''}); }); elChannelList.appendChild(li); });
    renderDMList();
  };

  const renderActiveUsersList = users => {
    if(!elUserList) return; elUserList.innerHTML=''; if(elUserCount) elUserCount.innerText=users.length;
    users.forEach(u=>{ 
      const li=document.createElement('li'); 
      li.className='user-item'; 
      li.style.cursor = 'pointer';
      li.title = `Direct message @${u.username}`;
      const badgeHTML = renderUserBadgeHTML(u);
      li.innerHTML='<div class="user-avatar-container" style="width:32px;height:32px;"><div class="user-avatar" style="font-size:16px;">'+(u.avatar||'⚡')+'</div><div class="status-dot '+(u.status||'online')+'"></div></div><div style="min-width:0;flex:1;"><div class="user-name" style="font-size:0.85rem;">'+u.username+badgeHTML+'</div><div class="user-status-text" style="font-size:0.7rem;">'+(u.customStatus||'Online')+'</div></div>'; 
      li.addEventListener('click', () => {
        if (u.username !== currentUser.username) {
          openDirectMessage(u.username);
        }
      });
      elUserList.appendChild(li); 
    });
  };

  const renderRoomMembers = members => {
    if(!elRoomMemberList) return; elRoomMemberList.innerHTML=''; if(elRoomMemberCount) elRoomMemberCount.innerText=members.length;
    members.forEach(m=>{ 
      const li=document.createElement('li'); 
      li.className='user-item'; 
      const isSelf=m.id===socket.id,canKick=isHostOfRoom&&!isSelf&&!m.isHost; 
      const isHost = m.isHost || (currentRoom && currentRoom.hostUsername === m.username);
      const badgeHTML = renderUserBadgeHTML({ ...m, isHost });
      li.innerHTML='<div class="user-avatar-container" style="width:28px;height:28px;"><div class="user-avatar" style="font-size:14px;">'+(m.avatar||'⚡')+'</div><div class="status-dot online"></div></div><div style="min-width:0;flex:1;"><div class="user-name" style="font-size:0.82rem;">'+m.username+badgeHTML+(isSelf?' <span style="font-size:10px;color:var(--text-muted);">(you)</span>':'')+'</div></div>'+(canKick?'<button class="btn-kick" data-mid="'+m.id+'">🚫</button>':''); 
      if(canKick) li.querySelector('.btn-kick').addEventListener('click',e=>{e.stopPropagation();if(confirm('Kick '+m.username+'?')) socket.emit('kick_member',{roomId:currentRoom.id,memberSocketId:e.currentTarget.dataset.mid});}); 
      if (!isSelf) {
        li.style.cursor = 'pointer';
        li.title = `Direct message @${m.username}`;
        li.addEventListener('click', (e) => {
          if (!e.target.closest('.btn-kick')) {
            openDirectMessage(m.username);
          }
        });
      }
      elRoomMemberList.appendChild(li); 
    });
  };

  const renderMessages = msgs=>{ if(!elTimeline) return; elTimeline.innerHTML=''; msgs.forEach(appendSingleMessage); scrollToBottom(); };
  const scrollToBottom  = ()=>{ if(elTimeline) elTimeline.scrollTop=elTimeline.scrollHeight; };
  const escapeHTML = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = t=>{ let f=escapeHTML(t); f=f.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>'); f=f.replace(/\*(.*?)\*/g,'<em>$1</em>'); f=f.replace(/`(.*?)`/g,'<code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;font-family:monospace;">$1</code>'); return f; };
  const renderReactionsHTML = (mid,rid,reactions={})=>Object.entries(reactions).filter(([,u])=>u?.length).map(([e,u])=>'<span class="reaction-pill '+(u.includes(currentUser.username)?'active':'')+'" onclick="window.toggleReaction(\''+mid+'\',\''+rid+'\',\''+e+'\')">'+e+' '+u.length+'</span>').join('');

  const appendSingleMessage = msg => {
    if(!elTimeline) return;
    if(msg.isSystem){const d=document.createElement('div');d.className='system-event-pill';d.innerHTML=fmt(msg.text||'');elTimeline.appendChild(d);return;}
    const isSelf = msg.user && (msg.user.id === socket.id || msg.user.username === currentUser.username);
    const canEdit = isSelf && !msg.isSystem && !!msg.text;
    const canDelete = isSelf || isHostOfRoom;

    const card=document.createElement('div'); card.className='message-card'+(isSelf?' self':''); 
    card.setAttribute('data-message-id',msg.id);
    card.setAttribute('data-raw-text', msg.text || '');
    card.setAttribute('data-author', msg.user ? msg.user.username : 'User');
    card.addEventListener('dblclick', () => window.setReplyMessage(msg.id));

    const time=new Date(msg.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    let media='';
    if(msg.attachment){ if(msg.attachment.mimetype?.startsWith('image/')) media+='<img src="'+msg.attachment.url+'" class="message-image-embed" alt="img">'; else media+='<div style="margin-top:8px;"><a href="'+msg.attachment.url+'" target="_blank" style="color:var(--accent-cyan);text-decoration:underline;">📎 '+msg.attachment.filename+'</a></div>'; }
    if(msg.voiceNote) media+='<div class="voice-note-player"><button class="btn-play-voice" onclick="new Audio(\''+msg.voiceNote.url+'\').play()">▶</button><span style="font-size:0.8rem;color:var(--text-muted);">Voice ('+msg.voiceNote.duration+'s)</span></div>';
    if(msg.codeSnippet) media+='<div class="code-snippet-box"><div class="code-header"><span>'+(msg.codeSnippet.language||'code')+'</span><button style="background:transparent;border:none;color:var(--accent-cyan);cursor:pointer;" onclick="navigator.clipboard.writeText(this.closest(\'.code-snippet-box\').querySelector(\'.code-content\').innerText)">Copy</button></div><div class="code-content">'+escapeHTML(msg.codeSnippet.code)+'</div></div>';

    let quotedHTML = '';
    if (msg.replyTo && msg.replyTo.id) {
      quotedHTML = 
        '<div class="quoted-reply-bubble" onclick="window.scrollToMessage(\''+msg.replyTo.id+'\')" title="Click to view original message">' +
          '<div class="quoted-reply-stripe"></div>' +
          '<div class="quoted-reply-body">' +
            '<div class="quoted-reply-author">'+escapeHTML(msg.replyTo.username || 'User')+'</div>' +
            '<div class="quoted-reply-text">'+escapeHTML(msg.replyTo.text || '[Attachment]')+'</div>' +
          '</div>' +
        '</div>';
    }

    const isHostMsg = currentRoom && currentRoom.hostUsername === msg.user?.username;
    const authorBadges = renderUserBadgeHTML({ ...msg.user, isHost: isHostMsg });
    const linkPreviewHTML = generateLinkPreviewHTML(msg.text);

    const isSeen = msg.seenBy && msg.seenBy.some(u => u !== currentUser.username);
    const deliveryTick = isSelf ? `<span class="message-delivery-status ${isSeen ? 'seen' : ''}" id="delivery-${msg.id}">${isSeen ? '✓✓' : '✓'}</span>` : '';

    const editedTag = msg.isEdited ? '<span class="message-edited-tag">(edited)</span>' : '';
    const actionsBar = '<div class="message-actions-bar">' +
      '<button class="message-action-btn reply" onclick="window.setReplyMessage(\''+msg.id+'\')" title="Reply">↩️</button>' +
      '<button class="message-action-btn pin" onclick="window.pinMessage(\''+msg.id+'\')" title="Pin message">📌</button>' +
      '<button class="message-action-btn react" onclick="window.toggleEmojiPopForMessage(\''+msg.id+'\')" title="React">➕</button>' +
      (canEdit ? '<button class="message-action-btn edit" onclick="window.startEditMessage(\''+msg.id+'\')" title="Edit message">✏️</button>' : '') +
      (canDelete ? '<button class="message-action-btn delete" onclick="window.deleteMessage(\''+msg.id+'\')" title="Delete message">🗑️</button>' : '') +
      '</div>';

    card.innerHTML=
      '<div class="message-avatar">'+(msg.user?msg.user.avatar:'⚡')+'</div>' +
      '<div class="message-content-wrapper">' +
        '<div class="message-meta">' +
          '<span class="message-author">'+(msg.user?msg.user.username:'User')+'</span>' +
          authorBadges +
          (msg.user?.isBot?'<span class="bot-tag">BOT</span>':'') +
          '<span class="message-timestamp">'+time+'</span>' +
          deliveryTick +
          editedTag +
          actionsBar +
        '</div>' +
        '<div class="message-bubble">' +
          quotedHTML +
          (msg.text ? '<span class="message-text-content">'+fmt(msg.text)+'</span>' : '') +
          media +
          linkPreviewHTML +
        '</div>' +
        '<div class="reactions-row">'+renderReactionsHTML(msg.id,msg.roomId,msg.reactions)+'</div>' +
      '</div>';

    elTimeline.appendChild(card);
  };

  window.startEditMessage = (mid) => {
    const card = document.querySelector('[data-message-id="' + mid + '"]');
    if (!card) return;
    if (card.querySelector('.message-edit-container')) return;

    const bubble = card.querySelector('.message-bubble');
    const rawText = card.getAttribute('data-raw-text') || '';
    bubble.style.display = 'none';

    const editContainer = document.createElement('div');
    editContainer.className = 'message-edit-container';
    editContainer.innerHTML = 
      '<textarea class="message-edit-input">' + escapeHTML(rawText) + '</textarea>' +
      '<div class="message-edit-actions">' +
        '<button class="btn-edit-action primary" onclick="window.saveEditMessage(\'' + mid + '\')">Save</button>' +
        '<button class="btn-edit-action" onclick="window.cancelEditMessage(\'' + mid + '\')">Cancel</button>' +
        '<span style="font-size:0.7rem;color:var(--text-dim);margin-left:auto;">Enter to save • Esc to cancel</span>' +
      '</div>';

    const wrapper = card.querySelector('.message-content-wrapper');
    const reactions = card.querySelector('.reactions-row');
    wrapper.insertBefore(editContainer, reactions);

    const textarea = editContainer.querySelector('textarea');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        window.saveEditMessage(mid);
      } else if (e.key === 'Escape') {
        window.cancelEditMessage(mid);
      }
    });
  };

  window.saveEditMessage = (mid) => {
    const card = document.querySelector('[data-message-id="' + mid + '"]');
    if (!card || !currentRoom) return;
    const textarea = card.querySelector('.message-edit-input');
    if (!textarea) return;
    const newText = textarea.value.trim();
    if (!newText) {
      showToast('Message cannot be empty', 'error');
      return;
    }
    socket.emit('edit_message', { roomId: currentRoom.id, messageId: mid, newText });
    window.cancelEditMessage(mid);
  };

  window.cancelEditMessage = (mid) => {
    const card = document.querySelector('[data-message-id="' + mid + '"]');
    if (!card) return;
    const editContainer = card.querySelector('.message-edit-container');
    if (editContainer) editContainer.remove();
    const bubble = card.querySelector('.message-bubble');
    if (bubble) bubble.style.display = 'block';
  };

  window.deleteMessage = (mid) => {
    if (!currentRoom) return;
    if (confirm('Are you sure you want to delete this message?')) {
      socket.emit('delete_message', { roomId: currentRoom.id, messageId: mid });
    }
  };

  window.toggleReaction=(mid,rid,emoji)=>socket.emit('toggle_reaction',{messageId:mid,roomId:rid,emoji});
  window.toggleEmojiPopForMessage=mid=>{ const e=['❤️','🔥','👍','😂','🚀','🎉']; socket.emit('toggle_reaction',{messageId:mid,roomId:currentRoom?.id,emoji:e[Math.floor(Math.random()*e.length)]}); };

  // --- WhatsApp-Style Reply Handlers ---
  const clearReply = () => {
    currentReplyMessage = null;
    const preview = document.getElementById('chat-reply-preview');
    if (preview) preview.style.display = 'none';
  };

  window.setReplyMessage = (mid) => {
    const card = document.querySelector('[data-message-id="' + mid + '"]');
    if (!card) return;
    const author = card.getAttribute('data-author') || card.querySelector('.message-author')?.innerText || 'User';
    const rawText = card.getAttribute('data-raw-text') || '';
    let previewText = rawText;
    if (!previewText) {
      if (card.querySelector('.message-image-embed')) previewText = '📷 [Image]';
      else if (card.querySelector('.voice-note-player')) previewText = '🎙️ [Voice Note]';
      else if (card.querySelector('.code-snippet-box')) previewText = '💻 [Code Snippet]';
      else if (card.querySelector('a')) previewText = '📎 [Attachment]';
      else previewText = '[Message]';
    }

    currentReplyMessage = {
      id: mid,
      username: author,
      text: previewText.length > 80 ? previewText.substring(0, 80) + '…' : previewText
    };

    const preview = document.getElementById('chat-reply-preview');
    const authorEl = document.getElementById('reply-preview-author');
    const textEl = document.getElementById('reply-preview-text');
    if (authorEl) authorEl.innerText = 'Replying to ' + author;
    if (textEl) textEl.innerText = currentReplyMessage.text;
    if (preview) {
      preview.style.display = 'flex';
      preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    elTextarea?.focus();
  };

  window.scrollToMessage = (mid) => {
    if (!elTimeline || !mid) return;
    const target = elTimeline.querySelector('[data-message-id="' + mid + '"]');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('highlight-pulse');
      void target.offsetWidth; // force reflow
      target.classList.add('highlight-pulse');
      setTimeout(() => target.classList.remove('highlight-pulse'), 1700);
    } else {
      showToast('Original message not found in view', 'info');
    }
  };

  document.getElementById('btn-cancel-reply')?.addEventListener('click', clearReply);

  // Chat Input
  const sendMessage=()=>{ 
    const t=elTextarea?.value.trim(); 
    if(!t||!currentRoom) return; 
    socket.emit('send_message',{
      roomId: currentRoom.id,
      text: t,
      replyTo: currentReplyMessage ? { ...currentReplyMessage } : null
    }); 
    elTextarea.value=''; 
    elTextarea.style.height='auto'; 
    clearReply();
    socket.emit('typing',{roomId:currentRoom.id,isTyping:false}); 
  };
  elSendBtn?.addEventListener('click', sendMessage);
  elTextarea?.addEventListener('keydown', e=>{ 
    if(e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape') {
      clearReply();
      closeEmojiPicker();
    }
  });
  elTextarea?.addEventListener('input', ()=>{ elTextarea.style.height='auto'; elTextarea.style.height=Math.min(elTextarea.scrollHeight,120)+'px'; if(!currentRoom) return; socket.emit('typing',{roomId:currentRoom.id,isTyping:true}); clearTimeout(typingTimeout); typingTimeout=setTimeout(()=>socket.emit('typing',{roomId:currentRoom.id,isTyping:false}),1500); });

  // Voice
  document.getElementById('btn-record-voice')?.addEventListener('click', async()=>{ document.getElementById('input-container').style.display='none'; document.getElementById('voice-recording-dock').classList.add('active'); await voiceRecorder.startRecording(document.getElementById('waveform-canvas'),document.getElementById('recording-timer')); });
  document.getElementById('btn-cancel-voice')?.addEventListener('click', ()=>{ voiceRecorder.cancelRecording(); document.getElementById('voice-recording-dock').classList.remove('active'); document.getElementById('input-container').style.display='flex'; });
  document.getElementById('btn-send-voice')?.addEventListener('click', async()=>{ 
    const r=await voiceRecorder.stopRecording(); 
    document.getElementById('voice-recording-dock').classList.remove('active'); 
    document.getElementById('input-container').style.display='flex'; 
    if(r?.blob&&currentRoom){
      const fd=new FormData();
      fd.append('file',r.blob,'voice.webm');
      try{
        const res=await fetch('/api/upload',{method:'POST',body:fd});
        const d=await res.json();
        socket.emit('send_message',{
          roomId:currentRoom.id,
          text:'',
          voiceNote:{url:d.url,duration:r.duration||3},
          replyTo: currentReplyMessage ? { ...currentReplyMessage } : null
        });
        clearReply();
      }catch(e){showToast('Upload failed','error');}
    } 
  });

  // File Attach
  document.getElementById('btn-attach-file')?.addEventListener('click', ()=>document.getElementById('file-input')?.click());
  document.getElementById('file-input')?.addEventListener('change', async()=>{ 
    const fi=document.getElementById('file-input'); 
    if(!fi?.files?.length||!currentRoom) return; 
    const f=fi.files[0]; 
    const fd=new FormData(); 
    fd.append('file',f); 
    try{
      const res=await fetch('/api/upload',{method:'POST',body:fd});
      const d=await res.json();
      socket.emit('send_message',{
        roomId:currentRoom.id,
        text:'Shared: **'+f.name+'**',
        attachment:d,
        replyTo: currentReplyMessage ? { ...currentReplyMessage } : null
      });
      fi.value='';
      clearReply();
    }catch(e){showToast('Upload failed','error');} 
  });

  // Emoji Picker
  const emojiPicker = document.getElementById('emoji-picker');
  const emojiToggleBtn = document.getElementById('btn-emoji-toggle');
  const closeEmojiBtn = document.getElementById('btn-close-emojis');

  const toggleEmojiPicker = (e) => {
    e?.stopPropagation();
    if (emojiPicker) {
      const isOpen = emojiPicker.classList.contains('active') || emojiPicker.classList.contains('open');
      if (isOpen) {
        emojiPicker.classList.remove('active', 'open');
      } else {
        emojiPicker.classList.add('active', 'open');
      }
    }
  };

  const closeEmojiPicker = () => {
    emojiPicker?.classList.remove('active', 'open');
  };

  emojiToggleBtn?.addEventListener('click', toggleEmojiPicker);
  closeEmojiBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeEmojiPicker();
  });

  document.querySelectorAll('.emoji-option').forEach(e => {
    e.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const emoji = e.innerText.trim();
      if (elTextarea) {
        const start = elTextarea.selectionStart !== undefined ? elTextarea.selectionStart : elTextarea.value.length;
        const end = elTextarea.selectionEnd !== undefined ? elTextarea.selectionEnd : elTextarea.value.length;
        const text = elTextarea.value;
        elTextarea.value = text.substring(0, start) + emoji + text.substring(end);
        elTextarea.selectionStart = elTextarea.selectionEnd = start + emoji.length;
        elTextarea.focus();
        elTextarea.dispatchEvent(new Event('input'));
      }
      closeEmojiPicker();
    });
  });

  document.addEventListener('click', (e) => {
    if (emojiPicker?.classList.contains('active') || emojiPicker?.classList.contains('open')) {
      if (!emojiPicker.contains(e.target) && e.target !== emojiToggleBtn && !emojiToggleBtn?.contains(e.target)) {
        closeEmojiPicker();
      }
    }
  });
  document.getElementById('btn-code-modal')?.addEventListener('click', ()=>{ if(currentRoom) switchViewMode('code'); else showToast('Join a room first','info'); });

  // Create Room Modal
  document.getElementById('btn-create-room-modal')?.addEventListener('click', ()=>openModal(modalCreateRoom));
  document.getElementById('btn-close-room-modal')?.addEventListener('click', ()=>closeModal(modalCreateRoom));
  document.getElementById('btn-confirm-create-room')?.addEventListener('click', ()=>{
    console.log("Create room button clicked!");
    if (!socket.connected) {
      showToast('You are offline! Please refresh the page.', 'error');
      return;
    }
    const name=document.getElementById('input-room-name')?.value.trim(); 
    if(!name){showToast('Please enter a room name','error');return;}
    const payload={name,password:document.getElementById('input-room-passcode')?.value.trim()||'',icon:document.getElementById('input-room-icon')?.value.trim()||'⚡',description:document.getElementById('input-room-desc')?.value.trim()||'',language:document.getElementById('input-room-language')?.value||'python',tags:[document.getElementById('input-room-language')?.value||'python','code']};
    console.log("Emitting create_room with payload:", payload);
    socket.emit('create_room',payload);
    closeModal(modalCreateRoom); ['input-room-name','input-room-passcode','input-room-desc'].forEach(id=>{const el=document.getElementById(id);if(el) el.value='';});
  });

  // Profile Modal
  document.getElementById('btn-edit-profile')?.addEventListener('click', ()=>{ 
    document.getElementById('input-profile-username').value=currentUser.username; 
    document.getElementById('input-profile-avatar').value=currentUser.avatar; 
    document.getElementById('input-profile-status').value=currentUser.customStatus||''; 
    const badgeSelect = document.getElementById('input-profile-badge');
    if (badgeSelect) badgeSelect.value = currentUser.badge || '';
    openModal(modalEditProfile); 
  });
  document.getElementById('btn-close-profile-modal')?.addEventListener('click', ()=>closeModal(modalEditProfile));
  document.getElementById('btn-save-profile')?.addEventListener('click', ()=>{ 
    const n=document.getElementById('input-profile-username')?.value.trim(); 
    if(n){
      currentUser.username=n;
      currentUser.avatar=document.getElementById('input-profile-avatar')?.value.trim()||'⚡';
      currentUser.customStatus=document.getElementById('input-profile-status')?.value.trim()||'';
      currentUser.badge=document.getElementById('input-profile-badge')?.value||'';
      socket.emit('update_profile',{
        status:'online',
        customStatus:currentUser.customStatus,
        avatar:currentUser.avatar,
        badge:currentUser.badge
      });
      updateUserProfileUI();
    } 
    closeModal(modalEditProfile); 
    showToast('Profile saved!','success'); 
  });

  // Misc
  document.getElementById('btn-clear-chat')?.addEventListener('click', ()=>{if(elTimeline) elTimeline.innerHTML='';});
  document.getElementById('btn-start-call')?.addEventListener('click', ()=>{ 
    if(!currentRoom){showToast('Join a room first','info');return;}
    mediaCallManager.startCall(currentRoom.id, currentUser);
  });

  // Logout / Switch Account
  const handleLogout = async () => {
    try {
      if (currentUser.username) {
        await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser.username, sessionId: currentUser.sessionId })
        });
        socket.emit('user_logout');
      }
    } catch (e) {}
    sessionStorage.removeItem('pulsechat_session');
    localStorage.removeItem('pulsechat_user');
    currentUser.username = '';
    currentUser.token = '';
    currentUser.sessionId = '';
    currentUser.isAdmin = false;
    window.location.reload();
  };
  document.getElementById('lobby-btn-logout')?.addEventListener('click', handleLogout);
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

  // --- Profile Dropdown Menu Logic ---
  const profileMenu = document.getElementById('profile-dropdown-menu');
  let activeProfileTrigger = null;

  const openProfileMenu = (triggerEl) => {
    if (!profileMenu) return;
    activeProfileTrigger = triggerEl;
    triggerEl.classList.add('active');

    // Admin Dashboard Shortcut: ONLY shown to main admin
    const adminBtn = document.getElementById('menu-btn-admin-shortcut');
    if (adminBtn) {
      const isMainAdmin = !!currentUser.isAdmin || (currentUser.username && (currentUser.username.toLowerCase() === 'karan singh' || currentUser.username.toLowerCase() === 'admin'));
      adminBtn.style.display = isMainAdmin ? 'flex' : 'none';
    }

    // Sync theme chip states
    document.querySelectorAll('.profile-theme-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.themeId === currentTheme);
    });

    // Position menu below trigger
    const rect = triggerEl.getBoundingClientRect();
    profileMenu.style.display = 'flex';
    profileMenu.style.top = (rect.bottom + 8) + 'px';

    if (rect.right > window.innerWidth - 300) {
      profileMenu.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';
      profileMenu.style.left = 'auto';
    } else {
      profileMenu.style.left = Math.max(12, rect.left) + 'px';
      profileMenu.style.right = 'auto';
    }
  };

  const closeProfileMenu = () => {
    if (!profileMenu) return;
    profileMenu.style.display = 'none';
    if (activeProfileTrigger) {
      activeProfileTrigger.classList.remove('active');
      activeProfileTrigger = null;
    }
  };

  const toggleProfileMenu = (triggerEl, e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (profileMenu && profileMenu.style.display === 'flex' && activeProfileTrigger === triggerEl) {
      closeProfileMenu();
    } else {
      openProfileMenu(triggerEl);
    }
  };

  document.getElementById('lobby-btn-profile')?.addEventListener('click', (e) => toggleProfileMenu(e.currentTarget, e));
  document.getElementById('chat-btn-profile')?.addEventListener('click', (e) => toggleProfileMenu(e.currentTarget, e));
  document.getElementById('profile-badge')?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-edit-profile') || e.target.closest('#btn-logout')) return;
    toggleProfileMenu(e.currentTarget, e);
  });

  // Close when clicking outside or pressing Escape
  document.addEventListener('click', (e) => {
    if (profileMenu && profileMenu.style.display === 'flex') {
      if (!profileMenu.contains(e.target) && !e.target.closest('.btn-profile-trigger') && !e.target.closest('#profile-badge')) {
        closeProfileMenu();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && profileMenu && profileMenu.style.display === 'flex') {
      closeProfileMenu();
    }
  });

  // Profile Menu: Account Button
  document.getElementById('menu-btn-account')?.addEventListener('click', () => {
    closeProfileMenu();
    document.getElementById('btn-edit-profile')?.click();
  });

  // Profile Menu: Theme Chips
  document.querySelectorAll('.profile-theme-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const tid = e.currentTarget.dataset.themeId;
      if (tid) applyTheme(tid);
    });
  });

  // Profile Menu: Sound Effects Toggle
  let isSoundEnabled = localStorage.getItem('pulsechat_sound') !== 'false';
  const updateSoundUI = () => {
    const pill = document.getElementById('menu-sound-pill');
    const sub = document.getElementById('menu-sound-sub');
    const icon = document.getElementById('menu-sound-icon');
    if (pill) {
      pill.className = 'menu-toggle-pill ' + (isSoundEnabled ? 'on' : 'off');
      pill.innerText = isSoundEnabled ? 'ON' : 'OFF';
    }
    if (sub) sub.innerText = isSoundEnabled ? 'Message chimes enabled' : 'Muted';
    if (icon) icon.innerText = isSoundEnabled ? '🔔' : '🔕';
  };
  updateSoundUI();

  document.getElementById('menu-btn-sound')?.addEventListener('click', () => {
    isSoundEnabled = !isSoundEnabled;
    localStorage.setItem('pulsechat_sound', isSoundEnabled ? 'true' : 'false');
    updateSoundUI();
    showToast(isSoundEnabled ? 'Sound effects enabled' : 'Sound effects muted', 'info');
  });

  // Admin Dashboard Logic - strictly restricted to Main Admin
  const modalAdminDashboard = document.getElementById('modal-admin-dashboard');
  const openAdminPanel = () => {
    const isMainAdmin = !!currentUser.isAdmin || (currentUser.username && (currentUser.username.toLowerCase() === 'karan singh' || currentUser.username.toLowerCase() === 'admin'));
    if (!isMainAdmin) {
      showToast("Access denied: Main admin privileges required.", "error");
      return;
    }
    openModal(modalAdminDashboard);
    fetchAndRenderAdminUsers();
  };

  // Profile Menu: Admin Shortcut
  document.getElementById('menu-btn-admin-shortcut')?.addEventListener('click', () => {
    closeProfileMenu();
    openAdminPanel();
  });

  // Profile Menu: Switch Account
  const handleSwitchAccount = async () => {
    closeProfileMenu();
    try {
      if (currentUser.username) {
        await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser.username, sessionId: currentUser.sessionId })
        });
        socket.emit('user_logout');
      }
    } catch (e) {}
    sessionStorage.removeItem('pulsechat_session');
    localStorage.removeItem('pulsechat_user');
    currentUser.username = '';
    currentUser.token = '';
    currentUser.sessionId = '';
    currentUser.isAdmin = false;
    updateAuthUI();
    const authView = document.getElementById('auth-view');
    if (authView) authView.style.display = 'flex';
    showToast('Switched account mode. Please log in or sign up.', 'info');
  };
  document.getElementById('menu-btn-switch-account')?.addEventListener('click', handleSwitchAccount);

  // Profile Menu: Logout
  document.getElementById('menu-btn-logout')?.addEventListener('click', () => {
    closeProfileMenu();
    handleLogout();
  });

  // Copy Room ID
  document.getElementById('btn-copy-room-id')?.addEventListener('click', () => {
    if (currentRoom) {
      navigator.clipboard.writeText(currentRoom.id);
      showToast('Room ID copied to clipboard!', 'success');
    }
  });

  // Boot — show lobby immediately, no popup
  updateAuthUI();
  showLobbyView();

  document.getElementById('btn-close-admin-modal')?.addEventListener('click', () => {
    closeModal(modalAdminDashboard);
  });

  const fetchAndRenderAdminUsers = async () => {
    try {
      const res = await fetch('/api/admin/users', {
        headers: {
          'Content-Type': 'application/json',
          'x-user-token': currentUser.token || '',
          'x-admin-key': 'Rajput2007'
        }
      });
      if (!res.ok) {
        throw new Error("Admin privileges required");
      }
      const data = await res.json();
      const list = document.getElementById('admin-user-list');
      if (list) {
        list.innerHTML = '';
        if (!data.users || data.users.length === 0) {
          list.innerHTML = '<div style="color:var(--text-muted);">No users found.</div>';
          return;
        }
        data.users.forEach(u => {
          const div = document.createElement('div');
          div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;';
          const isMain = !!u.is_admin || (u.username && (u.username.toLowerCase() === 'karan singh' || u.username.toLowerCase() === 'admin'));
          div.innerHTML = `
            <div>
              <div style="font-weight:600;">${u.username} ${isMain ? '<span style="font-size:0.65rem; background:rgba(99,102,241,0.2); color:#818cf8; border:1px solid rgba(99,102,241,0.3); padding:1px 6px; border-radius:4px; margin-left:6px;">MAIN ADMIN</span>' : ''}</div>
              <div style="font-size:0.7rem; color:var(--text-muted);">ID: ${u.id} | Created: ${new Date(u.created_at).toLocaleString()}</div>
            </div>
            ${!isMain ? `<button class="btn-delete-user" data-id="${u.id}" style="background:rgba(239,68,68,0.2); color:#ef4444; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">Delete</button>` : ''}
          `;
          list.appendChild(div);
        });
        
        document.querySelectorAll('.btn-delete-user').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            if (confirm("Are you sure you want to delete this user?")) {
              const id = e.target.getAttribute('data-id');
              const delRes = await fetch(`/api/admin/users/${id}`, {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json',
                  'x-user-token': currentUser.token || '',
                  'x-admin-key': 'Rajput2007'
                }
              });
              if (delRes.ok) {
                showToast("User deleted.", "success");
                fetchAndRenderAdminUsers();
              } else {
                showToast("Failed to delete user.", "error");
              }
            }
          });
        });
      }
    } catch (err) {
      console.error(err);
      showToast("Failed to fetch users", "error");
    }
  };
});
