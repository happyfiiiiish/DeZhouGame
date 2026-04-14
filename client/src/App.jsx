import { startTransition, useEffect, useState } from "react";
import { io } from "socket.io-client";

const ROOM_CODE_STORAGE_KEY = "dez-room-code";
const PLAYER_NAME_STORAGE_KEY = "dez-player-name";
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL?.trim() || `${window.location.protocol}//${window.location.hostname}:3001`;

const socket = io(SERVER_URL, {
  autoConnect: true,
  reconnection: true,
});

const SEAT_POSITIONS = {
  0: { x: 50, y: 12 },
  1: { x: 77, y: 20 },
  2: { x: 88, y: 41 },
  3: { x: 78, y: 69 },
  4: { x: 50, y: 79 },
  5: { x: 22, y: 69 },
  6: { x: 12, y: 41 },
  7: { x: 23, y: 20 },
  center: { x: 50, y: 45 },
};

const BET_POSITIONS = {
  0: { x: 50, y: 24 },
  1: { x: 69, y: 28 },
  2: { x: 75, y: 42 },
  3: { x: 67, y: 58 },
  4: { x: 50, y: 62 },
  5: { x: 33, y: 58 },
  6: { x: 25, y: 42 },
  7: { x: 31, y: 28 },
};

const SUIT_META = {
  S: { symbol: "♠", className: "is-black" },
  C: { symbol: "♣", className: "is-black" },
  H: { symbol: "♥", className: "is-red" },
  D: { symbol: "♦", className: "is-red" },
};

const DEFAULT_GAME_STATE = {
  roomStatus: "lobby",
  isJoinLocked: false,
  phase: "waiting",
  handNumber: 0,
  board: [],
  pot: 0,
  totalPot: 0,
  sidePots: [],
  dealerSeat: null,
  smallBlindSeat: null,
  bigBlindSeat: null,
  currentTurnSeat: null,
  currentBet: 0,
  callAmount: 0,
  minRaiseTo: 0,
  maxRaiseTo: 0,
  activePlayerCount: 0,
  seats: Array.from({ length: 8 }, (_, seat) => ({ seat, occupied: false })),
  resolution: null,
  showdownResults: null,
  lastAnimation: null,
  actions: {
    canStartHand: false,
    canRevealNext: false,
    canRaise: false,
    canCall: false,
    canFold: false,
    canResetMatch: false,
  },
};

function getCardDisplay(cardCode) {
  if (!cardCode) {
    return { rank: "", suit: "", className: "is-black" };
  }

  const rank = cardCode.slice(0, -1).replace("T", "10");
  const suit = cardCode.slice(-1);
  const suitMeta = SUIT_META[suit];

  return {
    rank,
    suit: suitMeta.symbol,
    className: suitMeta.className,
  };
}

function getPhaseLabel(phase) {
  switch (phase) {
    case "preflop":
      return "翻牌前";
    case "flop":
      return "翻牌圈";
    case "turn":
      return "转牌圈";
    case "river":
      return "河牌圈";
    case "showdown":
      return "结算";
    default:
      return "等待中";
  }
}

function getRevealButtonLabel(phase) {
  switch (phase) {
    case "preflop":
      return "开翻牌";
    case "flop":
      return "开转牌";
    case "turn":
      return "开河牌";
    case "river":
      return "开始比牌";
    default:
      return "开牌";
  }
}

function getRoomStatusLabel(roomStatus) {
  switch (roomStatus) {
    case "running":
      return "比赛进行中";
    case "finished":
      return "整场已结束";
    default:
      return "大厅招募中";
  }
}

function getSeatRoleTags(seat) {
  const tags = [];

  if (seat.isDealer) {
    tags.push("庄");
  }

  if (seat.isSmallBlind) {
    tags.push("小盲");
  }

  if (seat.isBigBlind) {
    tags.push("大盲");
  }

  if (seat.isHost) {
    tags.push("房主");
  }

  if (seat.isCurrentTurn) {
    tags.push("行动");
  }

  if (seat.isAllIn) {
    tags.push("全压");
  }

  if (seat.isFolded) {
    tags.push("弃牌");
  }

  if (seat.isEliminated) {
    tags.push("淘汰");
  }

  return tags;
}

