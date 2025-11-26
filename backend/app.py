import aiohttp
from aiohttp import web
import asyncio
import json
import os
from datetime import datetime
from dotenv import load_dotenv
import uuid
import logging
import aiosqlite
from hashlib import sha256

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# === DATABASE CONFIG ===
DB_PATH = os.getenv('DB_PATH', 'messenger.db')

db = None
user_sessions = {}
active_connections = {}

def generate_id():
    return str(uuid.uuid4())

def hash_password(password):
    """Хешировать пароль"""
    return sha256(password.encode()).hexdigest()

async def init_db():
    """Инициализация базы данных"""
    global db
    
    try:
        db = await aiosqlite.connect(DB_PATH)
        db.row_factory = aiosqlite.Row
        logger.info(f"✅ Database connected: {DB_PATH}")
        
        # Создаём таблицы если их нет
        await db.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                avatar TEXT,
                status TEXT DEFAULT 'offline',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        await db.execute('''
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT,
                avatar TEXT,
                creator_id TEXT REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        await db.execute('''
            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (chat_id, user_id)
            )
        ''')
        
        await db.execute('''
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
                sender_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                type TEXT DEFAULT 'text',
                text TEXT,
                file_url TEXT,
                filename TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        await db.commit()
        logger.info("✅ Database tables initialized")
    except Exception as e:
        logger.error(f"❌ Database initialization error: {e}")
        raise

async def broadcast_to_chat(chat_id, event_type, data):
    """Отправить сообщение всем участникам чата"""
    try:
        cursor = await db.execute(
            'SELECT user_id FROM chat_participants WHERE chat_id = ?',
            (chat_id,)
        )
        participants = await cursor.fetchall()
        
        participant_ids = [p['user_id'] for p in participants]
        
        for user_id in participant_ids:
            session_ids = [sid for sid, uid in user_sessions.items() if uid == user_id]
            for session_id in session_ids:
                ws = active_connections.get(session_id)
                if ws and not ws.closed:
                    try:
                        await ws.send_json({
                            'type': event_type,
                            'data': data
                        })
                    except Exception as e:
                        logger.error(f"Error sending message: {e}")
    except Exception as e:
        logger.error(f"Broadcast error: {e}")

# === REST API ===

