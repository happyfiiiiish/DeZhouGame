import { randomUUID } from "node:crypto";

import { compareHandStrength, createDeck, evaluateSevenCardHand, shuffleDeck } from "./poker.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INITIAL_STACK = 50;
const SMALL_BLIND = 1;
const BIG_BLIND = 2;
const MAX_PLAYERS = 8;
const BETTING_PHASES = new Set(["preflop", "flop", "turn", "river"]);

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

function createEmptyHandState() {
  return {
    phase: "waiting",
    board: [],
    deck: [],
    hands: {},
    currentBet: 0,
    currentTurnSeat: null,
    streetContributions: {},
    totalHandContributions: {},
    hasActedThisStreet: {},
    foldedPlayerIds: [],
    allInPlayerIds: [],
    showdown: null,
    lastAnimation: null,
  };
}

function applyEmptyHandState(room) {
  Object.assign(room, createEmptyHandState());
}

function sortPlayersBySeat(players) {
  return [...players].sort((left, right) => left.seat - right.seat);
}

function getOpenSeat(players) {
  return Array.from({ length: MAX_PLAYERS }, (_, seat) => seat).find(
    (seat) => !players.some((player) => player.seat === seat),
  );
}

function isBettingPhase(phase) {
  return BETTING_PHASES.has(phase);
}

function getPlayerBySeat(room, seat) {
  return room.players.find((player) => player.seat === seat) ?? null;
}

function createActionMap(room, initialValue = false) {
  return Object.fromEntries(room.players.map((player) => [player.id, initialValue]));
}

function createContributionMap(room, initialValue = 0) {
  return Object.fromEntries(room.players.map((player) => [player.id, initialValue]));
}

function getPlayerIdSet(values) {
  return new Set(values);
}

function sumContributions(contributions) {
  return Object.values(contributions).reduce((total, amount) => total + amount, 0);
}

function getLivePlayers(room) {
  return sortPlayersBySeat(room.players).filter((player) => (room.stacks[player.id] ?? 0) > 0);
}

function getPlayersInHand(room) {
  return sortPlayersBySeat(room.players).filter((player) => Boolean(room.hands[player.id]));
}

function getContenders(room) {
  const folded = getPlayerIdSet(room.foldedPlayerIds);
  return getPlayersInHand(room).filter((player) => !folded.has(player.id));
}

function getActionablePlayers(room) {
  const allIn = getPlayerIdSet(room.allInPlayerIds);
  return getContenders(room).filter(
    (player) => (room.stacks[player.id] ?? 0) > 0 && !allIn.has(player.id),
  );
}

function getAmountToCall(room, player) {
  return Math.max(0, room.currentBet - (room.streetContributions[player.id] ?? 0));
}

function getNextSeatFromOrderedSeats(orderedSeats, fromSeat) {
  if (!orderedSeats.length) {
    return null;
  }

  if (fromSeat === null || fromSeat === undefined) {
    return orderedSeats[0];
  }

  const currentIndex = orderedSeats.findIndex((seat) => seat === fromSeat);

  if (currentIndex < 0) {
    return orderedSeats[0];
  }

  return orderedSeats[(currentIndex + 1) % orderedSeats.length];
}

function getNextLiveSeat(room, fromSeat) {
  return getNextSeatFromOrderedSeats(
    getLivePlayers(room).map((player) => player.seat),
    fromSeat,
  );
}

function getNextActionableSeat(room, fromSeat, inclusive = false) {
  const orderedSeats = getActionablePlayers(room).map((player) => player.seat);

  if (!orderedSeats.length) {
    return null;
  }

  if (inclusive && orderedSeats.includes(fromSeat)) {
    return fromSeat;
  }

  return getNextSeatFromOrderedSeats(orderedSeats, fromSeat);
}

function markAllInIfNeeded(room, playerId) {
  if ((room.stacks[playerId] ?? 0) === 0 && !room.allInPlayerIds.includes(playerId)) {
    room.allInPlayerIds.push(playerId);
  }
}

function buildAnimation(room, type, movements) {
  room.animationCounter += 1;
  room.lastAnimation = {
    id: room.animationCounter,
    type,
    movements,
    potSnapshot: sumContributions(room.totalHandContributions),
  };
}

