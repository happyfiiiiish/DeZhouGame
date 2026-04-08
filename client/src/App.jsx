import { startTransition, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const ROOM_CODE_STORAGE_KEY = "dez-room-code";
const PLAYER_NAME_STORAGE_KEY = "dez-player-name";
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL?.trim() || `${window.location.protocol}//${window.location.hostname}:3001`;

const socket = io(SERVER_URL, {
  autoConnect: true,
  reconnection: true,
});

const SUIT_META = {
  S: { symbol: "♠", className: "is-black" },
  C: { symbol: "♣", className: "is-black" },
  H: { symbol: "♥", className: "is-red" },
  D: { symbol: "♦", className: "is-red" },
};

const DEFAULT_GAME_STATE = {
  phase: "waiting",
  board: [],
  selfHoleCards: [],
  opponentCardCount: 0,
  revealedOpponentHoleCards: [],
  selfStack: 0,
  opponentStack: 0,
  pot: 0,
  carryoverPot: 0,
  dealerSeat: 0,
  smallBlindSeat: 0,
  bigBlindSeat: 1,
  currentTurnSeat: null,
  currentBet: 0,
  selfStreetContribution: 0,
  opponentStreetContribution: 0,
  selfCallAmount: 0,
  minRaiseTo: 0,
  maxRaiseTo: 0,
  handNumber: 0,
  matchStatus: "active",
  foldedSeat: null,
  resolution: null,
  showdownResults: null,
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
      return "等待开局";
  }
}

function getRevealButtonLabel(phase) {
  switch (phase) {
    case "preflop":
      return "开牌 · 翻牌";
    case "flop":
      return "开牌 · 转牌";
    case "turn":
      return "开牌 · 河牌";
    case "river":
      return "开牌 · 比牌";
    default:
      return "开牌";
  }
}

function getBlindBadge(seat, gameState) {
  if (seat === gameState.dealerSeat && seat === gameState.smallBlindSeat) {
    return "庄家 / 小盲";
  }

  if (seat === gameState.bigBlindSeat) {
    return "大盲";
  }

  if (seat === gameState.smallBlindSeat) {
    return "小盲";
  }

  if (seat === gameState.dealerSeat) {
    return "庄家";
  }

  return "";
}

function getStatusText(roomState, gameState) {
  if (!roomState) {
    return "创建房间后，另一位玩家输入房间码加入。同一局域网下即可双人对战。";
  }

  if (roomState.players.length < 2) {
    return "等待另一位玩家加入。两位玩家都在场后，房主可以开始比赛。";
  }

  if (gameState.matchStatus === "gameOver") {
    return "有玩家筹码归零，本场比赛结束。房主可以点击“重新开赛”，将双方筹码恢复到 50。";
  }

  if (gameState.phase === "waiting") {
    return "比赛已准备就绪。房主可以开始新一手，系统会自动扣除小盲 1 和大盲 2。";
  }

  if (gameState.phase === "showdown") {
    return gameState.resolution?.message ?? "本手已经结束，房主可以开始下一手。";
  }

  if (gameState.currentTurnSeat === roomState.self?.seat) {
    if (gameState.selfCallAmount > 0) {
      return `轮到你行动。当前需要补到 ${gameState.currentBet}，还差 ${gameState.selfCallAmount} 筹码。`;
    }

    return "轮到你行动。你可以选择过牌/跟随、加注或弃牌。";
  }

  if (gameState.actions.canRevealNext) {
    return "这一街下注已经平齐，房主现在可以点击“开牌”推进公共牌。";
  }

  return "等待对手完成这一街行动。只有双方本轮投入相等时，房主才可以继续开牌。";
}

