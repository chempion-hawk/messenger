// === КОНФИГУРАЦИЯ ===
const API_URL = 'http://localhost:5000';
let ws = null;

// === ДАННЫЕ ===
let currentUser = null;
let currentChat = null;
let allUsers = [];
let userChats = [];

// === ИНИЦИАЛИЗАЦИЯ ===
document.addEventListener('DOMContentLoaded', async () => {
    initializeEventListeners();
    await loadAuthData();
});

// === СЛУШАТЕЛИ СОБЫТИЙ ===

function initializeEventListeners() {
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('registerForm').addEventListener('submit', handleRegister);
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => switchTab(e.target.dataset.tab, e.target));
    });
    
    document.getElementById('newChatBtn').addEventListener('click', openNewChatModal);
    document.getElementById('searchInput').addEventListener('input', searchChats);
    document.getElementById('messageInput').addEventListener('keydown', handleMessageInput);
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('attachBtn').addEventListener('click', openFileModal);
    
    document.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.target.closest('.modal').classList.add('modal-hidden');
        });
    });
}

// === АВТОРИЗАЦИЯ ===

async function handleLogin(e) {
    e.preventDefault();
    
    const username = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    
    if (!username || !password) {
        alert('Заполните все поля');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            currentUser = data.user;
            localStorage.setItem('user', JSON.stringify(currentUser));
            localStorage.setItem('sessionId', data.session_id);
            
            showMessenger();
            await connectWebSocket(data.session_id);
            await loadChats();
            await loadAllUsers();
            
            document.getElementById('loginForm').reset();
        } else {
            alert(data.error || 'Ошибка входа');
        }
    } catch (error) {
        console.error('Login error:', error);
        alert('Ошибка подключения к серверу');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    
    const username = document.getElementById('registerUsername').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
    
    if (!username || !email || !password) {
        alert('Заполните все поля');
        return;
    }
    
    if (password !== passwordConfirm) {
        alert('Пароли не совпадают');
        return;
    }
    
    if (username.length < 3) {
        alert('Username должен быть минимум 3 символа');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/users/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            alert('✅ Регистрация успешна!  Теперь войдите.');
            switchTab('login');
            document.getElementById('loginEmail').value = username;
            document.getElementById('registerForm').reset();
        } else {
            alert(data.error || 'Ошибка регистрации');
        }
    } catch (error) {
        console.error('Register error:', error);
        alert('Ошибка подключения к серверу');
    }
}

async function loadAuthData() {
    const user = localStorage.getItem('user');
    const sessionId = localStorage.getItem('sessionId');
    
    if (user && sessionId) {
        currentUser = JSON.parse(user);
        showMessenger();
        await connectWebSocket(sessionId);
        await loadChats();
        await loadAllUsers();
    }
}

// === ЭКРАНЫ ===

function showMessenger() {
    document.getElementById('authScreen').classList.add('messenger-hidden');
    document.getElementById('messengerScreen').classList.remove('messenger-hidden');
}

function switchTab(tabName, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    
    btn.classList.add('active');
    document.getElementById(tabName + 'Form').classList.add('active');
}

// === WEBSOCKET ===

