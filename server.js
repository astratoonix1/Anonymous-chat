// server.js
// Realtime chat server: group chat + 1-to-1 private chat by ID, with every
// message forwarded to a Telegram bot/channel and NEVER stored on the server.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// In-memory registry only. Nothing is ever written to disk/DB.
// id -> { ws, name, mode: 'menu'|'group'|'private', partnerId: string|null }
const clients = new Map();

// Blocked device IDs — this list IS persisted to disk (banned.json), since
// a ban needs to survive server restarts. Managed via /block and /unblock
// commands sent to the Telegram bot from the owner's chat/channel.
const BANNED_FILE = path.join(__dirname, 'banned.json');
let bannedIds = new Set();
try {
  bannedIds = new Set(JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8')));
} catch {
  bannedIds = new Set();
}
function saveBanned() {
  try {
    fs.writeFileSync(BANNED_FILE, JSON.stringify([...bannedIds]));
  } catch (err) {
    console.error('Could not save banned.json:', err);
  }
}

const ID_FORMAT = /^[0-9A-F]{4}-[0-9A-F]{4}$/;

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastGroup(payload, exceptId) {
  for (const [id, c] of clients.entries()) {
    if (c.mode === 'group' && id !== exceptId) send(c.ws, payload);
  }
}

function newId() {
  // Short, readable unique id, e.g. 7F3K-9QZP
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

// Forward a message to Telegram. This is the ONLY place a message is
// persisted anywhere — the in-memory copy is discarded right after sending.
async function forwardToTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram not configured — skipping forward.');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram forward failed:', res.status, body);
    }
  } catch (err) {
    console.error('Telegram forward error:', err);
  }
}

// Immediately kick a currently-connected client whose ID just got banned.
function kickBannedId(id) {
  const c = clients.get(id);
  if (!c) return;
  disconnectPrivatePair(id);
  send(c.ws, { type: 'blocked', id });
  try { c.ws.close(); } catch {}
  clients.delete(id);
}

// ---- Telegram bot commands: /block <ID>, /unblock <ID>, /banned ----
// Only messages sent from the configured TELEGRAM_CHAT_ID (the owner's own
// chat/channel with the bot) are honoured, so a stranger can't ban people.
let telegramOffset = 0;

async function initTelegramOffset() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-1`);
    const data = await res.json();
    if (data.ok && data.result.length) {
      telegramOffset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch (err) {
    console.error('Telegram offset init failed:', err);
  }
}

async function handleTelegramUpdate(update) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) return;
  if (!TELEGRAM_CHAT_ID || String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;

  const text = msg.text.trim();
  const blockMatch = text.match(/^\/block(?:@\w+)?\s+([\w-]+)/i);
  const unblockMatch = text.match(/^\/unblock(?:@\w+)?\s+([\w-]+)/i);

  if (blockMatch) {
    const id = blockMatch[1].toUpperCase();
    bannedIds.add(id);
    saveBanned();
    kickBannedId(id);
    await forwardToTelegram(`🚫 <b>${id}</b> block ho gaya. Ab yeh chat nahi kar payega.`);
  } else if (unblockMatch) {
    const id = unblockMatch[1].toUpperCase();
    bannedIds.delete(id);
    saveBanned();
    await forwardToTelegram(`✅ <b>${id}</b> unblock ho gaya.`);
  } else if (/^\/banned\b/i.test(text)) {
    const list = [...bannedIds];
    await forwardToTelegram(
      list.length ? `🚫 Blocked IDs:\n${list.join('\n')}` : 'Abhi koi bhi ID block nahi hai.'
    );
  }
}

async function pollTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=25&offset=${telegramOffset}`
    );
    const data = await res.json();
    if (data.ok) {
      for (const update of data.result) {
        telegramOffset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    }
  } catch (err) {
    console.error('Telegram poll error:', err);
  } finally {
    setTimeout(pollTelegramCommands, 1000);
  }
}

function disconnectPrivatePair(id) {
  const me = clients.get(id);
  if (!me) return;
  const partnerId = me.partnerId;
  me.mode = 'menu';
  me.partnerId = null;
  if (partnerId && clients.has(partnerId)) {
    const partner = clients.get(partnerId);
    partner.mode = 'menu';
    partner.partnerId = null;
    send(partner.ws, { type: 'partner_disconnected' });
  }
}

