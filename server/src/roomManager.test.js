import assert from "node:assert/strict";
import test from "node:test";

import { RoomManager } from "./roomManager.js";

function createSocket(id) {
  return {
    id,
    join() {},
  };
}

function createJoinedRoom() {
  const manager = new RoomManager();
  const hostSocket = createSocket("host-socket");
  const guestSocket = createSocket("guest-socket");
  const { room } = manager.createRoom(hostSocket, "Host");

  manager.joinRoom(guestSocket, room.roomCode, "Guest");

  return {
    manager,
    room,
    hostSocket,
    guestSocket,
    hostPlayer: manager.getPlayerForSocket(hostSocket.id),
    guestPlayer: manager.getPlayerForSocket(guestSocket.id),
  };
}

function setClosedRiver(room, hostPlayer, guestPlayer, { pot, carryoverPot = 0, hostStack = 10, guestStack = 10 }) {
  room.phase = "river";
  room.board = ["AS", "KS", "QS", "JS", "TS"];
  room.hands = {
    [hostPlayer.id]: ["2C", "3D"],
    [guestPlayer.id]: ["4C", "5D"],
  };
  room.pot = pot;
  room.carryoverPot = carryoverPot;
  room.currentBet = 0;
  room.currentTurnSeat = null;
  room.streetContributions = {
    [hostPlayer.id]: 0,
    [guestPlayer.id]: 0,
  };
  room.hasActedThisStreet = {
    [hostPlayer.id]: true,
    [guestPlayer.id]: true,
  };
  room.stacks[hostPlayer.id] = hostStack;
  room.stacks[guestPlayer.id] = guestStack;
}

test("startHand posts blinds and requires matched action before reveal", () => {
  const { manager, room, hostSocket, guestSocket, hostPlayer } = createJoinedRoom();

  manager.startHand(hostSocket.id);
  let hostState = manager.buildGameState(room, hostPlayer.id);

  assert.equal(hostState.selfStack, 49);
  assert.equal(hostState.opponentStack, 48);
  assert.equal(hostState.currentBet, 2);
  assert.equal(hostState.currentTurnSeat, 0);
  assert.equal(hostState.actions.canRevealNext, false);

  manager.call(hostSocket.id);
  hostState = manager.buildGameState(room, hostPlayer.id);
  assert.equal(hostState.actions.canRevealNext, false);

  manager.call(guestSocket.id);
  hostState = manager.buildGameState(room, hostPlayer.id);
  assert.equal(hostState.actions.canRevealNext, true);
});

test("fold awards the entire pot to the non-folding player", () => {
  const { manager, room, hostSocket, guestSocket, hostPlayer } = createJoinedRoom();

  manager.startHand(hostSocket.id);
  manager.raiseTo(hostSocket.id, 3);
  manager.fold(guestSocket.id);

  const state = manager.buildGameState(room, hostPlayer.id);

  assert.equal(state.phase, "showdown");
  assert.equal(state.selfStack, 52);
  assert.equal(state.opponentStack, 48);
  assert.equal(state.resolution.type, "fold");
  assert.equal(state.matchStatus, "active");
});

test("tie carries the current pot into the next hand when stacks remain", () => {
  const { manager, room, hostSocket, hostPlayer, guestPlayer } = createJoinedRoom();

  setClosedRiver(room, hostPlayer, guestPlayer, {
    pot: 6,
    hostStack: 12,
    guestStack: 9,
  });

  manager.revealNext(hostSocket.id);

  assert.equal(room.carryoverPot, 6);
  assert.equal(room.pot, 0);
  assert.equal(room.showdown.winnerReason, "tie");
  assert.equal(room.matchStatus, "active");
});

test("tie splits the total available chips instead of carrying when someone would stay at zero", () => {
  const { manager, room, hostSocket, hostPlayer, guestPlayer } = createJoinedRoom();

  setClosedRiver(room, hostPlayer, guestPlayer, {
    pot: 3,
    carryoverPot: 5,
    hostStack: 0,
    guestStack: 0,
  });

  manager.revealNext(hostSocket.id);

  assert.equal(room.carryoverPot, 0);
  assert.equal(room.pot, 0);
  assert.equal(room.matchStatus, "active");
  assert.equal(room.stacks[hostPlayer.id] + room.stacks[guestPlayer.id], 8);
  assert.equal(room.showdown.winnerReason, "split");
});

test("game over can be reset back to a fresh 50-chip match", () => {
  const { manager, room, hostSocket, hostPlayer, guestPlayer } = createJoinedRoom();

  setClosedRiver(room, hostPlayer, guestPlayer, {
    pot: 4,
    hostStack: 6,
    guestStack: 0,
  });
  room.board = ["AH", "KH", "QH", "JH", "8C"];
  room.hands = {
    [hostPlayer.id]: ["TH", "2D"],
    [guestPlayer.id]: ["7C", "6D"],
  };

  manager.revealNext(hostSocket.id);
  assert.equal(room.matchStatus, "gameOver");

  manager.resetMatch(hostSocket.id);
  assert.equal(room.matchStatus, "active");
  assert.equal(room.phase, "waiting");
  assert.equal(room.handNumber, 0);
  assert.equal(room.carryoverPot, 0);
  assert.equal(room.stacks[hostPlayer.id], 50);
  assert.equal(room.stacks[guestPlayer.id], 50);
});