async def register(request):
    """Регистрация пользователя"""
    try:
        data = await request.json()
        username = data.get('username', '').strip()
        email = data.get('email', '').strip()
        password = data.get('password', '')
        
        if not username or not email or not password:
            return web.json_response({'error': 'Все поля обязательны'}, status=400)
        
        if len(username) < 3:
            return web.json_response({'error': 'Username минимум 3 символа'}, status=400)
        
        user_id = generate_id()
        password_hash = hash_password(password)
        avatar = f'https://ui-avatars.com/api/? name={username}&background=667eea&color=fff'
        
        try:
            await db.execute('''
                INSERT INTO users (id, username, email, password_hash, avatar, status)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (user_id, username, email, password_hash, avatar, 'offline'))
            await db.commit()
            
            logger.info(f"✅ User registered: {username}")
            
            return web.json_response({
                'success': True,
                'user': {
                    'id': user_id,
                    'username': username,
                    'email': email,
                    'avatar': avatar
                }
            }, status=201)
        except aiosqlite.IntegrityError:
            return web.json_response(
                {'error': 'Этот username или email уже зарегистрирован'},
                status=409
            )
    except Exception as e:
        logger.error(f"Register error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def login(request):
    """Вход пользователя"""
    try:
        data = await request.json()
        username = data.get('username', '').strip()
        password = data.get('password', '')
        
        if not username or not password:
            return web.json_response({'error': 'Username и пароль обязательны'}, status=400)
        
        password_hash = hash_password(password)
        
        cursor = await db.execute(
            'SELECT id, username, email, avatar, status FROM users WHERE username = ?  AND password_hash = ?',
            (username, password_hash)
        )
        user = await cursor.fetchone()
        
        if not user:
            return web.json_response({'error': 'Неверный username или пароль'}, status=401)
        
        # Обновляем статус на online
        await db.execute('UPDATE users SET status = ? WHERE id = ?', ('online', user['id']))
        await db.commit()
        
        session_id = generate_id()
        user_sessions[session_id] = user['id']
        
        logger.info(f"✅ User logged in: {username}")
        
        return web.json_response({
            'success': True,
            'session_id': session_id,
            'user': {
                'id': user['id'],
                'username': user['username'],
                'email': user['email'],
                'avatar': user['avatar'],
                'status': 'online'
            }
        }, status=200)
    except Exception as e:
        logger.error(f"Login error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def get_all_users(request):
    """Получить всех пользователей"""
    try:
        cursor = await db.execute('SELECT id, username, email, avatar, status FROM users')
        users = await cursor.fetchall()
        
        users_list = [
            {
                'id': user['id'],
                'username': user['username'],
                'email': user['email'],
                'avatar': user['avatar'],
                'status': user['status']
            }
            for user in users
        ]
        return web.json_response(users_list, status=200)
    except Exception as e:
        logger.error(f"Get users error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def search_user(request):
    """Найти пользователя по username"""
    try:
        username = request.match_info.get('username', '').strip()
        
        if not username:
            return web.json_response({'error': 'Username не указан'}, status=400)
        
        cursor = await db.execute(
            'SELECT id, username, email, avatar, status FROM users WHERE username = ?',
            (username,)
        )
        user = await cursor.fetchone()
        
        if not user:
            return web.json_response({'error': 'Пользователь не найден'}, status=404)
        
        return web.json_response({
            'success': True,
            'user': {
                'id': user['id'],
                'username': user['username'],
                'avatar': user['avatar'],
                'status': user['status']
            }
        }, status=200)
    except Exception as e:
        logger.error(f"Search user error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def create_chat(request):
    """Создать чат"""
    try:
        data = await request.json()
        chat_type = data.get('type')
        participants = data.get('participants', [])
        name = data.get('name', '')
        
        if not participants:
            return web.json_response({'error': 'Нет участников'}, status=400)
        
        chat_id = generate_id()
        creator_username = participants[0]
        avatar = f'https://ui-avatars.com/api/? name={name}&background=667eea&color=fff' if name else ''
        
        try:
            # Получаем ID создателя
            cursor = await db.execute(
                'SELECT id FROM users WHERE username = ?',
                (creator_username,)
            )
            creator = await cursor.fetchone()
            
            if not creator:
                return web.json_response({'error': 'Создатель не найден'}, status=404)
            
            # Создаём чат
            await db.execute('''
                INSERT INTO chats (id, type, name, avatar, creator_id)
                VALUES (?, ?, ?, ?, ?)
            ''', (chat_id, chat_type, name if name else None, avatar if avatar else None, creator['id']))
            
            # Добавляем участников
            for username in participants:
                cursor = await db.execute(
                    'SELECT id FROM users WHERE username = ?',
                    (username,)
                )
                user = await cursor.fetchone()
                
                if not user:
                    return web.json_response(
                        {'error': f'Пользователь {username} не найден'},
                        status=404
                    )
                
                await db.execute(
                    'INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)',
                    (chat_id, user['id'])
                )
            
            await db.commit()
            logger.info(f"✅ Chat created: {chat_id}")
            
            return web.json_response({
                'success': True,
                'chat': {
                    'id': chat_id,
                    'type': chat_type,
                    'participants': participants,
                    'name': name,
                    'avatar': avatar,
                    'created_at': datetime.now().isoformat()
                }
            }, status=201)
        except aiosqlite.Error as e:
            logger.error(f"Database error: {e}")
            return web.json_response({'error': 'Ошибка создания чата'}, status=500)
    except Exception as e:
        logger.error(f"Create chat error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def get_user_chats(request):
    """Получить чаты пользователя"""
    try:
        username = request.match_info['username']
        
        cursor = await db.execute('SELECT id FROM users WHERE username = ?', (username,))
        user = await cursor.fetchone()
        
        if not user:
            return web.json_response({'error': 'Пользователь не найден'}, status=404)
        
        cursor = await db.execute('''
            SELECT c.id, c.type, c.name, c.avatar, c.created_at
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE cp.user_id = ? 
        ''', (user['id'],))
        chats = await cursor.fetchall()
        
        chats_list = []
        for chat in chats:
            cursor = await db.execute(
                'SELECT u.username FROM chat_participants cp JOIN users u ON cp.user_id = u.id WHERE cp.chat_id = ? ',
                (chat['id'],)
            )
            participants = await cursor.fetchall()
            
            chats_list.append({
                'id': chat['id'],
                'type': chat['type'],
                'name': chat['name'],
                'avatar': chat['avatar'],
                'participants': [p['username'] for p in participants],
                'created_at': chat['created_at'] if chat['created_at'] else None
            })
        
        return web.json_response(chats_list, status=200)
    except Exception as e:
        logger.error(f"Get chats error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def get_messages(request):
    """Получить сообщения чата"""
    try:
        chat_id = request.match_info['chat_id']
        
        cursor = await db.execute('''
            SELECT m.id, m.chat_id, u.username as sender_username, m.type, m.text, m.file_url, m.filename, m.created_at
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.chat_id = ?
            ORDER BY m.created_at ASC
        ''', (chat_id,))
        messages = await cursor.fetchall()
        
        messages_list = [
            {
                'id': msg['id'],
                'chat_id': msg['chat_id'],
                'sender_username': msg['sender_username'],
                'type': msg['type'],
                'text': msg['text'],
                'file_url': msg['file_url'],
                'filename': msg['filename'],
                'timestamp': msg['created_at'] if msg['created_at'] else None
            }
            for msg in messages
        ]
        
        return web.json_response(messages_list, status=200)
    except Exception as e:
        logger.error(f"Get messages error: {e}")
        return web.json_response({'error': str(e)}, status=500)

async def send_message(request):
    """Отправить сообщение через REST"""
    try:
        chat_id = request.match_info['chat_id']
        data = await request.json()
        
        sender_username = data.get('sender_username')
        text = data.get('text', '')
        msg_type = data.get('type', 'text')
        file_url = data.get('file_url', '')
        filename = data.get('filename', '')
        
        message_id = generate_id()
        
        cursor = await db.execute('SELECT id FROM users WHERE username = ? ', (sender_username,))
        sender = await cursor.fetchone()
        
        if not sender:
            return web.json_response({'error': 'Отправитель не найден'}, status=404)
        
        await db.execute('''
            INSERT INTO messages (id, chat_id, sender_id, type, text, file_url, filename)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (message_id, chat_id, sender['id'], msg_type, text if text else None, file_url if file_url else None, filename if filename else None))
        await db.commit()
        
        message = {
            'id': message_id,
            'chat_id': chat_id,
            'sender_username': sender_username,
            'type': msg_type,
            'text': text,
            'file_url': file_url,
            'filename': filename,
            'timestamp': datetime.now().isoformat()
        }
        
        await broadcast_to_chat(chat_id, 'new_message', message)
        
        logger.info(f"✅ Message sent: {message_id}")
        return web.json_response(message, status=201)
    except Exception as e:
        logger.error(f"Send message error: {e}")
        return web.json_response({'error': str(e)}, status=500)