async function connectWebSocket(sessionId) {
    return new Promise((resolve) => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.hostname}:5000/ws/${sessionId}`;
        
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('✅ WebSocket подключен');
            updateConnectionStatus(true);
            
            if (currentChat) {
                ws.send(JSON.stringify({
                    type: 'user_join',
                    username: currentUser.username,
                    chat_id: currentChat.id
                }));
            }
            
            resolve();
        };
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        };
        
        ws.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
            updateConnectionStatus(false);
        };
        
        ws.onclose = () => {
            console.log('⚠️ WebSocket отключен. Переподключение...');
            updateConnectionStatus(false);
            setTimeout(() => connectWebSocket(sessionId), 3000);
        };
    });
}

function handleWebSocketMessage(message) {
    const { type, data } = message;
    
    if (type === 'new_message' && currentChat && data.chat_id === currentChat.id) {
        displayMessage(data);
    } else if (type === 'user_joined') {
        console.log(`✅ ${data.username} присоединился к чату`);
    } else if (type === 'user_typing') {
        if (data.is_typing && data.username !== currentUser.username) {
            document.getElementById('typingIndicator').classList.remove('typing-hidden');
            document.getElementById('typingIndicator').textContent = `${data.username} печатает...`;
        } else {
            document.getElementById('typingIndicator').classList.add('typing-hidden');
        }
    }
}

// === ОБНОВЛЕНИЕ СТАТУСА СОЕДИНЕНИЯ ===

function updateConnectionStatus(isConnected) {
    let statusElement = document.getElementById('connectionStatus');
    
    if (! statusElement) {
        const header = document.querySelector('.sidebar-header');
        statusElement = document.createElement('div');
        statusElement.id = 'connectionStatus';
        header.appendChild(statusElement);
    }
    
    if (isConnected) {
        statusElement.className = 'connection-status online';
        statusElement.innerHTML = '🟢 Online';
        statusElement.title = 'Подключено к серверу';
    } else {
        statusElement.className = 'connection-status offline';
        statusElement.innerHTML = '🔴 Offline';
        statusElement.title = 'Нет соединения с сервером';
    }
}

// === ЗАГРУЗКА ДАННЫХ ===

async function loadChats() {
    try {
        const response = await fetch(`${API_URL}/api/chats/${currentUser.username}`);
        if (response.ok) {
            userChats = await response.json();
            renderChatsList();
        }
    } catch (error) {
        console.error('❌ Load chats error:', error);
    }
}

async function loadAllUsers() {
    try {
        const response = await fetch(`${API_URL}/api/users`);
        if (response.ok) {
            allUsers = await response.json();
            allUsers = allUsers.filter(u => u.username !== currentUser.username);
        }
    } catch (error) {
        console.error('❌ Load users error:', error);
    }
}

// === РЕНДЕРИНГ ЧАТОВ ===

function renderChatsList() {
    const chatsList = document.getElementById('chatsList');
    chatsList.innerHTML = '';
    
    userChats.forEach(chat => {
        const chatItem = createChatItem(chat);
        chatItem.addEventListener('click', () => openChat(chat));
        chatsList.appendChild(chatItem);
    });
}

function createChatItem(chat) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (currentChat?.id === chat.id ?  ' active' : '');
    
    const chatName = chat.type === 'private' 
        ? chat.participants.find(p => p !== currentUser.username) 
        : chat.name;
    
    div.innerHTML = `
        <img src="${chat.avatar}" class="avatar" alt="">
        <div class="info">
            <span class="name">${chatName}</span>
            <span class="preview">${chat.type === 'group' ? '👥 Группа' : '👤 Приватный'}</span>
        </div>
        <span class="time">Сейчас</span>
    `;
    return div;
}

// === ОТКРЫТИЕ ЧАТА ===

async function openChat(chat) {
    currentChat = chat;
    
    const chatName = chat.type === 'private' 
        ? chat.participants.find(p => p !== currentUser.username) 
        : chat.name;
    
    document.getElementById('chatName').textContent = chatName;
    document.getElementById('chatAvatar').src = chat.avatar;
    
    if (chat.type === 'group') {
        document.getElementById('chatStatus').innerHTML = `👥 ${chat.participants.length} участников`;
    } else {
        const otherUsername = chat.participants.find(p => p !== currentUser.username);
        const otherUser = allUsers.find(u => u.username === otherUsername);
        const statusIndicator = otherUser?.status === 'online' ? '🟢 Online' : '⚫ Offline';
        document.getElementById('chatStatus').innerHTML = statusIndicator;
    }
    
    document.getElementById('messagesContainer').innerHTML = '';
    
    try {
        const response = await fetch(`${API_URL}/api/messages/${chat.id}`);
        if (response.ok) {
            const messages = await response.json();
            messages.forEach(msg => displayMessage(msg));
        }
    } catch (error) {
        console.error('❌ Load messages error:', error);
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'user_join',
            username: currentUser.username,
            chat_id: chat.id
        }));
    }
    
    renderChatsList();
}

// === ОТПРАВКА СООБЩЕНИЙ ===

function handleMessageInput(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

async function sendMessage() {
    const text = document.getElementById('messageInput').value.trim();
    
    if (!text || !currentChat) return;
    
    const message = {
        type: 'send_message',
        sender_username: currentUser.username,
        chat_id: currentChat.id,
        message_type: 'text',
        text: text
    };
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
    
    try {
        await fetch(`${API_URL}/api/messages/${currentChat.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sender_username: currentUser.username,
                type: 'text',
                text: text
            })
        });
    } catch (error) {
        console.error('❌ Send message error:', error);
    }
    
    document.getElementById('messageInput').value = '';
}

// === ОТОБРАЖЕНИЕ СООБЩЕНИЙ ===

