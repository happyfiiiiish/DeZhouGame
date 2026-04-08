import http from "node:http";

import cors from "cors";
import express from "express";
import { Server } from "socket.io";

import { RoomManager } from "./roomManager.js";

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});
const roomManager = new RoomManager();

app.use(cors());

app.get("/health", (_request, response) => {
  response.json({ ok: true, port: PORT });
});

function emitRoomAndGameState(room) {
  for (const player of room.players) {
    io.to(player.socketId).emit("room:state", roomManager.buildRoomState(room, player.id));
    io.to(player.socketId).emit("game:state", roomManager.buildGameState(room, player.id));
  }
}

function emitShowdown(room) {
  if (room.phase !== "showdown" || !room.showdown) {
    return;
  }

  for (const player of room.players) {
    io.to(player.socketId).emit("game:showdown", roomManager.buildGameState(room, player.id));
  }
}

function emitError(socket, message) {
  socket.emit("app:error", { message });
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name } = {}) => {
    try {
      const { room } = roomManager.createRoom(socket, name);
      emitRoomAndGameState(room);
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("room:join", ({ roomCode, name } = {}) => {
    try {
      const { room } = roomManager.joinRoom(socket, roomCode, name);
      emitRoomAndGameState(room);

      if (room.phase === "showdown") {
        emitShowdown(room);
      }
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("game:startHand", () => {
    try {
      const room = roomManager.startHand(socket.id);
      emitRoomAndGameState(room);
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("game:revealNext", () => {
    try {
      const { room, becameShowdown } = roomManager.revealNext(socket.id);
      emitRoomAndGameState(room);

      if (becameShowdown) {
        emitShowdown(room);
      }
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("game:raise", ({ targetBet } = {}) => {
    try {
      const room = roomManager.raiseTo(socket.id, targetBet);
      emitRoomAndGameState(room);
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("game:call", () => {
    try {
      const room = roomManager.call(socket.id);
      emitRoomAndGameState(room);
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("game:fold", () => {
    try {
      const room = roomManager.fold(socket.id);
      emitRoomAndGameState(room);
      emitShowdown(room);
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("match:reset", () => {
    try {
      const room = roomManager.resetMatch(socket.id);
      emitRoomAndGameState(room);
    } catch (error) {
      emitError(socket, error.message);
    }
  });

  socket.on("disconnect", () => {
    const room = roomManager.removeSocket(socket.id);

    if (room) {
      emitRoomAndGameState(room);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`德州扑克服务端已启动: http://0.0.0.0:${PORT}`);
});