function Card({ cardCode, hidden = false, highlight = false, compact = false }) {
  const display = getCardDisplay(cardCode);
  const className = [
    "playing-card",
    hidden ? "is-hidden" : "",
    highlight ? "is-highlight" : "",
    compact ? "is-compact" : "",
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

function SeatSummary({
  label,
  player,
  stack,
  contribution,
  isSelf = false,
  isActiveTurn = false,
  blindBadge = "",
}) {
  if (!player) {
    return (
      <div className="seat-summary">
        <div className="seat-title">
          <span className="seat-label">{label}</span>
          <strong>等待玩家加入</strong>
        </div>
      </div>
    );
  }

  return (
    <div className={`seat-summary ${isActiveTurn ? "is-active-turn" : ""}`}>
      <div className="seat-title">
        <span className="seat-label">
          {label}
          {player.isHost ? " · 房主" : ""}
        </span>
        <strong>{player.name}</strong>
      </div>

      <div className="seat-badges">
        {blindBadge ? <span className="mini-badge">{blindBadge}</span> : null}
        {isActiveTurn ? <span className="mini-badge is-accent">行动中</span> : null}
      </div>

      <div className="seat-stats">
        <span>筹码 {stack}</span>
        <span>本轮已下 {contribution}</span>
        {isSelf ? <span>你的底牌只在你这里可见</span> : <span>对手手牌在结算前保持背面</span>}
      </div>
    </div>
  );
}

function ResultPanel({ gameState, selfSeat }) {
  if (!gameState.resolution) {
    return null;
  }

  const { resolution, showdownResults } = gameState;

  return (
    <section className="result-panel">
      <div className="result-headline">
        <p className="eyebrow">本手结果</p>
        <h3>{resolution.message}</h3>
      </div>

      {showdownResults?.length ? (
        <div className="result-grid">
          {showdownResults.map((result) => (
            <article key={result.seat} className={`result-entry ${result.isWinner ? "is-winner" : ""}`}>
              <div className="result-header">
                <span>{result.seat === selfSeat ? "你" : result.name}</span>
                <strong>{result.handName}</strong>
              </div>

              <div className="result-row">
                {result.holeCards.map((cardCode) => (
                  <Card key={`${result.seat}-${cardCode}`} cardCode={cardCode} compact />
                ))}
              </div>

              <div className="result-row">
                {result.bestCards.map((cardCode) => (
                  <Card key={`${result.seat}-${cardCode}-best`} cardCode={cardCode} compact highlight />
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RaiseEditor({
  isOpen,
  value,
  min,
  max,
  onChange,
  onClose,
  onConfirm,
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <p className="eyebrow">自定义加注</p>
        <h3>输入这一街要加到多少</h3>
        <p className="modal-copy">
          输入的是“你这一街总共压到多少”，范围 {min} 到 {max}。
        </p>

        <input
          className="text-field"
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />

        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={onConfirm}>
            确认加注
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const hasRestoredRoomRef = useRef(false);
  const raisePressTimerRef = useRef(null);
  const raiseLongPressTriggeredRef = useRef(false);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomState, setRoomState] = useState(null);
  const [gameState, setGameState] = useState(DEFAULT_GAME_STATE);
  const [connectionState, setConnectionState] = useState(socket.connected ? "connected" : "connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [isRaiseEditorOpen, setIsRaiseEditorOpen] = useState(false);
  const [raiseInput, setRaiseInput] = useState("");

  useEffect(() => {
    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, playerName.trim());
  }, [playerName]);

  useEffect(() => {
    function handleConnect() {
      setConnectionState("connected");
      const savedRoomCode = localStorage.getItem(ROOM_CODE_STORAGE_KEY);
      const savedName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "";

      if (savedRoomCode && !hasRestoredRoomRef.current) {
        hasRestoredRoomRef.current = true;
        socket.emit("room:join", {
          roomCode: savedRoomCode,
          name: savedName,
        });
      }
    }

    function handleDisconnect() {
      setConnectionState("disconnected");
      hasRestoredRoomRef.current = false;
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

        if (!nextGameState.actions.canRaise) {
          setIsRaiseEditorOpen(false);
        }
      });
    }

    function handleShowdown(nextGameState) {
      startTransition(() => {
        setGameState(nextGameState);
        setIsRaiseEditorOpen(false);
      });
    }

    function handleError(payload) {
      setErrorMessage(payload.message);

      if (payload.message.includes("房间不存在")) {
        localStorage.removeItem(ROOM_CODE_STORAGE_KEY);
        setRoomState(null);
        hasRestoredRoomRef.current = false;
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
      setRaiseInput(String(gameState.minRaiseTo));
    }
  }, [gameState.actions.canRaise, gameState.minRaiseTo]);

  const selfPlayer = roomState?.players.find((player) => player.isSelf) ?? null;
  const opponent = roomState?.players.find((player) => !player.isSelf) ?? null;
  const tableStatus = getStatusText(roomState, gameState);
  const connectionLabel =
    connectionState === "connected"
      ? "已连接"
      : connectionState === "connecting"
        ? "连接中"
        : "连接断开";
  const revealButtonLabel = getRevealButtonLabel(gameState.phase);
  const primaryControlLabel = gameState.matchStatus === "gameOver" ? "重新开赛" : "新一局";
  const blindBadgeSelf = selfPlayer ? getBlindBadge(selfPlayer.seat, gameState) : "";
  const blindBadgeOpponent = opponent ? getBlindBadge(opponent.seat, gameState) : "";

  function clearRaisePressTimer() {
    if (raisePressTimerRef.current) {
      clearTimeout(raisePressTimerRef.current);
      raisePressTimerRef.current = null;
    }
  }

  function openRaiseEditor() {
    setRaiseInput(String(gameState.minRaiseTo));
    setIsRaiseEditorOpen(true);
  }

  function closeRaiseEditor() {
    setIsRaiseEditorOpen(false);
  }

  function emitDefaultRaise() {
    const defaultTarget = Math.min(gameState.maxRaiseTo, Math.max(gameState.minRaiseTo, gameState.currentBet + 1));
    socket.emit("game:raise", { targetBet: defaultTarget });
  }

  function handleRaisePressStart() {
    if (!gameState.actions.canRaise) {
      return;
    }

    raiseLongPressTriggeredRef.current = false;
    clearRaisePressTimer();
    raisePressTimerRef.current = setTimeout(() => {
      raiseLongPressTriggeredRef.current = true;
      openRaiseEditor();
    }, 450);
  }

  function handleRaisePressEnd() {
    if (!gameState.actions.canRaise) {
      return;
    }

    const wasLongPress = raiseLongPressTriggeredRef.current;
    clearRaisePressTimer();

    if (!wasLongPress) {
      emitDefaultRaise();
    }
  }

  function handleRaisePressCancel() {
    clearRaisePressTimer();
  }

  function handleCreateRoom() {
    localStorage.removeItem(ROOM_CODE_STORAGE_KEY);
    hasRestoredRoomRef.current = true;
    socket.emit("room:create", { name: playerName });
  }

  function handleJoinRoom() {
    hasRestoredRoomRef.current = true;
    socket.emit("room:join", {
      roomCode: roomCodeInput,
      name: playerName,
    });
  }

  function handlePrimaryControl() {
    if (gameState.matchStatus === "gameOver") {
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

  function handleConfirmRaise() {
    const parsed = Number(raiseInput);

    if (!Number.isInteger(parsed)) {
      setErrorMessage("请输入整数加注目标。");
      return;
    }

    if (parsed < gameState.minRaiseTo || parsed > gameState.maxRaiseTo) {
      setErrorMessage(`加注目标必须在 ${gameState.minRaiseTo} 到 ${gameState.maxRaiseTo} 之间。`);
      return;
    }

    socket.emit("game:raise", { targetBet: parsed });
    setIsRaiseEditorOpen(false);
  }

  return (
    <div className="app-shell">
      <div className="background-noise" />

      <RaiseEditor
        isOpen={isRaiseEditorOpen}
        value={raiseInput}
        min={gameState.minRaiseTo}
        max={gameState.maxRaiseTo}
        onChange={setRaiseInput}
        onClose={closeRaiseEditor}
        onConfirm={handleConfirmRaise}
      />

      <aside className="info-rail">
        <div className="rail-panel brand-panel">
          <p className="eyebrow">LAN Hold'em</p>
          <h1>双人德州扑克</h1>
          <p className="brand-copy">
            现在已经支持筹码、盲注和下注回合。只有当这一街双方投入相等时，房主才能继续开牌。
          </p>
        </div>

        <div className="rail-panel">
          <div className="panel-head">
            <span>连接状态</span>
            <strong className={`connection-state is-${connectionState}`}>{connectionLabel}</strong>
          </div>
          <p className="muted-text">服务端地址：{SERVER_URL}</p>
        </div>

        <div className="rail-panel">
          <div className="panel-head">
            <span>当前房间</span>
            <strong>{roomState?.roomCode ? `房间 ${roomState.roomCode}` : "尚未入房"}</strong>
          </div>
          <p className="status-copy">{tableStatus}</p>
        </div>

        <div className="rail-panel">
          <div className="stats-grid">
            <div className="stat-box">
              <span>当前底池</span>
              <strong>{gameState.pot}</strong>
            </div>
            <div className="stat-box">
              <span>延续底池</span>
              <strong>{gameState.carryoverPot}</strong>
            </div>
            <div className="stat-box">
              <span>当前阶段</span>
              <strong>{getPhaseLabel(gameState.phase)}</strong>
            </div>
            <div className="stat-box">
              <span>本轮目标</span>
              <strong>{gameState.currentBet}</strong>
            </div>
          </div>
        </div>

        <div className="rail-panel control-panel">
          <label className="field-label" htmlFor="player-name">
            玩家名称
          </label>
          <input
            id="player-name"
            className="text-field"
            maxLength={12}
            placeholder="默认使用 玩家 1 / 玩家 2"
            value={playerName}
            onChange={(event) => setPlayerName(event.target.value)}
          />

          {!roomState ? (
            <>
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
            </>
          ) : (
            <>
              <button
                className="primary-button"
                type="button"
                disabled={gameState.matchStatus === "gameOver" ? !gameState.actions.canResetMatch : !gameState.actions.canStartHand}
                onClick={handlePrimaryControl}
              >
                {primaryControlLabel}
              </button>

              <button
                className="secondary-button"
                type="button"
                disabled={!gameState.actions.canRevealNext}
                onClick={handleRevealNext}
              >
                {revealButtonLabel}
              </button>
            </>
          )}

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </div>

        {roomState ? (
          <div className="rail-panel action-panel">
            <div className="panel-head">
              <span>你的行动</span>
              <strong>{gameState.currentTurnSeat === roomState.self?.seat ? "轮到你" : "等待中"}</strong>
            </div>

            <div className="action-notes">
              <span>你还需补 {gameState.selfCallAmount}</span>
              <span>可加到 {gameState.maxRaiseTo}</span>
            </div>

            <div className="action-grid">
              <button
                className="secondary-button action-button"
                type="button"
                disabled={!gameState.actions.canCall}
                onClick={handleCall}
              >
                {gameState.selfCallAmount > 0 ? `跟随 · ${gameState.selfCallAmount}` : "过牌 / 跟随"}
              </button>

              <button
                className="secondary-button action-button"
                type="button"
                disabled={!gameState.actions.canRaise}
                onPointerDown={handleRaisePressStart}
                onPointerUp={handleRaisePressEnd}
                onPointerLeave={handleRaisePressCancel}
                onPointerCancel={handleRaisePressCancel}
              >
                加注 · 默认 +1
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

            <p className="muted-text">
              短按“加注”默认在当前目标上加 1，长按约半秒会弹出自定义输入。
            </p>
          </div>
        ) : null}
      </aside>

      <main className="table-stage">
        {!roomState ? (
          <section className="hero-table">
            <div className="hero-copy">
              <p className="eyebrow">局域网双人对局</p>
              <h2>双人德州现在支持盲注、筹码、下注回合与延续底池。</h2>
              <p>
                每位玩家初始 50 筹码。每一街都要把下注补齐，房主才能继续开牌。平局时底池会留到下一手，直到有人真正赢下它。
              </p>
            </div>

            <div className="hero-cards">
              {["AS", "KH", "QD", "JC", "TS"].map((cardCode) => (
                <Card key={cardCode} cardCode={cardCode} highlight />
              ))}
            </div>
          </section>
        ) : (
          <section className="poker-table">
            <div className="seat-zone opponent-zone">
              <SeatSummary
                label="对手席位"
                player={opponent}
                stack={gameState.opponentStack}
                contribution={gameState.opponentStreetContribution}
                isActiveTurn={gameState.currentTurnSeat === opponent?.seat}
                blindBadge={blindBadgeOpponent}
              />

              <div className="card-row">
                {opponent ? (
                  gameState.phase === "showdown" && gameState.revealedOpponentHoleCards.length ? (
                    gameState.revealedOpponentHoleCards.map((cardCode, index) => (
                      <Card key={`opponent-${cardCode}-${index}`} cardCode={cardCode} />
                    ))
                  ) : (
                    Array.from({ length: Math.max(gameState.opponentCardCount, 2) }, (_, index) => (
                      <Card key={`opponent-hidden-${index}`} hidden />
                    ))
                  )
                ) : (
                  Array.from({ length: 2 }, (_, index) => <Card key={`empty-opponent-${index}`} hidden />)
                )}
              </div>
            </div>

            <div className="board-zone">
              <div className="board-header">
                <div>
                  <p className="eyebrow">桌面中央</p>
                  <h3>第 {Math.max(gameState.handNumber, 1)} 手</h3>
                </div>

                <div className="board-metrics">
                  <span className="phase-badge">{getPhaseLabel(gameState.phase)}</span>
                  <span className="metric-pill">底池 {gameState.pot}</span>
                  <span className="metric-pill">延续 {gameState.carryoverPot}</span>
                </div>
              </div>

              <div className="card-row board-row">
                {gameState.board.map((cardCode) => (
                  <Card key={`board-${cardCode}`} cardCode={cardCode} highlight />
                ))}
                {Array.from({ length: Math.max(5 - gameState.board.length, 0) }, (_, index) => (
                  <Card key={`board-placeholder-${index}`} hidden />
                ))}
              </div>

              <ResultPanel gameState={gameState} selfSeat={roomState.self?.seat} />
            </div>

            <div className="seat-zone self-zone">
              <SeatSummary
                label="你的席位"
                player={selfPlayer}
                stack={gameState.selfStack}
                contribution={gameState.selfStreetContribution}
                isSelf
                isActiveTurn={gameState.currentTurnSeat === selfPlayer?.seat}
                blindBadge={blindBadgeSelf}
              />

              <div className="card-row">
                {gameState.selfHoleCards.length ? (
                  gameState.selfHoleCards.map((cardCode, index) => (
                    <Card key={`self-${cardCode}-${index}`} cardCode={cardCode} />
                  ))
                ) : (
                  Array.from({ length: 2 }, (_, index) => <Card key={`self-empty-${index}`} hidden />)
                )}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