function displayMessage(message) {
    const container = document.getElementById('messagesContainer');
    
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    const div = document.createElement('div');
    div.className = 'message ' + (message.sender_username === currentUser.username ?  'sent' : 'received');
    
    let content = '';
    switch (message.type) {
        case 'text':
            content = `<div class="message-text">${escapeHtml(message.text)}</div>`;
            break;
        case 'image':
            content = `<img src="${message.file_url}" class="message-image" alt="">`;
            break;
        case 'video':
            content = `<video controls class="message-video"><source src="${message.file_url}"></video>`;
            break;
        case 'audio':
            content = `<audio controls class="message-audio"><source src="${message.file_url}"></audio>`;
            break;
    }
    
    const time = new Date(message.timestamp).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });
    
    div.innerHTML = `
        <div class="message-content">
            ${content}
            <div class="message-time">${time}</div>
        </div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// === МОДАЛЬНЫЕ ОКНА ===

async function openNewChatModal() {
    const modal = document.getElementById('newChatModal');
    modal.classList.remove('modal-hidden');
    renderUsersList();
    renderGroupUsersList();
}

function renderUsersList() {
    const usersList = document.getElementById('usersList');
    usersList.innerHTML = '';
    
    const searchDiv = document.createElement('div');
    searchDiv.className = 'users-list';
    searchDiv.innerHTML = `
        <input type="text" id="privateUserSearch" placeholder="Введите username пользователя...">
        <div id="privateUsersGrid" class="users-grid"></div>
    `;
    usersList.appendChild(searchDiv);
    
    const grid = usersList.querySelector('#privateUsersGrid');
    
    allUsers.forEach(user => {
        const card = createUserCard(user);
        card.addEventListener('click', () => {
            createPrivateChat(user);
            document.getElementById('newChatModal').classList.add('modal-hidden');
        });
        grid.appendChild(card);
    });
    
    usersList.querySelector('#privateUserSearch').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const cards = grid.querySelectorAll('.user-card');
        cards.forEach(card => {
            const username = card.querySelector('.name').textContent.toLowerCase();
            card.style.display = username.includes(query) ? '' : 'none';
        });
    });
}

function renderGroupUsersList() {
    const usersList = document.getElementById('groupUsersList');
    usersList.innerHTML = '';
    
    allUsers.forEach(user => {
        const card = createUserCard(user);
        card.dataset.username = user.username;
        card.addEventListener('click', (e) => {
            card.classList.toggle('selected');
            updateSelectedUsers();
        });
        usersList.appendChild(card);
    });
}

function createUserCard(user) {
    const div = document.createElement('div');
    div.className = 'user-card';
    div.innerHTML = `
        <img src="${user.avatar}" class="avatar" alt="">
        <div class="name">${user.username}</div>
        <div class="status">${user.status === 'online' ? '🟢 Online' : '⚫ Offline'}</div>
    `;
    return div;
}

function updateSelectedUsers() {
    const selected = document.querySelectorAll('#groupUsersList .user-card.selected');
    const container = document.getElementById('selectedUsers');
    container.innerHTML = '';
    
    selected.forEach(card => {
        const username = card.dataset.username;
        const user = allUsers.find(u => u.username === username);
        if (user) {
            const tag = document.createElement('div');
            tag.className = 'selected-user-tag';
            tag.innerHTML = `
                ${user.username}
                <button type="button">×</button>
            `;
            tag.querySelector('button').addEventListener('click', () => {
                card.classList.remove('selected');
                updateSelectedUsers();
            });
            container.appendChild(tag);
        }
    });
}

async function createPrivateChat(user) {
    try {
        const response = await fetch(`${API_URL}/api/chats/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'private',
                participants: [currentUser.username, user.username],
                name: ''
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            userChats.push(data.chat);
            renderChatsList();
            await openChat(data.chat);
        } else {
            const err = await response.json();
            alert(err.error || 'Ошибка создания чата');
        }
    } catch (error) {
        console.error('❌ Create chat error:', error);
        alert('Ошибка подключения');
    }
}

async function createGroup() {
    const name = document.getElementById('groupName').value.trim();
    const selected = document.querySelectorAll('#groupUsersList .user-card.selected');
    
    if (! name || selected.length === 0) {
        alert('Введите название и выберите участников');
        return;
    }
    
    const participants = [currentUser.username];
    selected.forEach(card => {
        participants.push(card.dataset.username);
    });
    
    try {
        const response = await fetch(`${API_URL}/api/chats/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'group',
                participants: participants,
                name: name
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            userChats.push(data.chat);
            renderChatsList();
            await openChat(data.chat);
            document.getElementById('newChatModal').classList.add('modal-hidden');
            document.getElementById('groupName').value = '';
        } else {
            const err = await response.json();
            alert(err.error || 'Ошибка создания группы');
        }
    } catch (error) {
        console.error('❌ Create group error:', error);
        alert('Ошибка подключения');
    }
}

// === ПОИСК ===

function searchChats(e) {
    const query = e.target.value.toLowerCase();
    const items = document.querySelectorAll('.chat-item');
    
    items.forEach(item => {
        const name = item.querySelector('.name').textContent.toLowerCase();
        item.style.display = name.includes(query) ? '' : 'none';
    });
}

// === РАБОТА С ФАЙЛАМИ ===

function openFileModal() {
    document.getElementById('fileModal').classList.remove('modal-hidden');
}

document.querySelectorAll('.file-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('fileInput').click();
    });
});

// === УТИЛИТЫ ===

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// === ОБНОВЛЕНИЕ РАЗМЕРА ТЕКСТАРЕИ ===

const textarea = document.getElementById('messageInput');
if (textarea) {
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
    });
}

// === ИНИЦИАЛИЗАЦИЯ ГРУПП ===

document.getElementById('createGroupBtn')?.addEventListener('click', createGroup);

document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (e.target.closest('.create-tabs')) {
            document.querySelectorAll('.create-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById(e.target.dataset.tab + 'Tab').classList.add('active');
        }
    });
});

// === ОТПРАВКА СТАТУСА OFFLINE ПРИ ВЫХОДЕ ===

window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'user_disconnect',
            username: currentUser.username
        }));
    }
});