# === WEBSOCKET ===

async def websocket_handler(request):
    """WebSocket обработчик"""
    session_id = request.match_info['session_id']
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    active_connections[session_id] = ws
    logger.info(f"✅ WebSocket connected: {session_id}")
    
    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    await handle_websocket_message(data, session_id, ws)
                except json.JSONDecodeError:
                    logger.error("Invalid JSON received")
            elif msg.type == aiohttp.WSMsgType.ERROR:
                logger.error(f"WebSocket error: {ws.exception()}")
    finally:
        active_connections.pop(session_id, None)
        logger.info(f"⚠️ WebSocket disconnected: {session_id}")
    
    return ws

async def handle_websocket_message(data, session_id, ws):
    """Обработка WebSocket сообщений"""
    msg_type = data.get('type')
    
    if msg_type == 'user_join':
        user_id = user_sessions.get(session_id)
        chat_id = data.get('chat_id')
        username = data.get('username')
        
        if user_id:
            try:
                await db.execute('UPDATE users SET status = ? WHERE id = ?', ('online', user_id))
                await db.commit()
            except Exception as e:
                logger.error(f"Status update error: {e}")
        
        await broadcast_to_chat(chat_id, 'user_joined', {
            'username': username,
            'status': 'online',
            'timestamp': datetime.now().isoformat()
        })
        
        logger.info(f"✅ User {username} joined chat {chat_id}")
    
    elif msg_type == 'user_disconnect':
        user_id = user_sessions.get(session_id)
        username = data.get('username')
        
        if user_id:
            try:
                await db.execute('UPDATE users SET status = ? WHERE id = ?', ('offline', user_id))
                await db.commit()
            except Exception as e:
                logger.error(f"Status update error: {e}")
        
        logger.info(f"⚠️ User {username} disconnected")
    
    elif msg_type == 'send_message':
        chat_id = data.get('chat_id')
        sender_username = data.get('sender_username')
        message_type = data.get('message_type', 'text')
        text = data.get('text', '')
        
        try:
            message_id = generate_id()
            
            cursor = await db.execute('SELECT id FROM users WHERE username = ?', (sender_username,))
            sender = await cursor.fetchone()
            
            if sender:
                await db.execute('''
                    INSERT INTO messages (id, chat_id, sender_id, type, text)
                    VALUES (?, ?, ?, ?, ?)
                ''', (message_id, chat_id, sender['id'], message_type, text))
                await db.commit()
            
            message = {
                'id': message_id,
                'chat_id': chat_id,
                'sender_username': sender_username,
                'type': message_type,
                'text': text,
                'timestamp': datetime.now().isoformat()
            }
            
            await broadcast_to_chat(chat_id, 'new_message', message)
            logger.info(f"✅ Message sent: {message_id}")
        except Exception as e:
            logger.error(f"Send message error: {e}")
    
    elif msg_type == 'typing':
        chat_id = data.get('chat_id')
        username = data.get('username')
        
        await broadcast_to_chat(chat_id, 'user_typing', {
            'username': username,
            'is_typing': True
        })
    
    elif msg_type == 'stop_typing':
        chat_id = data.get('chat_id')
        username = data.get('username')
        
        await broadcast_to_chat(chat_id, 'user_typing', {
            'username': username,
            'is_typing': False
        })