function buildPublicPots(room) {
  const contributions = room.totalHandContributions;
  const contributorIds = Object.keys(contributions).filter((playerId) => (contributions[playerId] ?? 0) > 0);
  const contenderIds = new Set(getContenders(room).map((player) => player.id));

  if (!contributorIds.length) {
    return {
      mainPot: 0,
      sidePots: [],
      totalPot: 0,
      allPots: [],
    };
  }

  const levels = [...new Set(contributorIds.map((playerId) => contributions[playerId]))]
    .filter((amount) => amount > 0)
    .sort((left, right) => left - right);

  const allPots = [];
  let previousLevel = 0;

  for (const level of levels) {
    const participatingIds = contributorIds.filter((playerId) => contributions[playerId] >= level);
    const amount = (level - previousLevel) * participatingIds.length;
    const eligiblePlayerIds = participatingIds.filter((playerId) => contenderIds.has(playerId));

    if (amount > 0) {
      allPots.push({ amount, eligiblePlayerIds });
    }

    previousLevel = level;
  }

  return {
    mainPot: allPots[0]?.amount ?? 0,
    sidePots: allPots.slice(1).map((pot, index) => ({
      index: index + 1,
      amount: pot.amount,
      eligiblePlayerIds: pot.eligiblePlayerIds,
    })),
    totalPot: allPots.reduce((total, pot) => total + pot.amount, 0),
    allPots,
  };
}

function isStreetClosed(room) {
  if (!isBettingPhase(room.phase)) {
    return true;
  }

  const contenders = getContenders(room);

  if (contenders.length <= 1) {
    return true;
  }

  const actionablePlayers = getActionablePlayers(room);

  if (!actionablePlayers.length) {
    return true;
  }

  if (room.currentBet === 0) {
    return actionablePlayers.every((player) => room.hasActedThisStreet[player.id]);
  }

  return actionablePlayers.every(
    (player) =>
      room.hasActedThisStreet[player.id] &&
      (room.streetContributions[player.id] ?? 0) === room.currentBet,
  );
}

function setTurnOrClose(room, preferredSeat, inclusive = true) {
  if (isStreetClosed(room)) {
    room.currentTurnSeat = null;
    return;
  }

  room.currentTurnSeat = getNextActionableSeat(room, preferredSeat, inclusive);
}

function postChips(room, player, requestedAmount) {
  const available = room.stacks[player.id] ?? 0;
  const actualAmount = Math.max(0, Math.min(requestedAmount, available));
  room.stacks[player.id] = available - actualAmount;
  room.streetContributions[player.id] = (room.streetContributions[player.id] ?? 0) + actualAmount;
  room.totalHandContributions[player.id] = (room.totalHandContributions[player.id] ?? 0) + actualAmount;
  markAllInIfNeeded(room, player.id);
  return actualAmount;
}

