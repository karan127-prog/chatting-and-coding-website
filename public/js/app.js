/**
 * PulseChat Core Application Controller
 * Flow: Lobby loads immediately. Name only asked when joining/creating a room.
 */
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Global Theme Customizer
  const themeSelect = document.getElementById('global-theme-select');
  const savedTheme = localStorage.getItem('pulsechat_theme') || 'aurora';
  document.body.setAttribute('data-theme', savedTheme);
  if (themeSelect) {
    themeSelect.value = savedTheme;
    themeSelect.addEventListener('change', (e) => {
      document.body.setAttribute('data-theme', e.target.value);
      localStorage.setItem('pulsechat_theme', e.target.value);
    });
  }

  // State
  let currentUser = {
    username: '',
    token: '',
    avatar: ['🦊','🐼','🦁','🐸','🐵','🦄','🐰','🐶'][Math.floor(Math.random()*8)],
    status: 'online',
    customStatus: 'Coding live'
  };
  let currentRoom = null, activeRoomsList = [], pendingApprovalQueue = [];
  let isHostOfRoom = false, typingTimeout = null, _pendingJoinRoom = null;

  // --- Auth Flow ---
  const authView = document.getElementById('auth-view');
  const appContainer = document.querySelector('.app-container');
  const authError = document.getElementById('auth-error-msg');
  const storedUser = localStorage.getItem('pulsechat_user');
  
  if (storedUser) {
    try {
      const data = JSON.parse(storedUser);
      currentUser.username = data.username;
      currentUser.token = data.token;
      authView.style.display = 'none';
      socket.emit('register_user', currentUser);
      socket._registered = true;
    } catch (e) {}
  }

  const updateAuthUI = () => {
    const userContainer = document.getElementById('lobby-auth-user');
    const guestContainer = document.getElementById('lobby-auth-guest');
    if (currentUser.username) {
      if(userContainer) userContainer.style.display = 'flex';
      if(guestContainer) guestContainer.style.display = 'none';
      const b=document.getElementById('lobby-username'); if(b) b.innerText=currentUser.username;
      const av=document.getElementById('lobby-user-avatar'); if(av) av.innerText=(currentUser.username[0]||'?').toUpperCase();
    } else {
      if(userContainer) userContainer.style.display = 'none';
      if(guestContainer) guestContainer.style.display = 'flex';
    }
  };

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
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed');

      currentUser.username = data.username;
      currentUser.token = data.token;
      localStorage.setItem('pulsechat_user', JSON.stringify({ username: data.username, token: data.token }));
      
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
  document.getElementById('btn-auth-close')?.addEventListener('click', () => { authView.style.display = 'none'; });

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
    try {
      const ctx=new(window.AudioContext||window.webkitAudioContext)(),osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      if(type==='message'){ osc.frequency.setValueAtTime(587,ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(880,ctx.currentTime+0.1); gain.gain.setValueAtTime(0.07,ctx.currentTime); gain.gain.linearRampToValueAtTime(0.001,ctx.currentTime+0.15); osc.start(); osc.stop(ctx.currentTime+0.15); }
      else{ osc.frequency.setValueAtTime(880,ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(1174,ctx.currentTime+0.2); gain.gain.setValueAtTime(0.09,ctx.currentTime); gain.gain.linearRampToValueAtTime(0.001,ctx.currentTime+0.25); osc.start(); osc.stop(ctx.currentTime+0.25); }
    } catch(e) {}
  };

  // View management
  const showLobbyView = () => {
    elLobbyView.style.display = 'flex';
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
  document.getElementById('tab-my-envs')?.addEventListener('click', (e) => {
    activeLobbyTab = 'my-envs';
    e.target.classList.add('active');
    document.getElementById('tab-public-hubs')?.classList.remove('active');
    fetchAndRenderLobbyRooms();
  });
  document.getElementById('tab-public-hubs')?.addEventListener('click', (e) => {
    activeLobbyTab = 'public-hubs';
    e.target.classList.add('active');
    document.getElementById('tab-my-envs')?.classList.remove('active');
    fetchAndRenderLobbyRooms();
  });

  // Fetch & Render Lobby Rooms
  const fetchAndRenderLobbyRooms = async () => {
    const grid = document.getElementById('lobby-rooms-grid');
    if (!grid) return;

    try { 
      const res=await fetch('/api/rooms'); 
      const d=await res.json(); 
      activeRoomsList=d.rooms||activeRoomsList; 
    } catch(e) {}

    const q = (document.getElementById('lobby-room-search')?.value||'').toLowerCase().trim();
    let filtered = activeRoomsList.filter(r => {
      const n=(r.name||'').toLowerCase(), desc=(r.description||'').toLowerCase();
      const t=(Array.isArray(r.tags)?r.tags.join(' '):r.tags||'').toLowerCase();
      const m=!q||n.includes(q)||desc.includes(q)||t.includes(q);
      if(!m) return false;
      return true;
    });

    if (activeLobbyTab === 'my-envs') {
      filtered = filtered.filter(r => r.host_username === currentUser.username || r.hostUsername === currentUser.username);
    } else {
      filtered = filtered.filter(r => r.host_username !== currentUser.username && r.hostUsername !== currentUser.username);
    }

    const lbl=document.getElementById('lobby-room-count-label'); if(lbl) lbl.innerText=filtered.length+' room'+(filtered.length!==1?'s':'')+' available';
    const stat=document.getElementById('stat-active-rooms'); if(stat) stat.innerText=activeRoomsList.length;

    grid.innerHTML = '';
    if (!filtered.length) {
      grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted);"><div style="font-size:3rem;margin-bottom:16px;">🏚️</div><div style="font-size:1rem;font-weight:600;margin-bottom:8px;">No rooms yet</div><div>Create the first one!</div></div>';
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
          '<button class="btn-join-room-card">'+(prot?'🔒 Enter Password':'→ Join Room')+'</button>'+
        '</div>';
      card.querySelector('.btn-join-room-card').addEventListener('click', ()=>handleJoinRoomClick(room));
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
  document.getElementById('lobby-btn-scratchpad')?.addEventListener('click', ()=>{ if (!requireAuth()) return; socket.emit('request_join_room',{roomId:'general',password:''}); setTimeout(()=>switchViewMode('code'),400); });
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
    if(data.user) currentUser={...currentUser,...data.user};
    activeRoomsList=data.rooms||[];
    updateUserProfileUI(); renderChannelsList(activeRoomsList); renderActiveUsersList(data.activeUsers||[]);
    fetchAndRenderLobbyRooms();
    const ln=document.getElementById('lobby-username'); if(ln&&currentUser.username) ln.innerText=currentUser.username;
    const la=document.getElementById('lobby-user-avatar'); if(la) la.innerText=currentUser.avatar;
    if(socket._pendingAction){ const a=socket._pendingAction; socket._pendingAction=null; setTimeout(a,100); }
  });

  socket.on('room_switched', ({room,messages,codeWorkspace,members}) => {
    closeAllModals(); currentRoom=room; isHostOfRoom=!!room.isHost; hideLobbyView();
    if(elRoomIcon)  elRoomIcon.innerText =(room.icon||'💬');
    if(elRoomTitle) elRoomTitle.innerText='#'+room.name+(room.isHost?'  👑':'');
    if(elRoomDesc)  elRoomDesc.innerText =(room.description||'');
    renderChannelsList(activeRoomsList); renderMessages(messages||[]); renderRoomMembers(members||[]);
    if(codeWorkspace) codeStudio.loadWorkspace(codeWorkspace,room.id);
    
    // Switch view if first time entering room
    switchViewMode('chat');

    // Notify Whiteboard
    if (window.collaborativeWhiteboard) {
      window.collaborativeWhiteboard.setRoomId(currentRoom.id);
      window.collaborativeWhiteboard.clearBoard(false); // clear UI board safely
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
  socket.on('message_received', msg=>{ if(currentRoom&&msg.roomId===currentRoom.id){ appendSingleMessage(msg); scrollToBottom(); if(!msg.isSystem&&msg.user&&msg.user.id!==socket.id) playSoundEffect('message'); } });
  socket.on('reaction_updated', ({messageId,roomId,reactions})=>{ if(currentRoom&&roomId===currentRoom.id){const c=document.querySelector('[data-message-id="'+messageId+'"]');if(c){const r=c.querySelector('.reactions-row');if(r) r.innerHTML=renderReactionsHTML(messageId,roomId,reactions);}} });
  socket.on('user_typing', ({roomId,username,isTyping})=>{ if(currentRoom&&roomId===currentRoom.id){if(elTypingBar) elTypingBar.style.visibility=isTyping?'visible':'hidden';if(isTyping&&elTypingText) elTypingText.innerText=username+' is typing…';} });
  socket.on('user_status_change', ({activeUsers})=>{ renderActiveUsersList(activeUsers); const s=document.getElementById('stat-active-users');if(s) s.innerText=activeUsers.length; });

  // Renderers
  const updateUserProfileUI = () => {
    if(elCurrentAvatar)     elCurrentAvatar.innerText    =currentUser.avatar||'⚡';
    if(elCurrentUsername)   elCurrentUsername.innerText  =currentUser.username||'User';
    if(elCurrentStatusText) elCurrentStatusText.innerText=currentUser.customStatus||'Online';
  };

  const renderChannelsList = rooms => {
    if(!elChannelList) return; elChannelList.innerHTML='';
    rooms.forEach(r=>{ const li=document.createElement('li'); li.className='channel-item'+(currentRoom&&r.id===currentRoom.id?' active':''); li.innerHTML='<span class="channel-icon">'+(r.icon||'💬')+'</span><span class="channel-name">#'+r.name+'</span>'+(r.hasPassword?'<span style="font-size:11px;">🔒</span>':''); li.addEventListener('click',()=>{ if(currentRoom&&r.id===currentRoom.id) return; if(r.hasPassword) handleJoinRoomClick(r); else socket.emit('request_join_room',{roomId:r.id,password:''}); }); elChannelList.appendChild(li); });
  };

  const renderActiveUsersList = users => {
    if(!elUserList) return; elUserList.innerHTML=''; if(elUserCount) elUserCount.innerText=users.length;
    users.forEach(u=>{ const li=document.createElement('li'); li.className='user-item'; li.innerHTML='<div class="user-avatar-container" style="width:32px;height:32px;"><div class="user-avatar" style="font-size:16px;">'+(u.avatar||'⚡')+'</div><div class="status-dot '+(u.status||'online')+'"></div></div><div style="min-width:0;flex:1;"><div class="user-name" style="font-size:0.85rem;">'+u.username+'</div><div class="user-status-text" style="font-size:0.7rem;">'+(u.customStatus||'Online')+'</div></div>'; elUserList.appendChild(li); });
  };

  const renderRoomMembers = members => {
    if(!elRoomMemberList) return; elRoomMemberList.innerHTML=''; if(elRoomMemberCount) elRoomMemberCount.innerText=members.length;
    members.forEach(m=>{ const li=document.createElement('li'); li.className='user-item'; const isSelf=m.id===socket.id,canKick=isHostOfRoom&&!isSelf&&!m.isHost; li.innerHTML='<div class="user-avatar-container" style="width:28px;height:28px;"><div class="user-avatar" style="font-size:14px;">'+(m.avatar||'⚡')+'</div><div class="status-dot online"></div></div><div style="min-width:0;flex:1;"><div class="user-name" style="font-size:0.82rem;">'+m.username+(m.isHost?' <span style="font-size:10px;background:rgba(251,191,36,0.2);color:#fbbf24;padding:1px 5px;border-radius:4px;">👑</span>':'')+(isSelf?' <span style="font-size:10px;color:var(--text-muted);">(you)</span>':'')+'</div></div>'+(canKick?'<button class="btn-kick" data-mid="'+m.id+'">🚫</button>':''); if(canKick) li.querySelector('.btn-kick').addEventListener('click',e=>{e.stopPropagation();if(confirm('Kick '+m.username+'?')) socket.emit('kick_member',{roomId:currentRoom.id,memberSocketId:e.currentTarget.dataset.mid});}); elRoomMemberList.appendChild(li); });
  };

  const renderMessages = msgs=>{ if(!elTimeline) return; elTimeline.innerHTML=''; msgs.forEach(appendSingleMessage); scrollToBottom(); };
  const scrollToBottom  = ()=>{ if(elTimeline) elTimeline.scrollTop=elTimeline.scrollHeight; };
  const escapeHTML = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = t=>{ let f=escapeHTML(t); f=f.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>'); f=f.replace(/\*(.*?)\*/g,'<em>$1</em>'); f=f.replace(/`(.*?)`/g,'<code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;font-family:monospace;">$1</code>'); return f; };
  const renderReactionsHTML = (mid,rid,reactions={})=>Object.entries(reactions).filter(([,u])=>u?.length).map(([e,u])=>'<span class="reaction-pill '+(u.includes(currentUser.username)?'active':'')+'" onclick="window.toggleReaction(\''+mid+'\',\''+rid+'\',\''+e+'\')">'+e+' '+u.length+'</span>').join('');

  const appendSingleMessage = msg => {
    if(!elTimeline) return;
    if(msg.isSystem){const d=document.createElement('div');d.className='system-event-pill';d.innerHTML=fmt(msg.text||'');elTimeline.appendChild(d);return;}
    const isSelf=msg.user&&msg.user.id===socket.id;
    const card=document.createElement('div'); card.className='message-card'+(isSelf?' self':''); card.setAttribute('data-message-id',msg.id);
    const time=new Date(msg.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    let media='';
    if(msg.attachment){ if(msg.attachment.mimetype?.startsWith('image/')) media+='<img src="'+msg.attachment.url+'" class="message-image-embed" alt="img">'; else media+='<div style="margin-top:8px;"><a href="'+msg.attachment.url+'" target="_blank" style="color:var(--accent-cyan);text-decoration:underline;">📎 '+msg.attachment.filename+'</a></div>'; }
    if(msg.voiceNote) media+='<div class="voice-note-player"><button class="btn-play-voice" onclick="new Audio(\''+msg.voiceNote.url+'\').play()">▶</button><span style="font-size:0.8rem;color:var(--text-muted);">Voice ('+msg.voiceNote.duration+'s)</span></div>';
    if(msg.codeSnippet) media+='<div class="code-snippet-box"><div class="code-header"><span>'+(msg.codeSnippet.language||'code')+'</span><button style="background:transparent;border:none;color:var(--accent-cyan);cursor:pointer;" onclick="navigator.clipboard.writeText(this.closest(\'.code-snippet-box\').querySelector(\'.code-content\').innerText)">Copy</button></div><div class="code-content">'+escapeHTML(msg.codeSnippet.code)+'</div></div>';
    card.innerHTML='<div class="message-avatar">'+(msg.user?msg.user.avatar:'⚡')+'</div><div class="message-content-wrapper"><div class="message-meta"><span class="message-author">'+(msg.user?msg.user.username:'User')+'</span>'+(msg.user?.isBot?'<span class="bot-tag">BOT</span>':'')+'<span class="message-timestamp">'+time+'</span><button class="btn-add-reaction" onclick="window.toggleEmojiPopForMessage(\''+msg.id+'\')">➕</button></div><div class="message-bubble">'+(msg.text?fmt(msg.text):'')+media+'</div><div class="reactions-row">'+renderReactionsHTML(msg.id,msg.roomId,msg.reactions)+'</div></div>';
    elTimeline.appendChild(card);
  };

  window.toggleReaction=(mid,rid,emoji)=>socket.emit('toggle_reaction',{messageId:mid,roomId:rid,emoji});
  window.toggleEmojiPopForMessage=mid=>{ const e=['❤️','🔥','👍','😂','🚀','🎉']; socket.emit('toggle_reaction',{messageId:mid,roomId:currentRoom?.id,emoji:e[Math.floor(Math.random()*e.length)]}); };

  // Chat Input
  const sendMessage=()=>{ const t=elTextarea?.value.trim(); if(!t||!currentRoom) return; socket.emit('send_message',{roomId:currentRoom.id,text:t}); elTextarea.value=''; elTextarea.style.height='auto'; socket.emit('typing',{roomId:currentRoom.id,isTyping:false}); };
  elSendBtn?.addEventListener('click', sendMessage);
  elTextarea?.addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} });
  elTextarea?.addEventListener('input', ()=>{ elTextarea.style.height='auto'; elTextarea.style.height=Math.min(elTextarea.scrollHeight,120)+'px'; if(!currentRoom) return; socket.emit('typing',{roomId:currentRoom.id,isTyping:true}); clearTimeout(typingTimeout); typingTimeout=setTimeout(()=>socket.emit('typing',{roomId:currentRoom.id,isTyping:false}),1500); });

  // Voice
  document.getElementById('btn-record-voice')?.addEventListener('click', async()=>{ document.getElementById('input-container').style.display='none'; document.getElementById('voice-recording-dock').classList.add('active'); await voiceRecorder.startRecording(document.getElementById('waveform-canvas'),document.getElementById('recording-timer')); });
  document.getElementById('btn-cancel-voice')?.addEventListener('click', ()=>{ voiceRecorder.cancelRecording(); document.getElementById('voice-recording-dock').classList.remove('active'); document.getElementById('input-container').style.display='flex'; });
  document.getElementById('btn-send-voice')?.addEventListener('click', async()=>{ const r=await voiceRecorder.stopRecording(); document.getElementById('voice-recording-dock').classList.remove('active'); document.getElementById('input-container').style.display='flex'; if(r?.blob&&currentRoom){const fd=new FormData();fd.append('file',r.blob,'voice.webm');try{const res=await fetch('/api/upload',{method:'POST',body:fd});const d=await res.json();socket.emit('send_message',{roomId:currentRoom.id,text:'',voiceNote:{url:d.url,duration:r.duration||3}});}catch(e){showToast('Upload failed','error');}} });

  // File Attach
  document.getElementById('btn-attach-file')?.addEventListener('click', ()=>document.getElementById('file-input')?.click());
  document.getElementById('file-input')?.addEventListener('change', async()=>{ const fi=document.getElementById('file-input'); if(!fi?.files?.length||!currentRoom) return; const f=fi.files[0]; const fd=new FormData(); fd.append('file',f); try{const res=await fetch('/api/upload',{method:'POST',body:fd});const d=await res.json();socket.emit('send_message',{roomId:currentRoom.id,text:'Shared: **'+f.name+'**',attachment:d});fi.value='';}catch(e){showToast('Upload failed','error');} });

  // Emoji Picker
  document.getElementById('btn-emoji-toggle')?.addEventListener('click', ()=>document.getElementById('emoji-picker')?.classList.toggle('active'));
  document.querySelectorAll('.emoji-option').forEach(e=>{ e.addEventListener('click', ()=>{ if(elTextarea) elTextarea.value+=e.innerText; document.getElementById('emoji-picker')?.classList.remove('active'); elTextarea?.focus(); }); });
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
  document.getElementById('btn-edit-profile')?.addEventListener('click', ()=>{ document.getElementById('input-profile-username').value=currentUser.username; document.getElementById('input-profile-avatar').value=currentUser.avatar; document.getElementById('input-profile-status').value=currentUser.customStatus||''; openModal(modalEditProfile); });
  document.getElementById('btn-close-profile-modal')?.addEventListener('click', ()=>closeModal(modalEditProfile));
  document.getElementById('btn-save-profile')?.addEventListener('click', ()=>{ const n=document.getElementById('input-profile-username')?.value.trim(); if(n){currentUser.username=n;currentUser.avatar=document.getElementById('input-profile-avatar')?.value.trim()||'⚡';currentUser.customStatus=document.getElementById('input-profile-status')?.value.trim()||'';socket.emit('update_profile',{status:'online',customStatus:currentUser.customStatus,avatar:currentUser.avatar});updateUserProfileUI();} closeModal(modalEditProfile); showToast('Profile saved!','success'); });

  // Misc
  document.getElementById('btn-clear-chat')?.addEventListener('click', ()=>{if(elTimeline) elTimeline.innerHTML='';});
  document.getElementById('btn-start-call')?.addEventListener('click', ()=>{ 
    if(!currentRoom){showToast('Join a room first','info');return;}
    mediaCallManager.startCall(currentRoom.id, currentUser);
  });

  // Logout / Switch Account
  const handleLogout = () => {
    localStorage.removeItem('pulsechat_user');
    window.location.reload();
  };
  document.getElementById('lobby-btn-logout')?.addEventListener('click', handleLogout);
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

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
});