# === ИНИЦИАЛИЗАЦИЯ ===

app = web.Application()

async def init_app():
    """Инициализация приложения"""
    await init_db()
    
    async def cors_middleware(app, handler):
        async def middleware_handler(request):
            if request.method == 'OPTIONS':
                return web.Response(
                    status=200,
                    headers={
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type',
                    }
                )
            response = await handler(request)
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        return middleware_handler
    
    app.middlewares.append(cors_middleware)
    
    # Маршруты
    app.router.add_post('/api/users/register', register)
    app.router.add_post('/api/users/login', login)
    app.router.add_get('/api/users', get_all_users)
    app.router.add_get('/api/users/{username}', search_user)
    app.router.add_post('/api/chats/create', create_chat)
    app.router.add_get('/api/chats/{username}', get_user_chats)
    app.router.add_get('/api/messages/{chat_id}', get_messages)
    app.router.add_post('/api/messages/{chat_id}', send_message)
    app.router.add_get('/ws/{session_id}', websocket_handler)
    
    return app

# === ЗАПУСК ===

async def main():
    app = await init_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 5000)
    await site.start()
    logger.info("🚀 Server running on http://0.0.0.0:5000")
    
    await asyncio.Event().wait()

if __name__ == '__main__':
    asyncio.run(main())
