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

function getStatusText(roomState, gameState) {
  if (!roomState) {
    return "创建房间或输入房间码，和另一位玩家在同一局域网开局。";
  }

  if (roomState.players.length < 2) {
    return "等待第二位玩家加入，房主加入后即可随时重新发牌开始。";
  }

  switch (gameState?.phase) {
    case "waiting":
      return "两位玩家已就位，房主可随时开始新一局。";
    case "preflop":
      return "双方已拿到两张手牌，点击“开牌”翻出前三张公共牌。";
    case "flop":
      return "翻牌圈已完成，下一次开牌将翻出转牌。";
    case "turn":
      return "转牌已亮出，下一次开牌将翻出河牌。";
    case "river":
      return "五张公共牌即将完整，下一次开牌会直接比较双方牌型。";
    case "showdown":
      return gameState.winner?.seat === null
        ? "本局平手，房主可随时直接开启下一局。"
        : `本局胜者是${gameState.winner.seat === roomState.self?.seat ? "你" : "对手"}，房主可随时直接开启下一局。`;
    default:
      return "房主可随时开始一局新牌。";
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

function SeatLabel({ player, isSelf = false }) {
  if (!player) {
    return (
      <div className="seat-meta">
        <span className="seat-role">空位</span>
        <strong>等待玩家加入</strong>
      </div>
    );
  }

  return (
    <div className="seat-meta">
      <span className="seat-role">
        {isSelf ? "你的座位" : "对手座位"}
        {player.isHost ? " · 房主" : ""}
      </span>
      <strong>{player.name}</strong>
    </div>
  );
}

function ResultPanel({ showdownResults, selfSeat }) {
  if (!showdownResults?.length) {
    return null;
  }

  const winner = showdownResults.find((result) => result.isWinner);

  return (
    <section className="result-panel">
      <div>
        <p className="eyebrow">本局结果</p>
        <h3>{winner ? `${winner.seat === selfSeat ? "你" : winner.name}获胜` : "双方平手"}</h3>
      </div>

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
                <Card
                  key={`${result.seat}-${cardCode}-best`}
                  cardCode={cardCode}
                  compact
                  highlight
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const hasRestoredRoomRef = useRef(false);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomState, setRoomState] = useState(null);
  const [gameState, setGameState] = useState({
    phase: "waiting",
    board: [],
    selfHoleCards: [],
    opponentCardCount: 0,
    revealedOpponentHoleCards: [],
    showdownResults: null,
    actions: {
      canStartHand: false,
      canRevealNext: false,
    },
  });
  const [connectionState, setConnectionState] = useState(socket.connected ? "connected" : "connecting");
  const [errorMessage, setErrorMessage] = useState("");

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
      });
    }

    function handleShowdown(nextGameState) {
      startTransition(() => {
        setGameState(nextGameState);
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

  function handleStartHand() {
    socket.emit("game:startHand");
  }

  function handleRevealNext() {
    socket.emit("game:revealNext");
  }

  return (
    <div className="app-shell">
      <div className="background-noise" />

      <aside className="info-rail">
        <div className="rail-panel brand-panel">
          <p className="eyebrow">LAN Hold'em</p>
          <h1>双人德州扑克</h1>
          <p className="brand-copy">
            一台设备创建房间，另一台设备输入房间码加入。房主控制新一局和开牌节奏。
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
            <span>当前状态</span>
            <strong>{roomState?.roomCode ? `房间 ${roomState.roomCode}` : "尚未入房"}</strong>
          </div>
          <p className="status-copy">{tableStatus}</p>
        </div>

        <div className="rail-panel control-panel">
          <label className="field-label" htmlFor="player-name">
            玩家名称
          </label>
          <input
            id="player-name"
            className="text-field"
            maxLength={12}
            placeholder="默认会自动使用 玩家 1 / 玩家 2"
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
                disabled={!gameState.actions.canStartHand}
                onClick={handleStartHand}
              >
                新一局
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
      </aside>

      <main className="table-stage">
        {!roomState ? (
          <section className="hero-table">
            <div className="hero-copy">
              <p className="eyebrow">局域网双人试玩</p>
              <h2>发两张底牌，三次开牌，第四次直接比出最大牌型。</h2>
              <p>
                这个版本专注在最核心的牌局流程。没有筹码、下注和弃牌，只有同步、手牌、公共牌和最后的胜负展示。
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
              <SeatLabel player={opponent} />
              <div className="card-row">
                {opponent ? (
                  gameState.phase === "showdown" ? (
                    (gameState.revealedOpponentHoleCards.length
                      ? gameState.revealedOpponentHoleCards
                      : [null, null]
                    ).map((cardCode, index) => (
                      <Card key={`opponent-${cardCode ?? index}`} cardCode={cardCode} />
                    ))
                  ) : (
                    Array.from({ length: Math.max(gameState.opponentCardCount, 2) }, (_, index) => (
                      <Card key={`hidden-${index}`} hidden />
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
                  <p className="eyebrow">公共牌</p>
                  <h3>第 {Math.max(gameState.handNumber, 1)} 局</h3>
                </div>
                <span className={`phase-badge is-${gameState.phase}`}>{gameState.phase}</span>
              </div>

              <div className="card-row board-row">
                {gameState.board.map((cardCode) => (
                  <Card key={`board-${cardCode}`} cardCode={cardCode} highlight />
                ))}
                {Array.from({ length: Math.max(5 - gameState.board.length, 0) }, (_, index) => (
                  <Card key={`board-placeholder-${index}`} hidden />
                ))}
              </div>

              <ResultPanel showdownResults={gameState.showdownResults} selfSeat={roomState.self?.seat} />
            </div>

            <div className="seat-zone self-zone">
              <SeatLabel player={selfPlayer} isSelf />
              <div className="card-row">
                {gameState.selfHoleCards.length ? (
                  gameState.selfHoleCards.map((cardCode) => <Card key={`self-${cardCode}`} cardCode={cardCode} />)
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
