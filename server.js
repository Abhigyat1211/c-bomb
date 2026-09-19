const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const genCode = () => {
  let c = '';
  for (let i = 0; i < 6; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
  return c;
};

const rooms = new Map(); // code -> room

function makeRoom(code) {
  return {
    code,
    players: {},          // socketId -> { slot:'A'|'B', q1Cut, q2Cut, q3Solved }
    startedAt: null,
    winner: null,         // 'A' | 'B' | 'none' | null
    status: 'waiting',    // waiting | countdown | playing | ended
    timer: null,
    cleanup: null,
  };
}

function endRoom(code, winner, finalTime, reason) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'ended';
  room.winner = winner;
  if (room.timer) clearTimeout(room.timer);
  io.to(code).emit('matchOver', { winner, finalTime, reason: reason || 'normal' });
  // keep room alive 15s for any late client requests, then wipe
  room.cleanup = setTimeout(() => rooms.delete(code), 15000);
}

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('createRoom', () => {
    let code;
    do { code = genCode(); } while (rooms.has(code));
    const room = makeRoom(code);
    room.players[socket.id] = { slot: 'A', q1Cut: false, q2Cut: false, q3Solved: false };
    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;
    socket.emit('roomCreated', { code, slot: 'A' });
    console.log('created', code);
  });

  socket.on('joinRoom', ({ code }) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('joinError', { message: 'ROOM NOT FOUND' });
    if (Object.keys(room.players).length >= 2) return socket.emit('joinError', { message: 'ROOM FULL' });
    if (room.status !== 'waiting') return socket.emit('joinError', { message: 'MATCH ALREADY STARTED' });

    room.players[socket.id] = { slot: 'B', q1Cut: false, q2Cut: false, q3Solved: false };
    socket.join(code);
    socket.data.code = code;
    socket.emit('roomJoined', { code, slot: 'B' });

    room.status = 'countdown';
    io.to(code).emit('matchReady');

    setTimeout(() => {
      if (room.status !== 'countdown') return;
      room.status = 'playing';
      room.startedAt = Date.now();
      io.to(code).emit('matchStart', { startedAt: room.startedAt });
      room.timer = setTimeout(() => {
        if (room.winner) return;
        endRoom(code, 'none', 60, 'timeout');
      }, 60000);
    }, 3000);
    console.log('joined', code);
  });

  socket.on('wireCut', ({ questionIndex }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const me = room.players[socket.id];
    if (!me) return;

    if (questionIndex === 0) me.q1Cut = true;
    else if (questionIndex === 1) me.q2Cut = true;
    else if (questionIndex === 2) {
      if (room.winner) return;
      me.q3Solved = true;
      const finalTime = (Date.now() - room.startedAt) / 1000;
      endRoom(code, me.slot, finalTime, 'q3');
      return;
    }

    // Broadcast to opponent only
    socket.to(code).emit('opponentWireCut', { questionIndex });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const me = room.players[socket.id];
    if (!me) return;

    if (room.status === 'playing' && !room.winner) {
      const oppSlot = me.slot === 'A' ? 'B' : 'A';
      const finalTime = room.startedAt ? (Date.now() - room.startedAt) / 1000 : 60;
      endRoom(code, oppSlot, finalTime, 'disconnect');
    } else if (room.status === 'waiting' || room.status === 'countdown') {
      socket.to(code).emit('opponentLeft');
      rooms.delete(code);
    }

    delete room.players[socket.id];
    console.log('disconnect', socket.id, 'from', code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`C-BOMB server listening on ${PORT}`));