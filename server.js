// server.js
// Realtime chat server: group chat + 1-to-1 private chat by ID, with every
// message forwarded to a Telegram bot/channel and NEVER stored on the server.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');

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
      // Client asks for a fresh identity (first-ever visit)
      case 'register': {
        const requestedId = msg.id;
        if (requestedId && !clients.has(requestedId)) {
          myId = requestedId; // resuming after reload
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

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — messages will not be forwarded.');
  }
});
