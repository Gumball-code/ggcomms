// server.js
// Minimal Express + Socket.IO chat server

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data
const users = new Map();
const usernameToSocket = new Map();
const lastMessages = [];
const MAX_HISTORY = 100;

function pushMessage(msg) {
  if (lastMessages.length >= MAX_HISTORY) lastMessages.shift();
  lastMessages.push(msg);
}

io.on('connection', (socket) => {
  socket.emit('history', lastMessages);
  socket.emit('users', Array.from(usernameToSocket.keys()));

  socket.on('set username', (usernameCandidate, cb) => {
    const username = (usernameCandidate || '').trim().slice(0, 32);
    if (!username) return cb({ ok: false, error: 'invalid' });
    if (usernameToSocket.has(username)) return cb({ ok: false, error: 'taken' });

    users.set(socket.id, { username });
    usernameToSocket.set(username, socket.id);
    cb({ ok: true, username });

    const joinMsg = { system: true, text: `${username} joined`, time: Date.now() };
    pushMessage(joinMsg);
    io.emit('system message', joinMsg);
    io.emit('users', Array.from(usernameToSocket.keys()));
  });

  socket.on('chat message', (raw, cb) => {
    const user = users.get(socket.id);
    if (!user) return cb({ ok: false, error: 'no-user' });
    const text = String(raw || '').slice(0, 1000);
    if (!text) return cb({ ok: false, error: 'empty' });

    // Private message: @username message
    if (text.startsWith('@')) {
      const firstSpace = text.indexOf(' ');
      if (firstSpace > 1) {
        const target = text.substring(1, firstSpace);
        const msgText = text.substring(firstSpace + 1);
        const targetSocket = usernameToSocket.get(target);
        if (targetSocket) {
          const pm = { private: true, from: user.username, to: target, text: msgText, time: Date.now() };
          socket.emit('private message', pm);
          io.to(targetSocket).emit('private message', pm);
          return cb({ ok: true });
        }
      }
    }

    // Public message
    const msg = { from: user.username, text, time: Date.now() };
    pushMessage(msg);
    io.emit('chat message', msg);
    cb({ ok: true });
  });

  socket.on('typing', (isTyping) => {
    const u = users.get(socket.id);
    if (u) socket.broadcast.emit('typing', { username: u.username, typing: !!isTyping });
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    if (u) {
      usernameToSocket.delete(u.username);
      users.delete(socket.id);
      const leaveMsg = { system: true, text: `${u.username} left`, time: Date.now() };
      pushMessage(leaveMsg);
      io.emit('system message', leaveMsg);
      io.emit('users', Array.from(usernameToSocket.keys()));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
