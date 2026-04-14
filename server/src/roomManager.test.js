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

test("房间在大厅阶段最多支持 8 人加入，第 9 人会被拒绝", () => {
  const manager = new RoomManager();
  const hostSocket = createSocket("host");
  const { room } = manager.createRoom(hostSocket, "Host");

  for (let index = 1; index < 8; index += 1) {
    manager.joinRoom(createSocket(`guest-${index}`), room.roomCode, `Guest ${index}`);
  }

  assert.equal(room.players.length, 8);
  assert.throws(
    () => manager.joinRoom(createSocket("guest-9"), room.roomCode, "Overflow"),
    /房间已满/,
  );
});

test("房主开始整场后房间会锁定，后续无法再加入新人", () => {
  const { manager, room, sockets } = createTable(3);

  manager.startHand(sockets[0].id);

  assert.equal(room.roomStatus, "running");
  assert.equal(room.isJoinLocked, true);
  assert.throws(
    () => manager.joinRoom(createSocket("late-player"), room.roomCode, "Late"),
    /已开始/,
  );
});

test("三人局的庄位、小盲、大盲和首轮行动顺序符合多人德州规则", () => {
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

test("多人全压时会正确切分主池和边池，并把筹码发给对应赢家", () => {
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

test("弃牌会让剩余玩家直接收下底池", () => {
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

test("只剩一位玩家仍有筹码时比赛结束，房主可以重新开赛", () => {
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
});