wss.on('connection', (ws) => {
  let myId = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      // Client asks for its identity — either a brand-new ID, or (on reload)
      // the same one it already had, stored in that browser's localStorage.
      case 'register': {
        const requestedId = (msg.id || '').toUpperCase();

        if (requestedId && bannedIds.has(requestedId)) {
          send(ws, { type: 'blocked', id: requestedId });
          return;
        }

        if (requestedId && ID_FORMAT.test(requestedId)) {
          // This device is reclaiming its own previously-issued ID. If an
          // old socket for that ID is still hanging around (e.g. the tab
          // was just reloaded and the close event hasn't landed yet), close
          // it and take over — this is what stopped the ID from changing
          // on every refresh.
          const existing = clients.get(requestedId);
          if (existing && existing.ws !== ws) {
            try { existing.ws.close(); } catch {}
          }
          myId = requestedId;
        } else {
          myId = newId();
        }

        clients.set(myId, {
          ws,
          name: msg.name || 'Anonymous',
          mode: 'menu',
          partnerId: null,
        });
        send(ws, { type: 'registered', id: myId });
        break;
      }

      case 'join_group': {
        if (!myId) return;
        const me = clients.get(myId);
        me.mode = 'group';
        me.partnerId = null;
        send(ws, { type: 'joined_group' });
        break;
      }

      case 'leave_group': {
        if (!myId) return;
        const me = clients.get(myId);
        me.mode = 'menu';
        send(ws, { type: 'left' });
        break;
      }

      case 'connect_private': {
        if (!myId) return;
        const targetId = (msg.targetId || '').trim().toUpperCase();
        const me = clients.get(myId);
        const target = clients.get(targetId);

        if (!target) {
          send(ws, { type: 'private_error', message: 'Yeh ID online nahi hai.' });
          return;
        }
        if (targetId === myId) {
          send(ws, { type: 'private_error', message: 'Khud ke ID se connect nahi ho sakte.' });
          return;
        }
        if (target.mode === 'private' && target.partnerId !== myId) {
          send(ws, { type: 'private_error', message: 'Yeh user already kisi aur se connected hai.' });
          return;
        }

        me.mode = 'private';
        me.partnerId = targetId;
        target.mode = 'private';
        target.partnerId = myId;

        send(ws, { type: 'connected', partner: { id: targetId, name: target.name } });
        send(target.ws, { type: 'connected', partner: { id: myId, name: me.name } });
        break;
      }

      case 'resume_private': {
        // used after a page reload to try to re-attach to the same partner
        if (!myId) return;
        const targetId = msg.targetId;
        const me = clients.get(myId);
        const target = clients.get(targetId);
        if (target && target.partnerId === myId) {
          me.mode = 'private';
          me.partnerId = targetId;
          send(ws, { type: 'connected', partner: { id: targetId, name: target.name } });
        } else {
          me.mode = 'menu';
          me.partnerId = null;
          send(ws, { type: 'private_error', message: 'Pichla connection ab available nahi hai.' });
        }
        break;
      }

      case 'disconnect': {
        if (!myId) return;
        disconnectPrivatePair(myId);
        send(ws, { type: 'left' });
        break;
      }

      case 'chat_message': {
        if (!myId) return;
        const me = clients.get(myId);
        const text = (msg.text || '').toString().slice(0, 2000);
        if (!text.trim()) return;
        const stamp = new Date().toISOString();

        if (me.mode === 'group') {
          const payload = {
            type: 'chat_message',
            from: { id: myId, name: me.name },
            scope: 'group',
            text,
            ts: stamp,
          };
          // echo to sender + broadcast to everyone else in group
          send(ws, payload);
          broadcastGroup(payload, myId);
          await forwardToTelegram(
            `👥 <b>Group</b>\n<b>${escapeHtml(me.name)}</b> (${myId})\n${escapeHtml(text)}`
          );
        } else if (me.mode === 'private' && me.partnerId) {
          const partner = clients.get(me.partnerId);
          const payload = {
            type: 'chat_message',
            from: { id: myId, name: me.name },
            scope: 'private',
            text,
            ts: stamp,
          };
          send(ws, payload); // echo to sender
          if (partner) send(partner.ws, payload);
          await forwardToTelegram(
            `🔒 <b>Private</b>\n<b>${escapeHtml(me.name)}</b> (${myId}) ➜ ${
              partner ? escapeHtml(partner.name) : '?'
            } (${me.partnerId})\n${escapeHtml(text)}`
          );
        }
        // Message is never stored anywhere after this point.
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (myId) {
      disconnectPrivatePair(myId);
      clients.delete(myId);
    }
  });
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — messages will not be forwarded.');
    return;
  }
  await initTelegramOffset();
  pollTelegramCommands();
});