function getStatusText(roomState, gameState, selfSeat) {
  if (!roomState) {
    return "创建房间后，其他玩家可以在大厅阶段加入，最多支持 8 人同桌。";
  }

  if (roomState.players.length < 2) {
    return "至少需要 2 位玩家才能开始。房主开赛后房间会立刻锁定。";
  }

  if (gameState.roomStatus === "finished") {
    return "现在只剩 1 位玩家还有筹码。房主可以重新开赛，把桌上玩家统一重置到 50。";
  }

  if (gameState.roomStatus === "lobby") {
    return "当前还是大厅阶段，玩家可以继续加入。房主点击“开始整场”后，座位会立即锁定。";
  }

  if (gameState.phase === "showdown") {
    return gameState.resolution?.message ?? "这一手已经结束，房主可以开始下一局。";
  }

  if (gameState.currentTurnSeat === selfSeat?.seat) {
    if (gameState.callAmount > 0) {
      return `轮到你行动。你需要补 ${gameState.callAmount} 筹码，才能跟到 ${gameState.currentBet}。`;
    }

    return "轮到你行动。你可以过牌、加注，或者直接弃牌。";
  }

  if (gameState.actions.canRevealNext) {
    return "这一轮下注已经平齐，房主现在可以继续开牌。";
  }

  return "等待当前行动玩家完成操作。只有这一轮下注平齐后，房主才能继续开牌。";
}

function Card({ cardCode, hidden = false, compact = false, highlight = false }) {
  const display = getCardDisplay(cardCode);
  const className = [
    "playing-card",
    hidden ? "is-hidden" : "",
    compact ? "is-compact" : "",
    highlight ? "is-highlight" : "",
    display.className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      {hidden ? (
        <div className="card-back-pattern" />
      ) : (
        <>
          <span className="card-rank">{display.rank}</span>
          <span className="card-suit">{display.suit}</span>
        </>
      )}
    </div>
  );
}

function SeatCards({ seat }) {
  if (!seat.occupied || !seat.holeCardCount) {
    return null;
  }

  if (seat.revealedHoleCards?.length) {
    return (
      <div className="seat-card-row">
        {seat.revealedHoleCards.map((cardCode, index) => (
          <Card key={`${seat.seat}-${cardCode}-${index}`} cardCode={cardCode} compact />
        ))}
      </div>
    );
  }

  return (
    <div className="seat-card-row">
      {Array.from({ length: seat.holeCardCount }, (_, index) => (
        <Card key={`${seat.seat}-hidden-${index}`} hidden compact />
      ))}
    </div>
  );
}

function SeatNode({ seat }) {
  const className = [
    "table-seat",
    `seat-pos-${seat.seat}`,
    seat.isSelf ? "is-self" : "",
    seat.isCurrentTurn ? "is-turn" : "",
    seat.isFolded ? "is-folded" : "",
    seat.isEliminated ? "is-eliminated" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!seat.occupied) {
    return <div className={`${className} is-empty`}>空位</div>;
  }

  return (
    <div className={className}>
      <div className="seat-head">
        <span className="seat-name">{seat.name}</span>
        <strong>{seat.stack}</strong>
      </div>

      <div className="seat-tags">
        {getSeatRoleTags(seat).map((tag) => (
          <span key={`${seat.seat}-${tag}`} className="mini-badge">
            {tag}
          </span>
        ))}
      </div>

      <SeatCards seat={seat} />

      <div className="seat-meta-line">
        <span>本手 {seat.totalContribution}</span>
        <span>{seat.isEliminated ? "已出局" : seat.isFolded ? "已弃牌" : "仍在手中"}</span>
      </div>
    </div>
  );
}

function SeatBetTray({ seat }) {
  if (!seat.occupied || seat.totalContribution <= 0) {
    return null;
  }

  return (
    <div className={`seat-bet-tray bet-pos-${seat.seat}`}>
      <div className="bet-chip-pile" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <strong>{seat.totalContribution}</strong>
    </div>
  );
}

function ChipAnimationLayer({ animation }) {
  const [tokens, setTokens] = useState([]);

  useEffect(() => {
    if (!animation?.id || !animation.movements?.length) {
      return undefined;
    }

    const nextTokens = animation.movements
      .filter((movement) => movement.amount > 0)
      .map((movement, index) => {
        const from = movement.fromSeat === null ? SEAT_POSITIONS.center : SEAT_POSITIONS[movement.fromSeat];
        const to = movement.toSeat === null ? SEAT_POSITIONS.center : SEAT_POSITIONS[movement.toSeat];

        return {
          id: `${animation.id}-${index}`,
          amount: movement.amount,
          from,
          to,
          active: false,
        };
      });

    setTokens(nextTokens);

    const startFrame = requestAnimationFrame(() => {
      setTokens((current) => current.map((token) => ({ ...token, active: true })));
    });

    const cleanupTimer = window.setTimeout(() => {
      setTokens([]);
    }, 850);

    return () => {
      cancelAnimationFrame(startFrame);
      window.clearTimeout(cleanupTimer);
    };
  }, [animation]);

  return (
    <div className="chip-layer">
      {tokens.map((token) => (
        <div
          key={token.id}
          className={`chip-token ${token.active ? "is-active" : ""}`}
          style={{
            left: `${token.from.x}%`,
            top: `${token.from.y}%`,
            "--dx": token.to.x - token.from.x,
            "--dy": token.to.y - token.from.y,
          }}
        >
          {token.amount}
        </div>
      ))}
    </div>
  );
}

