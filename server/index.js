const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const RoomManager = require('./rooms/RoomManager');
const registerAllHandlers = require('./handlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Serve static files
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Room manager - restore rooms from DB on startup
const roomManager = new RoomManager();
roomManager.loadFromDB();

// Register handlers
registerAllHandlers(io, roomManager);

// Periodic cleanup
setInterval(() => {
  roomManager.cleanup();
}, config.ROOM_CLEANUP_INTERVAL);

server.listen(config.PORT, () => {
  console.log(`[服务器] 运行在 http://localhost:${config.PORT}`);
});
