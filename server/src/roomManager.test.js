import assert from "node:assert/strict";
import test from "node:test";

import { RoomManager } from "./roomManager.js";

function createSocket(id) {
  return {
    id,
    join() {},
  };
}

function createTable(playerCount = 2) {
  const manager = new RoomManager();
  const sockets = [];
  const players = [];

  const hostSocket = createSocket("socket-0");
  const { room } = manager.createRoom(hostSocket, "Host");
  sockets.push(hostSocket);
  players.push(manager.getPlayerForSocket(hostSocket.id));

  for (let index = 1; index < playerCount; index += 1) {
    const socket = createSocket(`socket-${index}`);
    manager.joinRoom(socket, room.roomCode, `Player ${index + 1}`);
    sockets.push(socket);
    players.push(manager.getPlayerForSocket(socket.id));
  }

  return { manager, room, sockets, players };
}

function setRiverAllInState(room, players, board, hands, totalHandContributions) {
  room.phase = "river";
  room.board = board;
  room.hands = Object.fromEntries(players.map((player) => [player.id, hands[player.id]]));
  room.currentBet = 0;
  room.currentTurnSeat = null;
  room.streetContributions = Object.fromEntries(players.map((player) => [player.id, 0]));
  room.totalHandContributions = Object.fromEntries(
    players.map((player) => [player.id, totalHandContributions[player.id] ?? 0]),
  );
  room.hasActedThisStreet = Object.fromEntries(players.map((player) => [player.id, true]));
  room.foldedPlayerIds = [];
  room.allInPlayerIds = players.map((player) => player.id);

  for (const player of players) {
    room.stacks[player.id] = 0;
  }
}

test("room accepts up to 8 players in lobby and rejects the 9th", () => {
  const manager = new RoomManager();
  const hostSocket = createSocket("host");
  const { room } = manager.createRoom(hostSocket, "Host");

  for (let index = 1; index < 8; index += 1) {
    manager.joinRoom(createSocket(`guest-${index}`), room.roomCode, `Guest ${index}`);
  }

  assert.equal(room.players.length, 8);
  assert.throws(() => manager.joinRoom(createSocket("guest-9"), room.roomCode, "Overflow"));
});

test("host starting the match locks the room for late joins", () => {
  const { manager, room, sockets } = createTable(3);

  manager.startHand(sockets[0].id);

  assert.equal(room.roomStatus, "running");
  assert.equal(room.isJoinLocked, true);
  assert.throws(() => manager.joinRoom(createSocket("late-player"), room.roomCode, "Late"));
});

test("three-player blind order and preflop action order follow multiplayer rules", () => {
  const { manager, room, sockets } = createTable(3);

  manager.startHand(sockets[0].id);
  assert.equal(room.dealerSeat, 0);
  assert.equal(room.smallBlindSeat, 1);
  assert.equal(room.bigBlindSeat, 2);
  assert.equal(room.currentTurnSeat, 0);

  manager.call(sockets[0].id);
  assert.equal(room.currentTurnSeat, 1);

  manager.call(sockets[1].id);
  assert.equal(room.currentTurnSeat, 2);

  manager.call(sockets[2].id);
  assert.equal(room.currentTurnSeat, null);

  const hostPlayer = manager.getPlayerForSocket(sockets[0].id);
  const hostState = manager.buildGameState(room, hostPlayer.id);
  assert.equal(hostState.actions.canRevealNext, true);

  manager.revealNext(sockets[0].id);
  assert.equal(room.phase, "flop");
  assert.equal(room.currentTurnSeat, 1);
});

test("all-in multiplayer showdowns split main pot and side pots correctly", () => {
  const { manager, room, sockets, players } = createTable(3);
  const hostPlayer = players[0];
  const secondPlayer = players[1];
  const thirdPlayer = players[2];

  room.roomStatus = "running";
  room.isJoinLocked = true;
  room.dealerSeat = 0;
  room.smallBlindSeat = 1;
  room.bigBlindSeat = 2;

  setRiverAllInState(
    room,
    players,
    ["AS", "KS", "8D", "7C", "2H"],
    {
      [hostPlayer.id]: ["AH", "AD"],
      [secondPlayer.id]: ["KH", "KD"],
      [thirdPlayer.id]: ["QS", "QH"],
    },
    {
      [hostPlayer.id]: 10,
      [secondPlayer.id]: 20,
      [thirdPlayer.id]: 20,
    },
  );

  manager.revealNext(sockets[0].id);

  assert.equal(room.showdown.type, "showdown");
  assert.equal(room.showdown.totalPot, 50);
  assert.deepEqual(
    room.showdown.winners
      .map((winner) => ({ seat: winner.seat, amount: winner.amount }))
      .sort((left, right) => left.seat - right.seat),
    [
      { seat: 0, amount: 30 },
      { seat: 1, amount: 20 },
    ],
  );
  assert.equal(room.stacks[hostPlayer.id], 30);
  assert.equal(room.stacks[secondPlayer.id], 20);
  assert.equal(room.stacks[thirdPlayer.id], 0);
  assert.equal(room.roomStatus, "running");
});

test("fold awards the pot immediately to the remaining player", () => {
  const { manager, room, sockets, players } = createTable(2);

  manager.startHand(sockets[0].id);
  manager.call(sockets[0].id);
  manager.fold(sockets[1].id);

  const winner = players[0];
  assert.equal(room.phase, "showdown");
  assert.equal(room.showdown.type, "fold");
  assert.equal(room.showdown.winnerPlayerId, winner.id);
  assert.equal(room.stacks[winner.id], 52);
});

