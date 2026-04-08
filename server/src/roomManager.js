import { randomUUID } from "node:crypto";

import { compareHandStrength, createDeck, evaluateSevenCardHand, shuffleDeck } from "./poker.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INITIAL_STACK = 50;
const SMALL_BLIND = 1;
const BIG_BLIND = 2;
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
    pot: 0,
    currentBet: 0,
    currentTurnSeat: null,
    streetContributions: {},
    hasActedThisStreet: {},
    foldedSeat: null,
    showdown: null,
    winnerReason: null,
  };
}

function applyEmptyHandState(room) {
  Object.assign(room, createEmptyHandState());
}

function sortPlayersBySeat(players) {
  return [...players].sort((left, right) => left.seat - right.seat);
}

function getOpenSeat(players) {
  return [0, 1].find((seat) => !players.some((player) => player.seat === seat));
}

function getPlayerBySeat(room, seat) {
  return room.players.find((player) => player.seat === seat) ?? null;
}

function getOpponent(room, playerId) {
  return room.players.find((player) => player.id !== playerId) ?? null;
}

function getOtherSeat(seat) {
  return seat === 0 ? 1 : 0;
}

function isBettingPhase(phase) {
  return BETTING_PHASES.has(phase);
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

function createActionMap(room, initialValue = false) {
  return Object.fromEntries(room.players.map((player) => [player.id, initialValue]));
}

function createContributionMap(room, initialValue = 0) {
  return Object.fromEntries(room.players.map((player) => [player.id, initialValue]));
}

function getEligiblePlayers(room) {
  return room.players.filter((player) => room.hands[player.id]);
}

function getPlayersAbleToAct(room) {
  return getEligiblePlayers(room).filter((player) => room.stacks[player.id] > 0);
}

function getEffectiveRaiseCap(room, actingPlayer) {
  const opponent = getOpponent(room, actingPlayer.id);

  if (!opponent) {
    return room.streetContributions[actingPlayer.id] ?? 0;
  }

  const actingContribution = room.streetContributions[actingPlayer.id] ?? 0;
  const opponentContribution = room.streetContributions[opponent.id] ?? 0;

  return Math.min(
    actingContribution + room.stacks[actingPlayer.id],
    opponentContribution + room.stacks[opponent.id],
  );
}

function getAmountToCall(room, player) {
  return Math.max(0, room.currentBet - (room.streetContributions[player.id] ?? 0));
}

function isStreetClosed(room) {
  if (!isBettingPhase(room.phase)) {
    return true;
  }

  const activePlayers = getEligiblePlayers(room);

  if (activePlayers.length <= 1) {
    return true;
  }

  const playersAbleToAct = getPlayersAbleToAct(room);

  if (playersAbleToAct.length === 0) {
    return true;
  }

  if (room.currentBet === 0) {
    return playersAbleToAct.every((player) => room.hasActedThisStreet[player.id]);
  }

  return playersAbleToAct.every(
    (player) =>
      room.hasActedThisStreet[player.id] &&
      (room.streetContributions[player.id] ?? 0) === room.currentBet,
  );
}

function setTurnOrClose(room, preferredSeat) {
  if (isStreetClosed(room)) {
    room.currentTurnSeat = null;
    return;
  }

  const preferredPlayer = getPlayerBySeat(room, preferredSeat);

  if (preferredPlayer && room.stacks[preferredPlayer.id] > 0 && room.hands[preferredPlayer.id]) {
    room.currentTurnSeat = preferredSeat;
    return;
  }

  const fallback = getPlayersAbleToAct(room)[0];
  room.currentTurnSeat = fallback?.seat ?? null;
}

function preparePostRevealStreet(room, phase, firstToActSeat) {
  room.phase = phase;
  room.currentBet = 0;
  room.streetContributions = createContributionMap(room, 0);
  room.hasActedThisStreet = createActionMap(room, false);
  room.currentTurnSeat = firstToActSeat;
  setTurnOrClose(room, firstToActSeat);
}

function postBlind(room, player, amount) {
  const blindAmount = Math.min(amount, room.stacks[player.id]);
  room.stacks[player.id] -= blindAmount;
  room.pot += blindAmount;
  room.streetContributions[player.id] = blindAmount;
  return blindAmount;
}

function addChips(room, playerId, amount) {
  room.stacks[playerId] += amount;
}

function resetPlayersToInitialStacks(room) {
  room.stacks = {};

  for (const player of room.players) {
    room.stacks[player.id] = INITIAL_STACK;
  }
}

function resetMatchState(room) {
  room.handNumber = 0;
  room.matchStatus = "active";
  room.carryoverPot = 0;
  room.dealerSeat = 0;
  room.smallBlindSeat = 0;
  room.bigBlindSeat = 1;
  resetPlayersToInitialStacks(room);
  applyEmptyHandState(room);
}

function chooseNextDealerSeat(room) {
  if (room.handNumber === 0) {
    return 0;
  }

  return getOtherSeat(room.dealerSeat);
}

function buildSettlementSummary({
  type,
  winnerPlayerId = null,
  winnerSeat = null,
  winnerReason,
  message,
  results = null,
  awardedChips = 0,
  carryoverCreated = 0,
  splitShare = null,
}) {
  return {
    type,
    winnerPlayerId,
    winnerSeat,
    winnerReason,
    message,
    results,
    awardedChips,
    carryoverCreated,
    splitShare,
  };
}

function finalizeHand(room) {
  room.phase = "showdown";
  room.currentTurnSeat = null;
  room.currentBet = 0;
  room.streetContributions = createContributionMap(room, 0);
  room.hasActedThisStreet = createActionMap(room, false);
  room.matchStatus = Object.values(room.stacks).some((stack) => stack === 0) ? "gameOver" : "active";
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
      matchStatus: "active",
      carryoverPot: 0,
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      stacks: {},
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

    if (room.players.length >= 2) {
      throw new Error("房间已满，只支持两位玩家。");
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

    if (room.players.length !== 2) {
      throw new Error("需要两位玩家都在场才能开始。");
    }

    if (room.matchStatus === "gameOver") {
      throw new Error("整场比赛已经结束，请点击重新开赛。");
    }

    if (!["waiting", "showdown"].includes(room.phase)) {
      throw new Error("当前手牌还没有结束。");
    }

    if (Object.values(room.stacks).some((stack) => stack === 0)) {
      room.matchStatus = "gameOver";
      throw new Error("有玩家已经没有筹码，请重新开赛。");
    }

    const dealerSeat = chooseNextDealerSeat(room);
    const smallBlindSeat = dealerSeat;
    const bigBlindSeat = getOtherSeat(dealerSeat);
    const smallBlindPlayer = getPlayerBySeat(room, smallBlindSeat);
    const bigBlindPlayer = getPlayerBySeat(room, bigBlindSeat);

    if (!smallBlindPlayer || !bigBlindPlayer) {
      throw new Error("房间玩家状态异常，无法开始。");
    }

    const deck = shuffleDeck(createDeck());
    const hands = {};

    for (const player of sortPlayersBySeat(room.players)) {
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
    room.pot = 0;
    room.currentBet = 0;
    room.streetContributions = createContributionMap(room, 0);
    room.hasActedThisStreet = createActionMap(room, false);

    const effectiveBlindCap = Math.min(room.stacks[smallBlindPlayer.id], room.stacks[bigBlindPlayer.id]);
    const smallBlindPost = postBlind(room, smallBlindPlayer, Math.min(SMALL_BLIND, effectiveBlindCap));
    const bigBlindPost = postBlind(room, bigBlindPlayer, Math.min(BIG_BLIND, effectiveBlindCap));

    room.currentBet = Math.max(smallBlindPost, bigBlindPost);
    room.currentTurnSeat = smallBlindSeat;
    setTurnOrClose(room, smallBlindSeat);

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

    if (room.players.length !== 2) {
      throw new Error("需要两位玩家都在场才能重新开赛。");
    }

    if (room.matchStatus !== "gameOver") {
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

    const minRaiseTo = room.currentBet + 1;
    const maxRaiseTo = getEffectiveRaiseCap(room, actingPlayer);

    if (maxRaiseTo <= room.currentBet) {
      throw new Error("当前不能继续加注。");
    }

    if (targetBet < minRaiseTo || targetBet > maxRaiseTo) {
      throw new Error(`加注目标必须在 ${minRaiseTo} 到 ${maxRaiseTo} 之间。`);
    }

    const currentContribution = room.streetContributions[actingPlayer.id] ?? 0;
    const additionalCost = targetBet - currentContribution;

    if (additionalCost > room.stacks[actingPlayer.id]) {
      throw new Error("筹码不足，无法完成这次加注。");
    }

    room.stacks[actingPlayer.id] -= additionalCost;
    room.pot += additionalCost;
    room.streetContributions[actingPlayer.id] = targetBet;
    room.currentBet = targetBet;
    room.hasActedThisStreet = createActionMap(room, false);
    room.hasActedThisStreet[actingPlayer.id] = true;

    const opponentSeat = getOtherSeat(actingPlayer.seat);
    setTurnOrClose(room, opponentSeat);

    return room;
  }

  call(socketId) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);
    this.#assertPlayerCanAct(room, actingPlayer);

    const amountToCall = getAmountToCall(room, actingPlayer);
    const paidAmount = Math.min(amountToCall, room.stacks[actingPlayer.id]);

    room.stacks[actingPlayer.id] -= paidAmount;
    room.pot += paidAmount;
    room.streetContributions[actingPlayer.id] = (room.streetContributions[actingPlayer.id] ?? 0) + paidAmount;
    room.hasActedThisStreet[actingPlayer.id] = true;

    const opponentSeat = getOtherSeat(actingPlayer.seat);
    setTurnOrClose(room, opponentSeat);

    return room;
  }

  fold(socketId) {
    const room = this.getRoomForSocket(socketId);
    const actingPlayer = this.getPlayerForSocket(socketId);
    this.#assertPlayerCanAct(room, actingPlayer);

    const winnerSeat = getOtherSeat(actingPlayer.seat);
    const winner = getPlayerBySeat(room, winnerSeat);

    if (!winner) {
      throw new Error("找不到未弃牌的玩家。");
    }

    room.foldedSeat = actingPlayer.seat;
    room.winnerReason = "fold";
    const awardedTotal = room.pot + room.carryoverPot;
    addChips(room, winner.id, awardedTotal);
    room.pot = 0;
    room.carryoverPot = 0;
    room.showdown = buildSettlementSummary({
      type: "fold",
      winnerPlayerId: winner.id,
      winnerSeat,
      winnerReason: "fold",
      message: `${winner.name} 因对手弃牌赢得本手，并收下 ${awardedTotal} 筹码。`,
      awardedChips: awardedTotal,
    });
    finalizeHand(room);

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

    if (!isBettingPhase(room.phase)) {
      throw new Error("当前阶段不能继续开牌。");
    }

    if (!isStreetClosed(room)) {
      throw new Error("本轮下注还没有完成，不能开牌。");
    }

    switch (room.phase) {
      case "preflop":
        room.board.push(room.deck.shift(), room.deck.shift(), room.deck.shift());
        preparePostRevealStreet(room, "flop", room.bigBlindSeat);
        return { room, becameShowdown: false };
      case "flop":
        room.board.push(room.deck.shift());
        preparePostRevealStreet(room, "turn", room.bigBlindSeat);
        return { room, becameShowdown: false };
      case "turn":
        room.board.push(room.deck.shift());
        preparePostRevealStreet(room, "river", room.bigBlindSeat);
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

    room.players = room.players.filter((player) => player.id !== context.playerId);
    delete room.stacks[context.playerId];

    if (room.players.length === 0) {
      this.rooms.delete(room.roomCode);
      return null;
    }

    if (!room.players.some((player) => player.isHost)) {
      room.players[0].isHost = true;
    }

    resetMatchState(room);
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
    const selfContribution = self ? room.streetContributions[self.id] ?? 0 : 0;
    const opponentContribution = opponent ? room.streetContributions[opponent.id] ?? 0 : 0;
    const selfCanAct =
      Boolean(self) &&
      isBettingPhase(room.phase) &&
      room.currentTurnSeat === self.seat &&
      room.stacks[self.id] > 0 &&
      room.matchStatus === "active";
    const maxRaiseTo = self ? getEffectiveRaiseCap(room, self) : 0;
    const minRaiseTo = selfCanAct && maxRaiseTo > room.currentBet ? room.currentBet + 1 : room.currentBet;

    return {
      roomCode: room.roomCode,
      phase: room.phase,
      handNumber: room.handNumber,
      board: room.board,
      selfHoleCards: self ? room.hands[self.id] ?? [] : [],
      opponentCardCount: opponent ? room.hands[opponent.id]?.length ?? 0 : 0,
      revealedOpponentHoleCards:
        room.phase === "showdown" && room.showdown?.type === "showdown" && opponent
          ? room.hands[opponent.id] ?? []
          : [],
      selfStack: self ? room.stacks[self.id] ?? 0 : 0,
      opponentStack: opponent ? room.stacks[opponent.id] ?? 0 : 0,
      pot: room.pot,
      carryoverPot: room.carryoverPot,
      dealerSeat: room.dealerSeat,
      smallBlindSeat: room.smallBlindSeat,
      bigBlindSeat: room.bigBlindSeat,
      currentTurnSeat: room.currentTurnSeat,
      currentBet: room.currentBet,
      selfStreetContribution: selfContribution,
      opponentStreetContribution: opponentContribution,
      selfCallAmount: self ? getAmountToCall(room, self) : 0,
      minRaiseTo,
      maxRaiseTo,
      matchStatus: room.matchStatus,
      foldedSeat: room.foldedSeat,
      winner: room.showdown
        ? {
            seat: room.showdown.winnerSeat,
            playerId: room.showdown.winnerPlayerId,
          }
        : null,
      resolution: room.showdown,
      bestHands:
        room.showdown?.type === "showdown" && room.showdown.results
          ? buildBestHandsMap(room.showdown.results)
          : null,
      showdownResults:
        room.showdown?.type === "showdown"
          ? room.showdown.results.map((result) => ({
              seat: result.seat,
              name: result.name,
              holeCards: result.holeCards,
              handName: result.handName,
              bestCards: result.bestCards,
              isWinner:
                room.showdown.winnerSeat !== null && room.showdown.winnerSeat === result.seat,
            }))
          : null,
      actions: {
        canStartHand:
          Boolean(self?.isHost) &&
          room.players.length === 2 &&
          room.matchStatus === "active" &&
          ["waiting", "showdown"].includes(room.phase),
        canRevealNext:
          Boolean(self?.isHost) &&
          room.players.length === 2 &&
          isBettingPhase(room.phase) &&
          isStreetClosed(room),
        canRaise: selfCanAct && maxRaiseTo > room.currentBet,
        canCall: selfCanAct,
        canFold: selfCanAct,
        canResetMatch:
          Boolean(self?.isHost) &&
          room.players.length === 2 &&
          room.matchStatus === "gameOver",
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

    if (!isBettingPhase(room.phase)) {
      throw new Error("当前不是下注阶段。");
    }

    if (room.matchStatus !== "active") {
      throw new Error("比赛已经结束，请重新开赛。");
    }

    if (room.currentTurnSeat !== actingPlayer.seat) {
      throw new Error("还没有轮到你行动。");
    }

    if (room.stacks[actingPlayer.id] <= 0) {
      throw new Error("你已经没有可用筹码。");
    }
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
    const totalAvailable = room.pot + room.carryoverPot;

    if (comparison !== 0) {
      const winner = comparison > 0 ? results[0] : results[1];
      addChips(room, winner.playerId, totalAvailable);
      room.pot = 0;
      room.carryoverPot = 0;

      return buildSettlementSummary({
        type: "showdown",
        winnerPlayerId: winner.playerId,
        winnerSeat: winner.seat,
        winnerReason: "showdown",
        message: `${winner.name} 在摊牌中获胜，赢下 ${totalAvailable} 筹码。`,
        results,
        awardedChips: totalAvailable,
      });
    }

    const wouldEndMatch = Object.values(room.stacks).some((stack) => stack === 0);

    if (wouldEndMatch) {
      const oddChipSeat = room.dealerSeat;
      const oddChipPlayer = getPlayerBySeat(room, oddChipSeat);
      const firstShare = Math.floor(totalAvailable / 2);
      const secondShare = Math.floor(totalAvailable / 2);
      const oddChip = totalAvailable % 2;

      addChips(room, results[0].playerId, firstShare);
      addChips(room, results[1].playerId, secondShare);

      if (oddChip && oddChipPlayer) {
        addChips(room, oddChipPlayer.id, oddChip);
      }

      room.pot = 0;
      room.carryoverPot = 0;

      return buildSettlementSummary({
        type: "showdown",
        winnerPlayerId: null,
        winnerSeat: null,
        winnerReason: "split",
        message: "本手平局，且有人已无筹码，因此本次底池改为当场平分。",
        results,
        awardedChips: totalAvailable,
        splitShare: {
          seat0: results[0].seat === oddChipSeat ? firstShare + oddChip : firstShare,
          seat1: results[1].seat === oddChipSeat ? secondShare + oddChip : secondShare,
        },
      });
    }

    room.carryoverPot += room.pot;
    room.pot = 0;

    return buildSettlementSummary({
      type: "showdown",
      winnerPlayerId: null,
      winnerSeat: null,
      winnerReason: "tie",
      message: `本手平局，${room.carryoverPot} 筹码将保留到下一手，留给下一位赢家。`,
      results,
      carryoverCreated: room.carryoverPot,
    });
  }
}