function SelfHandPanel({ selfSeat, gameState }) {
  return (
    <div className="dock-hand">
      <div className="dock-section-title">
        <span>你的手牌</span>
        <strong>{selfSeat ? `筹码 ${selfSeat.stack}` : "未入座"}</strong>
      </div>

      <div className="dock-hand-row">
        {selfSeat?.revealedHoleCards?.length
          ? selfSeat.revealedHoleCards.map((cardCode, index) => (
              <Card key={`${cardCode}-${index}`} cardCode={cardCode} />
            ))
          : [0, 1].map((index) => <Card key={`empty-${index}`} hidden />)}
      </div>

      <div className="dock-hand-meta">
        <span>需补 {gameState.callAmount}</span>
        <span>目标 {gameState.currentBet}</span>
      </div>
    </div>
  );
}

function PlayerRoster({ roomState }) {
  if (!roomState) {
    return null;
  }

  return (
    <div className="roster-list">
      {roomState.players.map((player) => (
        <div key={player.id} className="roster-row">
          <span>{player.name}</span>
          <span>
            {player.isHost ? "房主" : `座位 ${player.seat + 1}`}
            {player.isEliminated ? " · 淘汰" : ""}
            {player.isSelf ? " · 你" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomState, setRoomState] = useState(null);
  const [gameState, setGameState] = useState(DEFAULT_GAME_STATE);
  const [connectionState, setConnectionState] = useState(socket.connected ? "connected" : "connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [raiseInput, setRaiseInput] = useState("");

  useEffect(() => {
    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, playerName.trim());
  }, [playerName]);

  useEffect(() => {
    function restoreRoom() {
      const savedRoomCode = localStorage.getItem(ROOM_CODE_STORAGE_KEY);
      const savedName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "";

      if (savedRoomCode) {
        socket.emit("room:join", {
          roomCode: savedRoomCode,
          name: savedName,
        });
      }
    }

    function handleConnect() {
      setConnectionState("connected");
      restoreRoom();
    }

    function handleDisconnect() {
      setConnectionState("disconnected");
    }

    function handleRoomState(nextRoomState) {
      startTransition(() => {
        setRoomState(nextRoomState);
        setErrorMessage("");
      });

      if (nextRoomState?.roomCode) {
        localStorage.setItem(ROOM_CODE_STORAGE_KEY, nextRoomState.roomCode);
      }
    }

    function handleGameState(nextGameState) {
      startTransition(() => {
        setGameState(nextGameState);
      });
    }

    function handleShowdown(nextGameState) {
      startTransition(() => {
        setGameState(nextGameState);
      });
    }

    function handleError(payload) {
      const message = payload?.message ?? "出现了一个未知错误。";
      setErrorMessage(message);

      if (message.includes("房间不存在")) {
        localStorage.removeItem(ROOM_CODE_STORAGE_KEY);
        setRoomState(null);
      }
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("room:state", handleRoomState);
    socket.on("game:state", handleGameState);
    socket.on("game:showdown", handleShowdown);
    socket.on("app:error", handleError);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("room:state", handleRoomState);
      socket.off("game:state", handleGameState);
      socket.off("game:showdown", handleShowdown);
      socket.off("app:error", handleError);
    };
  }, []);

  useEffect(() => {
    if (gameState.actions.canRaise) {
      setRaiseInput((current) => {
        const parsed = Number(current);

        if (
          !Number.isInteger(parsed) ||
          parsed < gameState.minRaiseTo ||
          parsed > gameState.maxRaiseTo
        ) {
          return String(gameState.minRaiseTo);
        }

        return current;
      });
    } else {
      setRaiseInput("");
    }
  }, [gameState.actions.canRaise, gameState.minRaiseTo, gameState.maxRaiseTo]);

  const selfSeat = gameState.seats.find((seat) => seat.occupied && seat.isSelf) ?? null;
  const connectionLabel =
    connectionState === "connected"
      ? "已连接"
      : connectionState === "connecting"
        ? "连接中"
        : "连接断开";
  const tableStatus = getStatusText(roomState, gameState, selfSeat);
  const revealButtonLabel = getRevealButtonLabel(gameState.phase);
  const controlLabel =
    gameState.roomStatus === "finished"
      ? "重新开赛"
      : gameState.roomStatus === "lobby"
        ? "开始整场"
        : "新一局";
  const parsedRaise = Number(raiseInput);
  const raiseDisabled =
    !gameState.actions.canRaise ||
    !Number.isInteger(parsedRaise) ||
    parsedRaise < gameState.minRaiseTo ||
    parsedRaise > gameState.maxRaiseTo;

  function handleCreateRoom() {
    localStorage.removeItem(ROOM_CODE_STORAGE_KEY);
    socket.emit("room:create", { name: playerName });
  }

  function handleJoinRoom() {
    socket.emit("room:join", {
      roomCode: roomCodeInput,
      name: playerName,
    });
  }

  function handlePrimaryAction() {
    if (gameState.roomStatus === "finished") {
      socket.emit("match:reset");
      return;
    }

    socket.emit("game:startHand");
  }

  function handleRevealNext() {
    socket.emit("game:revealNext");
  }

  function handleCall() {
    socket.emit("game:call");
  }

  function handleFold() {
    socket.emit("game:fold");
  }

  function handleRaise() {
    socket.emit("game:raise", { targetBet: parsedRaise });
  }

  if (!roomState) {
    return (
      <div className="app-shell">
        <div className="background-noise" />

        <main className="lobby-shell">
          <section className="hero-table">
            <div className="hero-copy">
              <p className="eyebrow">LAN Hold'em</p>
              <h1>多人德州扑克</h1>
              <h2>最多 8 人围桌对战，开赛后锁定座位，筹码会直接飞向底池与赢家。</h2>
              <p>
                当前版本支持多人德州下注轮、边池结算、直接输入加注额度，以及更紧凑的牌桌操作布局。
              </p>
            </div>

            <div className="hero-cards">
              {["AS", "KH", "QD", "JC", "TS"].map((cardCode) => (
                <Card key={cardCode} cardCode={cardCode} highlight />
              ))}
            </div>
          </section>

          <section className="lobby-panel">
            <div className="panel-head">
              <span>连接状态</span>
              <strong className={`connection-state is-${connectionState}`}>{connectionLabel}</strong>
            </div>
            <p className="muted-text">服务端地址：{SERVER_URL}</p>

            <label className="field-label" htmlFor="player-name">
              玩家名称
            </label>
            <input
              id="player-name"
              className="text-field"
              maxLength={12}
              placeholder="默认会使用 玩家 1 / 玩家 2"
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
            />

            <button className="primary-button" type="button" onClick={handleCreateRoom}>
              创建房间
            </button>

            <label className="field-label" htmlFor="room-code">
              房间码
            </label>
            <input
              id="room-code"
              className="text-field is-uppercase"
              maxLength={5}
              placeholder="输入 5 位房间码"
              value={roomCodeInput}
              onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
            />
            <button className="secondary-button" type="button" onClick={handleJoinRoom}>
              加入房间
            </button>

            {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell is-table-mode">
      <div className="background-noise" />

      <main className="table-screen">
        <section className="poker-table">
          <ChipAnimationLayer animation={gameState.lastAnimation} />

          <div className="table-felt">
            <header className="table-topbar">
              <div className="floating-panel brand-pill">
                <p className="eyebrow">LAN Hold'em</p>
                <strong>房间 {roomState.roomCode}</strong>
              </div>

              <div className="floating-panel match-pill">
                <span>{getRoomStatusLabel(gameState.roomStatus)}</span>
                <span>阶段：{getPhaseLabel(gameState.phase)}</span>
                <span>活跃：{roomState.activePlayerCount}</span>
              </div>

              <div className="floating-panel stat-pill-group">
                <span>主池 {gameState.pot}</span>
                <span>总池 {gameState.totalPot}</span>
                <span>目标 {gameState.currentBet}</span>
              </div>
            </header>

            <aside className="table-side left-side">
              <div className="floating-panel side-panel">
                <div className="panel-head">
                  <span>桌上玩家</span>
                  <strong>{roomState.players.length} / 8</strong>
                </div>
                <PlayerRoster roomState={roomState} />
              </div>

              <div className="floating-panel side-panel compact-status">
                <div className="panel-head">
                  <span>桌面提示</span>
                  <strong>{connectionLabel}</strong>
                </div>
                <p className="status-copy">{tableStatus}</p>
              </div>
            </aside>

            <aside className="table-side right-side">
              <div className="floating-panel side-panel">
                <div className="panel-head">
                  <span>房主操作</span>
                  <strong>{gameState.isJoinLocked ? "已锁房" : "可加入"}</strong>
                </div>

                <div className="stacked-buttons">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      gameState.roomStatus === "finished"
                        ? !gameState.actions.canResetMatch
                        : !gameState.actions.canStartHand
                    }
                    onClick={handlePrimaryAction}
                  >
                    {controlLabel}
                  </button>

                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!gameState.actions.canRevealNext}
                    onClick={handleRevealNext}
                  >
                    {revealButtonLabel}
                  </button>
                </div>

                {gameState.sidePots.length ? (
                  <div className="side-pot-list side-pot-compact">
                    {gameState.sidePots.map((sidePot) => (
                      <span key={`side-pot-${sidePot.index}`} className="metric-pill">
                        边池 {sidePot.index} · {sidePot.amount}
                      </span>
                    ))}
                  </div>
                ) : null}

                {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
              </div>
            </aside>

            <div className="board-zone centered-board">
              <div className="board-header">
                <div>
                  <p className="eyebrow">牌桌中央</p>
                  <h3>第 {Math.max(gameState.handNumber, 1)} 手</h3>
                </div>

                <div className="board-metrics">
                  <span className="phase-badge">{getPhaseLabel(gameState.phase)}</span>
                </div>
              </div>

              <div className="card-row board-row">
                {gameState.board.map((cardCode, index) => (
                  <Card key={`board-${cardCode}-${index}`} cardCode={cardCode} highlight />
                ))}
                {Array.from({ length: Math.max(5 - gameState.board.length, 0) }, (_, index) => (
                  <Card key={`board-placeholder-${index}`} hidden />
                ))}
              </div>

              {gameState.resolution ? (
                <section className="result-panel">
                  <div className="result-headline">
                    <p className="eyebrow">本手结果</p>
                    <h3>{gameState.resolution.message}</h3>
                  </div>

                  {gameState.showdownResults?.length ? (
                    <div className="result-grid">
                      {gameState.showdownResults.map((result) => (
                        <article
                          key={result.seat}
                          className={`result-entry ${result.isWinner ? "is-winner" : ""}`}
                        >
                          <div className="result-header">
                            <span>{result.name}</span>
                            <strong>{result.handName}</strong>
                          </div>

                          <div className="result-row">
                            {result.holeCards.map((cardCode, index) => (
                              <Card key={`${result.seat}-${cardCode}-${index}`} cardCode={cardCode} compact />
                            ))}
                          </div>

                          <div className="result-row">
                            {result.bestCards.map((cardCode, index) => (
                              <Card
                                key={`${result.seat}-${cardCode}-best-${index}`}
                                cardCode={cardCode}
                                compact
                                highlight
                              />
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>

            <div className="seat-ring">
              {gameState.seats.map((seat) => (
                <SeatNode key={`seat-${seat.seat}`} seat={seat} />
              ))}

              {gameState.seats.map((seat) => (
                <SeatBetTray key={`bet-${seat.seat}`} seat={seat} />
              ))}
            </div>

            <section className="action-dock">
              <SelfHandPanel selfSeat={selfSeat} gameState={gameState} />

              <div className="dock-actions">
                <div className="dock-section-title">
                  <span>你的行动</span>
                  <strong>{selfSeat?.isCurrentTurn ? "轮到你" : "等待中"}</strong>
                </div>

                <div className="action-notes">
                  <span>需补 {gameState.callAmount}</span>
                  <span>最小加到 {gameState.minRaiseTo}</span>
                  <span>最多加到 {gameState.maxRaiseTo}</span>
                </div>

                <div className="raise-row">
                  <input
                    className="text-field"
                    type="number"
                    min={gameState.minRaiseTo}
                    max={gameState.maxRaiseTo}
                    value={raiseInput}
                    onChange={(event) => setRaiseInput(event.target.value)}
                    placeholder={gameState.actions.canRaise ? String(gameState.minRaiseTo) : "当前无法加注"}
                  />
                  <button
                    className="secondary-button raise-button"
                    type="button"
                    disabled={raiseDisabled}
                    onClick={handleRaise}
                  >
                    加注
                  </button>
                </div>

                <div className="action-grid">
                  <button
                    className="secondary-button action-button"
                    type="button"
                    disabled={!gameState.actions.canCall}
                    onClick={handleCall}
                  >
                    {gameState.callAmount > 0 ? `过牌 / 跟随 ${gameState.callAmount}` : "过牌 / 跟随"}
                  </button>

                  <button
                    className="danger-button action-button"
                    type="button"
                    disabled={!gameState.actions.canFold}
                    onClick={handleFold}
                  >
                    弃牌
                  </button>
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