function buildShowdownResults(room) {
  return getContenders(room).map((player) => {
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
}

function compareResults(left, right) {
  return compareHandStrength(left.strength, right.strength);
}

function getOddChipOrder(room, eligibleWinnerIds) {
  const orderedSeats = sortPlayersBySeat(room.players)
    .filter((player) => eligibleWinnerIds.includes(player.id))
    .map((player) => player.seat);

  if (!orderedSeats.length) {
    return [];
  }

  const firstSeat = getNextSeatFromOrderedSeats(orderedSeats, room.dealerSeat);
  const firstIndex = orderedSeats.findIndex((seat) => seat === firstSeat);

  if (firstIndex < 0) {
    return orderedSeats;
  }

  return [...orderedSeats.slice(firstIndex), ...orderedSeats.slice(0, firstIndex)];
}

function finalizeHand(room) {
  room.phase = "showdown";
  room.currentBet = 0;
  room.currentTurnSeat = null;
  room.hasActedThisStreet = createActionMap(room, false);
  room.eliminatedPlayerIds = room.players
    .filter((player) => (room.stacks[player.id] ?? 0) === 0)
    .map((player) => player.id);

  if (getLivePlayers(room).length <= 1) {
    room.roomStatus = "finished";
    room.isJoinLocked = false;
  } else {
    room.roomStatus = "running";
    room.isJoinLocked = true;
  }
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

function createSeatSnapshot(room, viewerId) {
  const viewer = room.players.find((player) => player.id === viewerId) ?? null;
  const showdownOpen = room.showdown?.type === "showdown";
  const folded = getPlayerIdSet(room.foldedPlayerIds);
  const allIn = getPlayerIdSet(room.allInPlayerIds);
  const eliminated = getPlayerIdSet(room.eliminatedPlayerIds);

  return Array.from({ length: MAX_PLAYERS }, (_, seat) => {
    const player = getPlayerBySeat(room, seat);

    if (!player) {
      return {
        seat,
        occupied: false,
      };
    }

    return {
      seat,
      occupied: true,
      playerId: player.id,
      name: player.name,
      stack: room.stacks[player.id] ?? 0,
      isHost: player.isHost,
      isSelf: player.id === viewerId,
      isDealer: room.dealerSeat === seat,
      isSmallBlind: room.smallBlindSeat === seat,
      isBigBlind: room.bigBlindSeat === seat,
      isCurrentTurn: room.currentTurnSeat === seat,
      isFolded: folded.has(player.id),
      isAllIn: allIn.has(player.id),
      isEliminated: eliminated.has(player.id),
      isActivePlayer: (room.stacks[player.id] ?? 0) > 0 && !eliminated.has(player.id),
      holeCardCount: room.hands[player.id] ? 2 : 0,
      revealedHoleCards:
        player.id === viewerId || showdownOpen ? room.hands[player.id] ?? [] : [],
      streetContribution: room.streetContributions[player.id] ?? 0,
      totalContribution: room.totalHandContributions[player.id] ?? 0,
      isSelfSeat: viewer ? viewer.seat === seat : false,
    };
  });
}

function resetMatchState(room) {
  room.roomStatus = "lobby";
  room.isJoinLocked = false;
  room.handNumber = 0;
  room.dealerSeat = null;
  room.smallBlindSeat = null;
  room.bigBlindSeat = null;
  room.eliminatedPlayerIds = [];
  room.stacks = {};

  for (const player of room.players) {
    room.stacks[player.id] = INITIAL_STACK;
  }

  applyEmptyHandState(room);
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
      handNumber: 0,
      roomStatus: "lobby",
      isJoinLocked: false,
      maxPlayers: MAX_PLAYERS,
      dealerSeat: null,
      smallBlindSeat: null,
      bigBlindSeat: null,
      stacks: {},
      eliminatedPlayerIds: [],
      animationCounter: 0,
      ...createEmptyHandState(),
    };

    this.rooms.set(roomCode, room);
    const player = this.#addPlayer(room, socket, name, true);
    room.stacks[player.id] = INITIAL_STACK;

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

    if (room.isJoinLocked && room.roomStatus === "running") {
      throw new Error("本场比赛已开始，暂不允许加入。");
    }

    if (room.players.length >= MAX_PLAYERS) {
      throw new Error("房间已满，最多支持 8 位玩家。");
    }

    const player = this.#addPlayer(room, socket, name, false);
    room.stacks[player.id] = INITIAL_STACK;

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

    if (room.players.length < 2) {
      throw new Error("至少需要 2 位玩家才能开始。");
    }

    if (room.roomStatus === "finished") {
      throw new Error("整场比赛已经结束，请先重新开赛。");
    }

    if (!["waiting", "showdown"].includes(room.phase)) {
      throw new Error("当前这一手还没有结束。");
    }

    const livePlayers = getLivePlayers(room);

    if (livePlayers.length < 2) {
      room.roomStatus = "finished";
      room.isJoinLocked = false;
      throw new Error("当前不足两位仍有筹码的玩家，请重新开赛或等待更多玩家加入。");
    }

    if (room.roomStatus === "lobby") {
      room.roomStatus = "running";
      room.isJoinLocked = true;
    }

    const dealerSeat = getNextLiveSeat(room, room.dealerSeat);
    const isHeadsUp = livePlayers.length === 2;
    const smallBlindSeat = isHeadsUp ? dealerSeat : getNextLiveSeat(room, dealerSeat);
    const bigBlindSeat = getNextLiveSeat(room, smallBlindSeat);
    const smallBlindPlayer = getPlayerBySeat(room, smallBlindSeat);
    const bigBlindPlayer = getPlayerBySeat(room, bigBlindSeat);

    if (!smallBlindPlayer || !bigBlindPlayer) {
      throw new Error("房间玩家状态异常，无法开始。");
    }

    const deck = shuffleDeck(createDeck());
    const hands = {};

    for (const player of livePlayers) {
      hands[player.id] = [deck.shift(), deck.shift()];
    }

    applyEmptyHandState(room);
    room.handNumber += 1;
    room.dealerSeat = dealerSeat;
    room.smallBlindSeat = smallBlindSeat;
    room.bigBlindSeat = bigBlindSeat;
    room.phase = "preflop";
    room.deck = deck;
    room.hands = hands;
    room.streetContributions = createContributionMap(room, 0);
    room.totalHandContributions = createContributionMap(room, 0);
    room.hasActedThisStreet = createActionMap(room, false);

    const postedSmallBlind = postChips(room, smallBlindPlayer, SMALL_BLIND);
    const postedBigBlind = postChips(room, bigBlindPlayer, BIG_BLIND);
    room.currentBet = Math.max(postedSmallBlind, postedBigBlind);

    const firstSeat = isHeadsUp ? dealerSeat : getNextLiveSeat(room, bigBlindSeat);
    room.currentTurnSeat = firstSeat;
    setTurnOrClose(room, firstSeat, true);

    buildAnimation(room, "postBlind", [
      { fromSeat: smallBlindSeat, toSeat: null, amount: postedSmallBlind },
      { fromSeat: bigBlindSeat, toSeat: null, amount: postedBigBlind },
    ]);

    return room;
  }

  resetMatch(socketId) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);

    if (!room || !actingPlayer) {
      throw new Error("你还没有进入房间。");
    }

    if (!actingPlayer.isHost) {
      throw new Error("只有房主可以重新开赛。");
    }

    if (room.roomStatus !== "finished") {
      throw new Error("当前比赛还没有结束。");
    }

    resetMatchState(room);
    return room;
  }

  raiseTo(socketId, targetBetInput) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);
    this.#assertPlayerCanAct(room, actingPlayer);

    const targetBet = Number(targetBetInput);

    if (!Number.isInteger(targetBet)) {
      throw new Error("加注金额必须是整数。");
    }

    const currentContribution = room.streetContributions[actingPlayer.id] ?? 0;
    const minRaiseTo = room.currentBet + 1;
    const maxRaiseTo = currentContribution + (room.stacks[actingPlayer.id] ?? 0);

    if (maxRaiseTo <= room.currentBet) {
      throw new Error("当前已经无法继续加注。");
    }

    if (targetBet < minRaiseTo || targetBet > maxRaiseTo) {
      throw new Error(`加注目标必须在 ${minRaiseTo} 到 ${maxRaiseTo} 之间。`);
    }

    const addAmount = targetBet - currentContribution;
    postChips(room, actingPlayer, addAmount);
    room.currentBet = targetBet;
    room.hasActedThisStreet = createActionMap(room, false);
    room.hasActedThisStreet[actingPlayer.id] = true;

    const nextSeat = getNextActionableSeat(room, actingPlayer.seat, false);
    setTurnOrClose(room, nextSeat, true);

    buildAnimation(room, "bet", [
      { fromSeat: actingPlayer.seat, toSeat: null, amount: addAmount },
    ]);

    return room;
  }

  call(socketId) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);
    this.#assertPlayerCanAct(room, actingPlayer);

    const amountToCall = getAmountToCall(room, actingPlayer);
    const paidAmount = postChips(room, actingPlayer, amountToCall);
    room.hasActedThisStreet[actingPlayer.id] = true;

    const nextSeat = getNextActionableSeat(room, actingPlayer.seat, false);
    setTurnOrClose(room, nextSeat, true);

    buildAnimation(room, amountToCall > 0 ? "call" : "check", [
      { fromSeat: actingPlayer.seat, toSeat: null, amount: paidAmount },
    ]);

    return room;
  }

  fold(socketId) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);
    this.#assertPlayerCanAct(room, actingPlayer);

    if (!room.foldedPlayerIds.includes(actingPlayer.id)) {
      room.foldedPlayerIds.push(actingPlayer.id);
    }

    const contenders = getContenders(room);

    if (contenders.length === 1) {
      const winner = contenders[0];
      const totalWon = sumContributions(room.totalHandContributions);
      room.stacks[winner.id] = (room.stacks[winner.id] ?? 0) + totalWon;
      room.showdown = {
        type: "fold",
        winnerPlayerId: winner.id,
        winnerSeat: winner.seat,
        winnerReason: "fold",
        message: `${winner.name} 因其他玩家弃牌，直接赢下 ${totalWon} 筹码。`,
        totalPot: totalWon,
        winners: [{ playerId: winner.id, seat: winner.seat, amount: totalWon }],
      };

      buildAnimation(room, "foldWin", [
        { fromSeat: null, toSeat: winner.seat, amount: totalWon },
      ]);

      finalizeHand(room);
      return room;
    }

    room.hasActedThisStreet[actingPlayer.id] = true;
    const nextSeat = getNextActionableSeat(room, actingPlayer.seat, false);
    setTurnOrClose(room, nextSeat, true);

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

    if (!isBettingPhase(room.phase)) {
      throw new Error("当前阶段不能继续开牌。");
    }

    if (!isStreetClosed(room)) {
      throw new Error("这一轮下注还没有平齐，不能继续开牌。");
    }

    switch (room.phase) {
      case "preflop":
        room.board.push(room.deck.shift(), room.deck.shift(), room.deck.shift());
        this.#prepareNextStreet(room, "flop");
        return { room, becameShowdown: false };
      case "flop":
        room.board.push(room.deck.shift());
        this.#prepareNextStreet(room, "turn");
        return { room, becameShowdown: false };
      case "turn":
        room.board.push(room.deck.shift());
        this.#prepareNextStreet(room, "river");
        return { room, becameShowdown: false };
      case "river":
        room.showdown = this.#buildShowdown(room);
        finalizeHand(room);
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

    const leavingPlayer = room.players.find((player) => player.id === context.playerId) ?? null;

    room.players = room.players.filter((player) => player.id !== context.playerId);
    delete room.stacks[context.playerId];
    delete room.hands[context.playerId];
    delete room.streetContributions[context.playerId];
    delete room.totalHandContributions[context.playerId];
    delete room.hasActedThisStreet[context.playerId];
    room.foldedPlayerIds = room.foldedPlayerIds.filter((playerId) => playerId !== context.playerId);
    room.allInPlayerIds = room.allInPlayerIds.filter((playerId) => playerId !== context.playerId);
    room.eliminatedPlayerIds = room.eliminatedPlayerIds.filter((playerId) => playerId !== context.playerId);

    if (room.players.length === 0) {
      this.rooms.delete(room.roomCode);
      return null;
    }

    if (!room.players.some((player) => player.isHost)) {
      room.players[0].isHost = true;
    }

    if (room.roomStatus === "running" && leavingPlayer && isBettingPhase(room.phase)) {
      const contenders = getContenders(room);

      if (contenders.length === 1) {
        const winner = contenders[0];
        const totalWon = sumContributions(room.totalHandContributions);
        room.stacks[winner.id] = (room.stacks[winner.id] ?? 0) + totalWon;
        room.showdown = {
          type: "fold",
          winnerPlayerId: winner.id,
          winnerSeat: winner.seat,
          winnerReason: "disconnect",
          message: `${winner.name} 因其他玩家离开房间，直接赢下 ${totalWon} 筹码。`,
          totalPot: totalWon,
          winners: [{ playerId: winner.id, seat: winner.seat, amount: totalWon }],
        };
        buildAnimation(room, "foldWin", [
          { fromSeat: null, toSeat: winner.seat, amount: totalWon },
        ]);
        finalizeHand(room);
      } else if (room.currentTurnSeat === leavingPlayer.seat) {
        const nextSeat = getNextActionableSeat(room, leavingPlayer.seat, false);
        setTurnOrClose(room, nextSeat, true);
      }
    }

    if (getLivePlayers(room).length <= 1) {
      room.roomStatus = "finished";
      room.isJoinLocked = false;
    }

    return room;
  }

  buildRoomState(room, playerId) {
    const self = room.players.find((player) => player.id === playerId) ?? null;

    return {
      roomCode: room.roomCode,
      roomStatus: room.roomStatus,
      isJoinLocked: room.isJoinLocked,
      maxPlayers: room.maxPlayers,
      activePlayerCount: getLivePlayers(room).length,
      players: sortPlayersBySeat(room.players).map((player) => ({
        id: player.id,
        seat: player.seat,
        name: player.name,
        isHost: player.isHost,
        isSelf: player.id === playerId,
        isEliminated: (room.stacks[player.id] ?? 0) === 0,
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
    const self = room.players.find((player) => player.id === playerId) ?? null;
    const selfCanAct =
      Boolean(self) &&
      room.roomStatus === "running" &&
      isBettingPhase(room.phase) &&
      room.currentTurnSeat === self.seat &&
      !room.foldedPlayerIds.includes(self.id) &&
      !room.allInPlayerIds.includes(self.id) &&
      (room.stacks[self.id] ?? 0) > 0;
    const selfContribution = self ? room.streetContributions[self.id] ?? 0 : 0;
    const maxRaiseTo = self ? selfContribution + (room.stacks[self.id] ?? 0) : 0;
    const minRaiseTo = selfCanAct && maxRaiseTo > room.currentBet ? room.currentBet + 1 : room.currentBet;
    const pots = buildPublicPots(room);
    const showdownResults = room.showdown?.type === "showdown" ? room.showdown.results : null;

    return {
      roomCode: room.roomCode,
      roomStatus: room.roomStatus,
      isJoinLocked: room.isJoinLocked,
      phase: room.phase,
      handNumber: room.handNumber,
      board: room.board,
      pot: pots.mainPot,
      totalPot: pots.totalPot,
      sidePots: pots.sidePots,
      dealerSeat: room.dealerSeat,
      smallBlindSeat: room.smallBlindSeat,
      bigBlindSeat: room.bigBlindSeat,
      currentTurnSeat: room.currentTurnSeat,
      currentBet: room.currentBet,
      callAmount: self ? getAmountToCall(room, self) : 0,
      minRaiseTo,
      maxRaiseTo,
      matchStatus: room.roomStatus === "finished" ? "gameOver" : "active",
      foldedPlayerIds: room.foldedPlayerIds,
      allInPlayerIds: room.allInPlayerIds,
      eliminatedPlayerIds: room.eliminatedPlayerIds,
      activePlayerCount: getLivePlayers(room).length,
      seats: createSeatSnapshot(room, playerId),
      resolution: room.showdown,
      bestHands:
        showdownResults && showdownResults.length ? buildBestHandsMap(showdownResults) : null,
      showdownResults:
        showdownResults?.map((result) => ({
          seat: result.seat,
          name: result.name,
          holeCards: result.holeCards,
          handName: result.handName,
          bestCards: result.bestCards,
          isWinner: room.showdown.winners?.some((winner) => winner.playerId === result.playerId) ?? false,
        })) ?? null,
      lastAnimation: room.lastAnimation,
      actions: {
        canStartHand:
          Boolean(self?.isHost) &&
          room.players.length >= 2 &&
          room.roomStatus !== "finished" &&
          ["waiting", "showdown"].includes(room.phase) &&
          getLivePlayers(room).length >= 2,
        canRevealNext:
          Boolean(self?.isHost) && isBettingPhase(room.phase) && isStreetClosed(room),
        canRaise: selfCanAct && maxRaiseTo > room.currentBet,
        canCall: selfCanAct,
        canFold: selfCanAct,
        canResetMatch: Boolean(self?.isHost) && room.roomStatus === "finished",
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

  #assertPlayerCanAct(room, actingPlayer) {
    if (!room || !actingPlayer) {
      throw new Error("你还没有进入房间。");
    }

    if (room.roomStatus !== "running") {
      throw new Error("当前比赛不在进行中。");
    }

    if (!isBettingPhase(room.phase)) {
      throw new Error("当前不是下注阶段。");
    }

    if (room.currentTurnSeat !== actingPlayer.seat) {
      throw new Error("还没有轮到你行动。");
    }

    if ((room.stacks[actingPlayer.id] ?? 0) <= 0) {
      throw new Error("你已经没有可用筹码。");
    }

    if (room.foldedPlayerIds.includes(actingPlayer.id)) {
      throw new Error("你已经弃牌，不能继续行动。");
    }
  }

  #prepareNextStreet(room, nextPhase) {
    room.phase = nextPhase;
    room.currentBet = 0;
    room.currentTurnSeat = null;
    room.streetContributions = createContributionMap(room, 0);
    room.hasActedThisStreet = createActionMap(room, false);

    const firstSeatAfterDealer = getNextActionableSeat(room, room.dealerSeat, false);
    room.currentTurnSeat = firstSeatAfterDealer;
    setTurnOrClose(room, firstSeatAfterDealer, true);
  }

  #buildShowdown(room) {
    const results = buildShowdownResults(room);
    const resultMap = new Map(results.map((result) => [result.playerId, result]));
    const { allPots, totalPot } = buildPublicPots(room);
    const winnings = new Map(results.map((result) => [result.playerId, 0]));
    const potResults = [];

    for (const pot of allPots) {
      const eligibleResults = pot.eligiblePlayerIds
        .map((playerId) => resultMap.get(playerId))
        .filter(Boolean);

      if (!eligibleResults.length) {
        continue;
      }

      eligibleResults.sort((left, right) => compareResults(right, left));
      const bestResult = eligibleResults[0];
      const winnerResults = eligibleResults.filter(
        (result) => compareResults(result, bestResult) === 0,
      );
      const winnerIds = winnerResults.map((result) => result.playerId);
      const share = Math.floor(pot.amount / winnerIds.length);
      let remainder = pot.amount % winnerIds.length;

      for (const winnerId of winnerIds) {
        winnings.set(winnerId, (winnings.get(winnerId) ?? 0) + share);
      }

      if (remainder > 0) {
        const oddChipOrder = getOddChipOrder(room, winnerIds);

        for (const seat of oddChipOrder) {
          if (remainder === 0) {
            break;
          }

          const player = getPlayerBySeat(room, seat);

          if (player) {
            winnings.set(player.id, (winnings.get(player.id) ?? 0) + 1);
            remainder -= 1;
          }
        }
      }

      potResults.push({
        amount: pot.amount,
        winnerIds,
        eligiblePlayerIds: pot.eligiblePlayerIds,
      });
    }

    const winners = [];
    const animationMovements = [];

    for (const [playerId, amount] of winnings.entries()) {
      if (amount <= 0) {
        continue;
      }

      room.stacks[playerId] = (room.stacks[playerId] ?? 0) + amount;
      const player = room.players.find((candidate) => candidate.id === playerId);

      if (player) {
        winners.push({
          playerId,
          seat: player.seat,
          amount,
        });
        animationMovements.push({
          fromSeat: null,
          toSeat: player.seat,
          amount,
        });
      }
    }

    buildAnimation(
      room,
      winners.length > 1 ? "splitPot" : "showdownWin",
      animationMovements,
    );

    const singleWinner = winners.length === 1 ? winners[0] : null;

    return {
      type: "showdown",
      winnerPlayerId: singleWinner?.playerId ?? null,
      winnerSeat: singleWinner?.seat ?? null,
      winnerReason: singleWinner ? "showdown" : "split",
      message:
        singleWinner
          ? `${room.players.find((player) => player.id === singleWinner.playerId)?.name} 赢下本手 ${totalPot} 筹码。`
          : "本手进入多人结算，主池与边池已按牌力完成分配。",
      results,
      winners,
      potResults,
      totalPot,
    };
  }
}
