import { randomUUID } from "node:crypto";

import { compareHandStrength, createDeck, evaluateSevenCardHand, shuffleDeck } from "./poker.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode(existingRooms) {
  let roomCode = "";

  while (!roomCode || existingRooms.has(roomCode)) {
    roomCode = Array.from({ length: 5 }, () => {
      const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
      return ROOM_CODE_ALPHABET[index];
    }).join("");
  }

  return roomCode;
}

function normalizeName(name, fallbackName) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.slice(0, 12) || fallbackName;
}

function createWaitingState() {
  return {
    phase: "waiting",
    handNumber: 0,
    board: [],
    deck: [],
    hands: {},
    showdown: null,
  };
}

function resetTable(room, keepHandNumber = true) {
  const currentHandNumber = keepHandNumber ? room.handNumber : 0;
  Object.assign(room, createWaitingState(), { handNumber: currentHandNumber });
}

function sortPlayersBySeat(players) {
  return [...players].sort((left, right) => left.seat - right.seat);
}

function getOpenSeat(players) {
  return [0, 1].find((seat) => !players.some((player) => player.seat === seat));
}

function getOpponent(room, playerId) {
  return room.players.find((player) => player.id !== playerId) ?? null;
}

function buildBestHandsMap(results) {
  return Object.fromEntries(
    results.map((result) => [
      result.playerId,
      {
        seat: result.seat,
        name: result.name,
        handName: result.handName,
        cards: result.bestCards,
      },
    ]),
  );
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.socketIndex = new Map();
  }

  createRoom(socket, name) {
    if (this.socketIndex.has(socket.id)) {
      throw new Error("当前连接已经在房间中，请刷新页面后再试。");
    }

    const roomCode = generateRoomCode(this.rooms);
    const room = {
      roomCode,
      players: [],
      ...createWaitingState(),
    };

    this.rooms.set(roomCode, room);
    const player = this.#addPlayer(room, socket, name, true);

    return { room, player };
  }

  joinRoom(socket, roomCodeInput, name) {
    if (this.socketIndex.has(socket.id)) {
      throw new Error("当前连接已经在房间中，请刷新页面后再试。");
    }

    const roomCode = roomCodeInput?.trim().toUpperCase();

    if (!roomCode || !this.rooms.has(roomCode)) {
      throw new Error("房间不存在，请检查房间码。");
    }

    const room = this.rooms.get(roomCode);

    if (room.players.length >= 2) {
      throw new Error("房间已满，只支持两位玩家。");
    }

    const player = this.#addPlayer(room, socket, name, false);

    return { room, player };
  }

  getRoomForSocket(socketId) {
    const context = this.socketIndex.get(socketId);

    if (!context) {
      return null;
    }

    return this.rooms.get(context.roomCode) ?? null;
  }

  getPlayerForSocket(socketId) {
    const context = this.socketIndex.get(socketId);
    const room = context ? this.rooms.get(context.roomCode) : null;

    if (!context || !room) {
      return null;
    }

    return room.players.find((player) => player.id === context.playerId) ?? null;
  }

  startHand(socketId) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);

    if (!room || !actingPlayer) {
      throw new Error("你还没有进入房间。");
    }

    if (!actingPlayer.isHost) {
      throw new Error("只有房主可以开始新一局。");
    }

    if (room.players.length !== 2) {
      throw new Error("需要两位玩家都在场才能开始。");
    }

    const deck = shuffleDeck(createDeck());
    const players = sortPlayersBySeat(room.players);
    const hands = {};

    for (const player of players) {
      hands[player.id] = [deck.shift(), deck.shift()];
    }

    room.handNumber += 1;
    room.phase = "preflop";
    room.board = [];
    room.deck = deck;
    room.hands = hands;
    room.showdown = null;

    return room;
  }

  revealNext(socketId) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);

    if (!room || !actingPlayer) {
      throw new Error("你还没有进入房间。");
    }

    if (!actingPlayer.isHost) {
      throw new Error("只有房主可以开牌。");
    }

    if (room.players.length !== 2) {
      throw new Error("当前玩家数量不足，无法继续开牌。");
    }

    switch (room.phase) {
      case "preflop":
        room.board.push(room.deck.shift(), room.deck.shift(), room.deck.shift());
        room.phase = "flop";
        return { room, becameShowdown: false };
      case "flop":
        room.board.push(room.deck.shift());
        room.phase = "turn";
        return { room, becameShowdown: false };
      case "turn":
        room.board.push(room.deck.shift());
        room.phase = "river";
        return { room, becameShowdown: false };
      case "river":
        room.phase = "showdown";
        room.showdown = this.#buildShowdown(room);
        return { room, becameShowdown: true };
      default:
        throw new Error("当前阶段不能继续开牌。");
    }
  }

  removeSocket(socketId) {
    const context = this.socketIndex.get(socketId);

    if (!context) {
      return null;
    }

    this.socketIndex.delete(socketId);
    const room = this.rooms.get(context.roomCode);

    if (!room) {
      return null;
    }

    room.players = room.players.filter((player) => player.id !== context.playerId);

    if (room.players.length === 0) {
      this.rooms.delete(room.roomCode);
      return null;
    }

    if (!room.players.some((player) => player.isHost)) {
      room.players[0].isHost = true;
    }

    resetTable(room);
    return room;
  }

  buildRoomState(room, playerId) {
    const self = room.players.find((player) => player.id === playerId);

    return {
      roomCode: room.roomCode,
      players: sortPlayersBySeat(room.players).map((player) => ({
        id: player.id,
        seat: player.seat,
        name: player.name,
        isHost: player.isHost,
        isSelf: player.id === playerId,
        online: true,
      })),
      self: self
        ? {
            playerId: self.id,
            seat: self.seat,
            name: self.name,
            isHost: self.isHost,
          }
        : null,
    };
  }

  buildGameState(room, playerId) {
    const self = room.players.find((player) => player.id === playerId);
    const opponent = getOpponent(room, playerId);
    const showdownResults =
      room.showdown?.results.map((result) => ({
        seat: result.seat,
        name: result.name,
        holeCards: result.holeCards,
        handName: result.handName,
        bestCards: result.bestCards,
        isWinner: room.showdown.winnerSeat !== null && room.showdown.winnerSeat === result.seat,
      })) ?? null;

    return {
      roomCode: room.roomCode,
      phase: room.phase,
      handNumber: room.handNumber,
      board: room.board,
      selfHoleCards: self ? room.hands[self.id] ?? [] : [],
      opponentCardCount: opponent ? room.hands[opponent.id]?.length ?? 0 : 0,
      revealedOpponentHoleCards:
        room.phase === "showdown" && opponent ? room.hands[opponent.id] ?? [] : [],
      winner: room.showdown
        ? {
            seat: room.showdown.winnerSeat,
            playerId: room.showdown.winnerPlayerId,
          }
        : null,
      bestHands: room.showdown ? buildBestHandsMap(room.showdown.results) : null,
      showdownResults,
      actions: {
        canStartHand: Boolean(self?.isHost) && room.players.length === 2,
        canRevealNext:
          Boolean(self?.isHost) &&
          room.players.length === 2 &&
          ["preflop", "flop", "turn", "river"].includes(room.phase),
      },
    };
  }

  #addPlayer(room, socket, name, isHost) {
    const seat = getOpenSeat(room.players);

    if (seat === undefined) {
      throw new Error("房间已满。");
    }

    const player = {
      id: randomUUID(),
      socketId: socket.id,
      seat,
      name: normalizeName(name, `玩家 ${seat + 1}`),
      isHost: isHost || room.players.length === 0,
    };

    room.players.push(player);
    socket.join(room.roomCode);
    this.socketIndex.set(socket.id, { roomCode: room.roomCode, playerId: player.id });

    return player;
  }

  #buildShowdown(room) {
    const results = sortPlayersBySeat(room.players).map((player) => {
      const holeCards = room.hands[player.id];
      const evaluation = evaluateSevenCardHand([...holeCards, ...room.board]);

      return {
        playerId: player.id,
        seat: player.seat,
        name: player.name,
        holeCards,
        handName: evaluation.name,
        bestCards: evaluation.bestCards,
        strength: {
          category: evaluation.category,
          tiebreak: evaluation.tiebreak,
        },
      };
    });

    const comparison = compareHandStrength(results[0].strength, results[1].strength);

    return {
      winnerPlayerId: comparison === 0 ? null : comparison > 0 ? results[0].playerId : results[1].playerId,
      winnerSeat: comparison === 0 ? null : comparison > 0 ? results[0].seat : results[1].seat,
      results,
    };
  }
}
