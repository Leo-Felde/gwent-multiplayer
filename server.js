const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

let sessions = {};
let players = [];
let disconnectedPlayers = {}; // { [playerId]: { code, timeoutId } }

// Helper function to generate a random character sequence
function generateCode(length = 4) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

// How long to wait for reconnection before deleting session (ms).
// Match client's reconnect attempts: 5 attempts * 3000ms = 15000ms; give a small buffer.
const RECONNECT_WAIT_MS = 20000;

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    if (data.type === "connect") {
      ws.playerId = data?.id ?? generateCode(6);

      // If data.id is provided, check for existing player and replace it
      if (data?.id) {
        const existingIdx = players.findIndex((p) => p.playerId === data.id);
        if (existingIdx !== -1) {
          players[existingIdx] = ws;
        } else {
          players.push(ws);
        }
      } else {
        players.push(ws);
      }

      console.log(`# Player ${ws.playerId} connected`);
      ws.send(JSON.stringify({ type: "welcome", playerId: ws.playerId }));

      // If this player was previously disconnected, restore session
      const d = disconnectedPlayers[ws.playerId];
      if (d) {
        clearTimeout(d.timeoutId);
        delete disconnectedPlayers[ws.playerId];

        const session = sessions[d.code];
        if (session) {
          // replace the old socket placeholder (if present) with this ws
          const idx = session.players.findIndex(
            (p) => p.playerId === ws.playerId,
          );
          if (idx !== -1) {
            session.players[idx] = ws;
          } else {
            // if old socket reference gone, push if there's space
            if (session.players.length < 2) session.players.push(ws);
          }
          ws.sessionCode = d.code;
          console.log(
            `# Player ${ws.playerId} reconnected to Session ${d.code}`,
          );
        }
      }

      return;
    }

    if (data.type === "createSession") {
      const sessionCode = generateCode();
      sessions[sessionCode] = {
        players: [ws],
        code: sessionCode,
        playersReady: 0,
      };
      ws.sessionCode = sessionCode;
      ws.send(JSON.stringify({ type: "sessionCreated", code: sessionCode }));
      console.log(`# Player ${ws.playerId} created Session ${sessionCode}`);

      ws.send(JSON.stringify({ type: "sessionJoined", code: sessionCode }));
      return;
    }

    if (data.type === "cancelSession") {
      const sessionCode = data.code;
      if (!sessions[sessionCode]) return;

      console.log(`# Player ${ws.playerId} cancelled Session ${sessionCode}`);
      // clear any pending reconnect timers for that session
      Object.keys(disconnectedPlayers).forEach((pid) => {
        if (disconnectedPlayers[pid].code === sessionCode) {
          clearTimeout(disconnectedPlayers[pid].timeoutId);
          delete disconnectedPlayers[pid];
        }
      });

      delete sessions[sessionCode];
      return;
    }

    if (data.type === "leaveSession") {
      const sessionCode = data.code;
      if (!sessions[sessionCode]) return;

      console.log(`# Player ${ws.playerId} left Session ${sessionCode}`);
      sessions[sessionCode].players = sessions[sessionCode].players.filter(
        (player) => player !== ws,
      );
      return;
    }

    if (data.type === "joinSession") {
      const sessionCode = data.code;
      if (sessions[sessionCode] && sessions[sessionCode].players.length === 1) {
        sessions[sessionCode].players.push(ws);
        ws.sessionCode = sessionCode;
        ws.send(JSON.stringify({ type: "sessionJoined", code: sessionCode }));
        console.log(`# Player ${ws.playerId} joined Session ${sessionCode}`);

        sessions[sessionCode].players.forEach((player, index) => {
          player.send(
            JSON.stringify({ type: "sessionReady", player: index + 1 }),
          );
        });
      } else {
        ws.send(JSON.stringify({ type: "sessionInvalid" }));
        console.log(
          `# Player ${ws.playerId} attempted to join invalid Session ${sessionCode}`,
        );
      }
      return;
    }

    if (data.type === "gameStart") {
      if (ws.sessionCode && sessions[ws.sessionCode]) {
        const session = sessions[ws.sessionCode];
        if (!sessions[ws.sessionCode]?.firstPlayer) {
          const firstPlayer =
            session.players[Math.floor(Math.random() * session.players.length)]
              .playerId;
          sessions[ws.sessionCode].firstPlayer = firstPlayer;
        }
        console.log("firstPlayer = ", sessions[ws.sessionCode].firstPlayer);

        session.players.forEach((player) => {
          player.send(
            JSON.stringify({
              type: "coinToss",
              player: sessions[ws.sessionCode].firstPlayer,
            }),
          );
        });
      }
      return;
    }

    if (data.type === "finished_redraw") {
      if (ws.sessionCode && sessions[ws.sessionCode]) {
        const session = sessions[ws.sessionCode];
        session.playersReady += 1;

        console.log(
          `# Players ready in session ${ws.sessionCode}: ${session.playersReady}`,
        );

        if (session.playersReady === 2) {
          session.players.forEach((player) => {
            player.send(JSON.stringify({ type: "start" }));
          });
          session.playersReady = 0;
        }
      }
      return;
    }

    // Relay messages to the other player in the same session
    if (ws.sessionCode) {
      const sessionPlayers = sessions[ws.sessionCode]?.players || [];
      sessionPlayers.forEach((player) => {
        if (player !== ws && player.readyState === WebSocket.OPEN) {
          player.send(JSON.stringify(data));
        }
      });
    }
  });

  ws.on("close", () => {
    if (!ws.playerId) return;
    console.log(`# Player ${ws.playerId} disconnected`);

    if (ws.sessionCode && sessions[ws.sessionCode]) {
      const session = sessions[ws.sessionCode];
      // mark disconnected and wait for reconnection
      const timeoutId = setTimeout(() => {
        // if still disconnected after wait, delete session (notify remaining)
        if (disconnectedPlayers[ws.playerId] && sessions[ws.sessionCode]) {
          const sess = sessions[ws.sessionCode];
          const other = sess.players.find((p) => p.playerId !== ws.playerId);
          if (other && other.readyState === WebSocket.OPEN) {
            other.send(JSON.stringify({ type: "sessionDeleted" }));
          }
          console.log(
            `# Session ${ws.sessionCode} deleted due to no reconnection`,
          );
          // cleanup any disconnected entries for this session
          Object.keys(disconnectedPlayers).forEach((pid) => {
            if (disconnectedPlayers[pid].code === ws.sessionCode) {
              clearTimeout(disconnectedPlayers[pid].timeoutId);
              delete disconnectedPlayers[pid];
            }
          });
          delete sessions[ws.sessionCode];
        }
      }, RECONNECT_WAIT_MS);

      disconnectedPlayers[ws.playerId] = { code: ws.sessionCode, timeoutId };

      // Notify the other player
      const otherPlayer = session.players.find((p) => p !== ws);
      if (otherPlayer && otherPlayer.readyState === WebSocket.OPEN) {
        otherPlayer.send(
          JSON.stringify({
            type: "opponentDisconnected",
            playerId: ws.playerId,
          }),
        );
        otherPlayer.send(JSON.stringify({ type: "sessionUnready" }));
      }

      console.log(
        `# Player ${ws.playerId} disconnected from Session ${ws.sessionCode}. Waiting for reconnection...`,
      );
    }

    players = players.filter((player) => player !== ws);
  });
});

console.log(`## Server is up and running ##`);