test("match ends when one player has chips left and host can reset it", () => {
  const { manager, room, sockets, players } = createTable(2);
  const hostPlayer = players[0];
  const guestPlayer = players[1];

  room.roomStatus = "running";
  room.isJoinLocked = true;
  room.dealerSeat = 0;
  room.smallBlindSeat = 0;
  room.bigBlindSeat = 1;

  setRiverAllInState(
    room,
    players,
    ["AS", "KD", "8H", "6C", "2S"],
    {
      [hostPlayer.id]: ["AH", "AD"],
      [guestPlayer.id]: ["KS", "KH"],
    },
    {
      [hostPlayer.id]: 50,
      [guestPlayer.id]: 50,
    },
  );

  manager.revealNext(sockets[0].id);

  assert.equal(room.roomStatus, "finished");
  assert.equal(room.stacks[hostPlayer.id], 100);
  assert.equal(room.stacks[guestPlayer.id], 0);

  manager.resetMatch(sockets[0].id);
  assert.equal(room.roomStatus, "lobby");
  assert.equal(room.isJoinLocked, false);
  assert.equal(room.phase, "waiting");
  assert.equal(room.handNumber, 0);
  assert.equal(room.stacks[hostPlayer.id], 50);
  assert.equal(room.stacks[guestPlayer.id], 50);
  assert.deepEqual(room.handHistory, []);
});

test("history entry is created after showdown with summary and visible hands", () => {
  const { manager, room, sockets, players } = createTable(2);
  const hostPlayer = players[0];
  const guestPlayer = players[1];

  room.roomStatus = "running";
  room.isJoinLocked = true;
  room.handNumber = 0;
  room.dealerSeat = 0;
  room.smallBlindSeat = 0;
  room.bigBlindSeat = 1;

  setRiverAllInState(
    room,
    players,
    ["AS", "KD", "8H", "6C", "2S"],
    {
      [hostPlayer.id]: ["AH", "AD"],
      [guestPlayer.id]: ["KS", "KH"],
    },
    {
      [hostPlayer.id]: 20,
      [guestPlayer.id]: 20,
    },
  );

  manager.revealNext(sockets[0].id);

  assert.equal(room.handHistory.length, 1);
  assert.equal(room.handHistory[0].endedBy, "showdown");
  assert.match(room.handHistory[0].summary, /收下 40 筹码|总计 40 筹码/);

  const hostState = manager.buildGameState(room, hostPlayer.id);
  const history = hostState.handHistory[0];
  const hostHistoryPlayer = history.players.find((player) => player.playerId === hostPlayer.id);
  const guestHistoryPlayer = history.players.find((player) => player.playerId === guestPlayer.id);

  assert.equal(history.board.length, 5);
  assert.equal(hostHistoryPlayer.handVisible, true);
  assert.equal(guestHistoryPlayer.handVisible, true);
  assert.equal(hostHistoryPlayer.holeCards.length, 2);
  assert.equal(guestHistoryPlayer.holeCards.length, 2);
});

test("history entry is created after a fold and hides unshown hands from opponents", () => {
  const { manager, room, sockets, players } = createTable(2);
  const hostPlayer = players[0];
  const guestPlayer = players[1];

  manager.startHand(sockets[0].id);
  manager.call(sockets[0].id);
  manager.fold(sockets[1].id);

  assert.equal(room.handHistory.length, 1);
  assert.equal(room.handHistory[0].endedBy, "fold");
  assert.match(room.handHistory[0].summary, /弃牌/);

  const hostState = manager.buildGameState(room, hostPlayer.id);
  const guestState = manager.buildGameState(room, guestPlayer.id);
  const hostViewOfGuest = hostState.handHistory[0].players.find((player) => player.playerId === guestPlayer.id);
  const guestOwnView = guestState.handHistory[0].players.find((player) => player.playerId === guestPlayer.id);
  const hostViewOfSelf = hostState.handHistory[0].players.find((player) => player.playerId === hostPlayer.id);

  assert.equal(hostViewOfGuest.handVisible, false);
  assert.deepEqual(hostViewOfGuest.holeCards, []);
  assert.equal(guestOwnView.handVisible, true);
  assert.equal(guestOwnView.holeCards.length, 2);
  assert.equal(hostViewOfSelf.handVisible, true);
  assert.equal(hostViewOfSelf.holeCards.length, 2);
});

test("eliminated spectators can see live hands but not folded hands on table or in history", () => {
  const { manager, room, sockets, players } = createTable(3);
  const hostPlayer = players[0];
  const secondPlayer = players[1];
  const spectatorPlayer = players[2];

  room.stacks[spectatorPlayer.id] = 0;
  room.eliminatedPlayerIds = [spectatorPlayer.id];

  manager.startHand(sockets[0].id);

  const liveState = manager.buildGameState(room, spectatorPlayer.id);
  const liveSeats = liveState.seats.filter((seat) => seat.occupied && seat.holeCardCount === 2);
  const hostSeat = liveSeats.find((seat) => seat.playerId === hostPlayer.id);
  const secondSeat = liveSeats.find((seat) => seat.playerId === secondPlayer.id);

  assert.equal(hostSeat.revealedHoleCards.length, 2);
  assert.equal(secondSeat.revealedHoleCards.length, 2);

  manager.call(sockets[0].id);
  manager.fold(sockets[1].id);

  const foldedTableState = manager.buildGameState(room, spectatorPlayer.id);
  const foldedSeat = foldedTableState.seats.find((seat) => seat.playerId === secondPlayer.id);
  const foldedHistoryPlayer = foldedTableState.handHistory[0].players.find(
    (player) => player.playerId === secondPlayer.id,
  );

  assert.deepEqual(foldedSeat.revealedHoleCards, []);
  assert.equal(foldedHistoryPlayer.handVisible, false);
  assert.deepEqual(foldedHistoryPlayer.holeCards, []);
});
