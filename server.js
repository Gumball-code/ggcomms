// server.js
// Minimal Poker server: Lobby + single table owner + Texas Hold'em engine
// NOT production-ready. In-memory only. No side-pot handling for all-ins.
// Usage: npm install && npm start

const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const app = express();
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// CONFIG
const MAX_SEATS = 6;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const STARTING_STACK_MIN = 100;
const STARTING_STACK_MAX = 1000000;

// Utilities: deck, shuffle, hand evaluator
const SUITS = ['s','h','d','c'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

function makeDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  return d;
}
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Convert card like 'As' -> rank index and suit
function rankValue(card) {
  return RANKS.indexOf(card[0]);
}
function suitOf(card) {
  return card[1];
}

// Hand evaluator: returns {rank: number, tiebreaker: array} higher rank better.
// Ranks: 8 StraightFlush,7 Four,6 FullHouse,5 Flush,4 Straight,3 Trips,2 TwoPair,1 Pair,0 HighCard
// This is not hyper-optimized but enough for demo.
function evaluateBest7(cards) {
  // cards: array of strings, length 7 (or less)
  // returns {score: [rank, ...tiebreakers], desc}
  const n = cards.length;
  if (n < 5) return { score: [0], desc: 'unknown' };

  // Build counts
  const ranksCount = Array(13).fill(0);
  const suits = { s: [], h: [], d: [], c: [] };
  const ranksList = [];

  for (const c of cards) {
    const r = rankValue(c);
    ranksCount[r]++;
    suits[suitOf(c)].push(r);
  }
  for (let i = 12; i >= 0; i--) {
    for (let k = 0; k < ranksCount[i]; k++) ranksList.push(i);
  }

  // Helper to get unique ranks descending
  const uniqueRanksDesc = [];
  for (let i = 12; i >= 0; i--) if (ranksCount[i]) uniqueRanksDesc.push(i);

  // Check flush
  let flushSuit = null;
  for (const s of SUITS) {
    if (suits[s].length >= 5) {
      flushSuit = s;
      break;
    }
  }
  let flushRanks = [];
  if (flushSuit) {
    flushRanks = suits[flushSuit].slice().sort((a,b)=>b-a);
  }

  // Check straight (on unique ranks)
  function findStraightFromRanks(ar) {
    // ar: array of ranks present (unique), descending
    // handles wheel A-2-3-4-5 (A as 12)
    const present = Array(13).fill(false);
    for (const r of ar) present[r] = true;
    // treat Ace low possibility
    const seqs = [];
    for (let i = 12; i >= 4; i--) {
      let ok = true;
      for (let k = 0; k < 5; k++) if (!present[i - k]) { ok = false; break; }
      if (ok) return i; // high card of straight
    }
    // wheel
    if (present[12] && present[0] && present[1] && present[2] && present[3]) return 3; // 5-high straight, high card index 3 (5)
    return null;
  }

  const straightHigh = findStraightFromRanks(uniqueRanksDesc);

  // Straight flush
  if (flushSuit) {
    const flushUnique = Array.from(new Set(flushRanks)).sort((a,b)=>b-a);
    const sfHigh = findStraightFromRanks(flushUnique);
    if (sfHigh !== null) {
      return { score: [8, sfHigh], desc: 'Straight Flush' };
    }
  }

  // Four of a kind
  for (let r = 12; r >= 0; r--) {
    if (ranksCount[r] === 4) {
      // kicker highest remaining
      let kicker = null;
      for (let k = 12; k >= 0; k--) if (k !== r && ranksCount[k] > 0) { kicker = k; break; }
      return { score: [7, r, kicker], desc: 'Four of a Kind' };
    }
  }

  // Full house (three + pair)
  let three = null;
  for (let r = 12; r >= 0; r--) if (ranksCount[r] >= 3) { three = r; break; }
  if (three !== null) {
    let pair = null;
    // look for pair among others, prefer highest
    for (let r = 12; r >= 0; r--) {
      if (r === three) continue;
      if (ranksCount[r] >= 2) { pair = r; break; }
    }
    if (pair !== null) return { score: [6, three, pair], desc: 'Full House' };
    // could be two triples: use next triple as pair
    for (let r = 12; r >= 0; r--) {
      if (r !== three && ranksCount[r] >= 3) { pair = r; break; }
    }
    if (pair !== null) return { score: [6, three, pair], desc: 'Full House' };
  }

  // Flush
  if (flushSuit) {
    const top5 = flushRanks.slice(0,5);
    return { score: [5].concat(top5), desc: 'Flush' };
  }

  // Straight
  if (straightHigh !== null) return { score: [4, straightHigh], desc: 'Straight' };

  // Trips
  if (three !== null) {
    // kickers: two highest others
    const kickers = [];
    for (let r = 12; r >= 0 && kickers.length < 2; r--) if (r !== three && ranksCount[r] > 0) kickers.push(r);
    return { score: [3, three].concat(kickers), desc: 'Three of a kind' };
  }

  // Two pair
  let pair1 = null, pair2 = null;
  for (let r = 12; r >= 0; r--) {
    if (ranksCount[r] >= 2) {
      if (!pair1) pair1 = r;
      else if (!pair2) { pair2 = r; break; }
    }
  }
  if (pair1 !== null && pair2 !== null) {
    let kicker = null;
    for (let r = 12; r >= 0; r--) if (r !== pair1 && r !== pair2 && ranksCount[r] > 0) { kicker = r; break; }
    return { score: [2, pair1, pair2, kicker], desc: 'Two Pair' };
  }

  // One pair
  if (pair1 !== null) {
    const kickers = [];
    for (let r = 12; r >= 0 && kickers.length < 3; r--) if (r !== pair1 && ranksCount[r] > 0) kickers.push(r);
    return { score: [1, pair1].concat(kickers), desc: 'Pair' };
  }

  // High card
  const top5 = [];
  for (let r = 12; r >= 0 && top5.length < 5; r--) if (ranksCount[r] > 0) top5.push(r);
  return { score: [0].concat(top5), desc: 'High Card' };
}

// Compare two score arrays lexicographically
function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

// Poker table state
const state = {
  lobby: {
    // list of connected usernames for lobby listing
  },
  table: {
    owner: null, // socket.id of owner
    seats: Array(MAX_SEATS).fill(null), // each seat: { socketId, username, chips }
    waiting: [], // spectators socket ids
    dealerIndex: 0, // seat index (0-based) for dealer button
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    phase: 'idle', // idle | dealing | betting | showdown
    deck: [],
    community: [],
    pot: 0,
    currentBets: Array(MAX_SEATS).fill(0), // current committed bet this hand
    currentPlayerIndex: null, // active seat index for action
    minimumRaise: BIG_BLIND,
    lastAggressorIndex: null, // who last raised
    folded: Array(MAX_SEATS).fill(false),
    holeCards: {}, // seatIdx -> [card,card]
    seatsInHand: [], // indices of seats still participating in active hand
  }
};

// Helpers for broadcasting table state (but hide hole cards for others)
function publicTableStateForSocket(socketId) {
  const t = state.table;
  const seats = t.seats.map((s, idx) => {
    if (!s) return null;
    const base = { username: s.username, chips: s.chips, seat: idx };
    // reveal hole cards only to owner of that seat
    if (t.holeCards[idx]) {
      if (s.socketId === socketId) base.hole = t.holeCards[idx];
      else base.hole = t.holeCards[idx].map(() => '??'); // hidden to others
    }
    base.folded = t.folded[idx] || false;
    base.currentBet = t.currentBets[idx] || 0;
    return base;
  });
  return {
    owner: t.owner,
    seats,
    dealerIndex: t.dealerIndex,
    community: t.community,
    pot: t.pot,
    phase: t.phase,
    currentPlayerIndex: t.currentPlayerIndex,
    minimumRaise: t.minimumRaise,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind
  };
}

function broadcastTable() {
  io.sockets.sockets.forEach((sock) => {
    if (!sock) return;
    sock.emit('table state', publicTableStateForSocket(sock.id));
  });
}

// Seating / lobby logic
io.on('connection', (socket) => {
  console.log('connect', socket.id);
  socket.data.username = null;

  // send initial lobby and table
  socket.emit('lobby', { message: 'welcome' });
  socket.emit('table state', publicTableStateForSocket(socket.id));

  // Simple username set
  socket.on('set username', (username, cb) => {
    if (!username || typeof username !== 'string') return cb && cb({ ok: false, error: 'invalid' });
    username = username.trim().slice(0, 32);
    socket.data.username = username;
    cb && cb({ ok: true, username });
    broadcastTable();
  });

  socket.on('become owner', (cb) => {
    // only one owner allowed
    state.table.owner = socket.id;
    // if owner seat not set, owner can sit later
    cb && cb({ ok: true });
    broadcastTable();
  });

  socket.on('sit', ({ seat, buyIn }, cb) => {
    if (typeof seat !== 'number' || seat < 0 || seat >= MAX_SEATS) return cb && cb({ ok:false, error:'invalid seat' });
    if (!socket.data.username) return cb && cb({ ok:false, error:'no username' });
    if (state.table.seats[seat]) return cb && cb({ ok:false, error:'seat taken' });
    buyIn = Math.max(STARTING_STACK_MIN, Number(buyIn) || STARTING_STACK_MIN);
    if (buyIn < STARTING_STACK_MIN) buyIn = STARTING_STACK_MIN;
    state.table.seats[seat] = { socketId: socket.id, username: socket.data.username, chips: buyIn };
    socket.join('table');
    cb && cb({ ok:true });
    broadcastTable();
  });

  socket.on('stand', (cb) => {
    // remove from seat
    for (let i=0;i<MAX_SEATS;i++) {
      const s = state.table.seats[i];
      if (s && s.socketId === socket.id) {
        state.table.seats[i] = null;
        break;
      }
    }
    socket.leave('table');
    cb && cb({ ok:true });
    broadcastTable();
  });

  socket.on('kick', (seat, cb) => {
    // only owner can kick by seat
    if (socket.id !== state.table.owner) return cb && cb({ ok:false, error:'not owner' });
    if (state.table.seats[seat]) {
      const kickedSocketId = state.table.seats[seat].socketId;
      state.table.seats[seat] = null;
      const kicked = io.sockets.sockets.get(kickedSocketId);
      if (kicked) kicked.leave('table');
    }
    cb && cb({ ok:true });
    broadcastTable();
  });

  // Owner starts a hand
  socket.on('start hand', (cb) => {
    if (socket.id !== state.table.owner) return cb && cb({ ok:false, error:'not owner' });
    const t = state.table;
    // find seated players >=2
    const seatedIdx = [];
    for (let i=0;i<MAX_SEATS;i++) if (t.seats[i]) seatedIdx.push(i);
    if (seatedIdx.length < 2) return cb && cb({ ok:false, error:'not enough players' });

    // Reset hand state
    t.deck = shuffle(makeDeck());
    t.community = [];
    t.pot = 0;
    t.currentBets = Array(MAX_SEATS).fill(0);
    t.folded = Array(MAX_SEATS).fill(false);
    t.holeCards = {};
    t.seatsInHand = seatedIdx.slice();
    t.phase = 'preflop';
    t.minimumRaise = t.bigBlind;
    t.lastAggressorIndex = null;

    // Move dealer to next occupied seat (simple rotation)
    let di = t.dealerIndex;
    // advance at least 1
    for (let step=1;step<=MAX_SEATS;step++) {
      const idx = (di + step) % MAX_SEATS;
      if (t.seats[idx]) { t.dealerIndex = idx; break; }
    }
    // Post blinds (small & big)
    // find next occupied seats for SB and BB
    function nextOccupied(start) {
      for (let step=1; step<=MAX_SEATS; step++) {
        const idx = (start + step) % MAX_SEATS;
        if (t.seats[idx]) return idx;
      }
      return null;
    }
    const sbIdx = nextOccupied(t.dealerIndex);
    const bbIdx = nextOccupied(sbIdx);
    // Deduct blinds from stacks, move to pot & currentBets
    if (sbIdx === null || bbIdx === null) return cb && cb({ ok:false, error:'not enough players for blinds' });
    const sb = t.seats[sbIdx];
    const bb = t.seats[bbIdx];
    const sbAmt = Math.min(t.smallBlind, sb.chips);
    sb.chips -= sbAmt; t.currentBets[sbIdx] = sbAmt; t.pot += sbAmt;
    const bbAmt = Math.min(t.bigBlind, bb.chips);
    bb.chips -= bbAmt; t.currentBets[bbIdx] = bbAmt; t.pot += bbAmt;

    // Deal two hole cards to each seat in order starting after dealer
    let dealOrder = [];
    for (let step=1; step<=MAX_SEATS; step++) {
      const idx = (t.dealerIndex + step) % MAX_SEATS;
      if (t.seats[idx]) dealOrder.push(idx);
    }
    for (const idx of dealOrder) {
      const c1 = t.deck.pop(); const c2 = t.deck.pop();
      t.holeCards[idx] = [c1,c2];
    }

    // Set current player to first to act: seat after BB
    t.currentPlayerIndex = nextOccupied(bbIdx);
    t.phase = 'betting';
    broadcastTable();
    cb && cb({ ok:true });
  });

  // Player actions: fold, check/call, bet/raise
  socket.on('action', ({ type, amount }, cb) => {
    const t = state.table;
    // find player's seat index
    let seatIdx = null;
    for (let i=0;i<MAX_SEATS;i++) {
      const s = t.seats[i];
      if (s && s.socketId === socket.id) { seatIdx = i; break; }
    }
    if (seatIdx === null) return cb && cb({ ok:false, error:'not seated' });
    if (t.phase !== 'betting') return cb && cb({ ok:false, error:'not betting' });
    if (t.currentPlayerIndex !== seatIdx) return cb && cb({ ok:false, error:'not your turn' });
    if (t.folded[seatIdx]) return cb && cb({ ok:false, error:'already folded' });

    const player = t.seats[seatIdx];
    const highestBet = Math.max(...t.currentBets);
    if (type === 'fold') {
      t.folded[seatIdx] = true;
      // remove from seatsInHand
      t.seatsInHand = t.seatsInHand.filter(i=>i!==seatIdx);
    } else if (type === 'check_call') {
      const toCall = highestBet - (t.currentBets[seatIdx]||0);
      if (toCall === 0) {
        // check
      } else {
        if (player.chips < toCall) return cb && cb({ ok:false, error:'insufficient chips to call' });
        player.chips -= toCall;
        t.currentBets[seatIdx] = (t.currentBets[seatIdx]||0) + toCall;
        t.pot += toCall;
      }
    } else if (type === 'bet_raise') {
      amount = Math.floor(Number(amount) || 0);
      if (amount <= 0) return cb && cb({ ok:false, error:'invalid amount' });
      const toCall = Math.max(...t.currentBets) - (t.currentBets[seatIdx]||0);
      const totalPut = toCall + amount;
      if (player.chips < totalPut) return cb && cb({ ok:false, error:'insufficient chips' });
      // enforce minimum raise
      if (amount < t.minimumRaise) return cb && cb({ ok:false, error:'raise too small (min ' + t.minimumRaise + ')' });
      player.chips -= totalPut;
      t.currentBets[seatIdx] = (t.currentBets[seatIdx]||0) + totalPut;
      t.pot += totalPut;
      t.minimumRaise = amount;
      t.lastAggressorIndex = seatIdx;
    } else {
      return cb && cb({ ok:false, error:'unknown action' });
    }

    // Advance currentPlayerIndex to next active (not folded and seated) player
    function nextActive(fromIdx) {
      for (let step=1; step<=MAX_SEATS; step++) {
        const idx = (fromIdx + step) % MAX_SEATS;
        if (t.seats[idx] && !t.folded[idx]) return idx;
      }
      return null;
    }
    t.currentPlayerIndex = nextActive(seatIdx);

    // If only one player remains -> end hand early, award pot
    if (t.seatsInHand.length === 1) {
      const winnerIdx = t.seatsInHand[0];
      t.seats[winnerIdx].chips += t.pot;
      t.pot = 0;
      t.phase = 'showdown';
      broadcastTable();
      // prepare for next hand: move dealer already done at start; owner can start again
      setTimeout(()=> {
        t.phase = 'idle';
        broadcastTable();
      }, 2000);
      return cb && cb({ ok:true });
    }

    broadcastTable();

    // If all players have matched bets (no outstanding raises) and lastAggressor is null OR we've cycled back to lastAggressor -> move to next street
    // Simple mechanism: if every active player's currentBets equal max currentBets and lastAggressor is either null or equals previous raiser and we cycled -> advance
    const active = t.seatsInHand.filter(i => !t.folded[i]);
    const maxBet = Math.max(...t.currentBets);
    let allEqual = true;
    for (const idx of active) {
      if ((t.currentBets[idx] || 0) !== maxBet) { allEqual = false; break; }
    }

    // Condition to advance: all active equal and (no last aggressor or last aggressor is null or next active equals lastAggressor)
    if (allEqual) {
      // progress street
      // small delay so clients can see last action
      setTimeout(() => {
        if (t.phase === 'betting') {
          if (t.community.length === 0) {
            // deal flop (burn one then three)
            t.deck.pop(); // burn
            t.community.push(t.deck.pop(), t.deck.pop(), t.deck.pop());
          } else if (t.community.length === 3) {
            t.deck.pop();
            t.community.push(t.deck.pop());
          } else if (t.community.length === 4) {
            t.deck.pop();
            t.community.push(t.deck.pop());
          } else {
            // all streets done -> showdown
            t.phase = 'showdown';
            // evaluate winners
            // determine best hand among active players
            const results = [];
            for (const idx of active) {
              const hole = t.holeCards[idx];
              const seven = hole.concat(t.community);
              const evalr = evaluateBest7(seven);
              results.push({ idx, score: evalr.score, desc: evalr.desc });
            }
            // find best score
            let best = results[0];
            for (const r of results) {
              if (compareScores(r.score, best.score) > 0) best = r;
            }
            // find all tied
            const winners = results.filter(r => compareScores(r.score, best.score) === 0);
            const split = Math.floor(t.pot / winners.length);
            for (const w of winners) {
              t.seats[w.idx].chips += split;
            }
            t.pot = 0;
            broadcastTable();
            // move to idle after showing
            setTimeout(() => {
              t.phase = 'idle';
              broadcastTable();
            }, 3000);
            return;
          }
          // reset current bets for new betting round
          t.currentBets = Array(MAX_SEATS).fill(0);
          // set currentPlayerIndex to first active after dealer
          function nextOccupiedFrom(start) {
            for (let step=1;step<=MAX_SEATS;step++) {
              const idx = (start + step) % MAX_SEATS;
              if (t.seats[idx] && !t.folded[idx]) return idx;
            }
            return null;
          }
          t.currentPlayerIndex = nextOccupiedFrom(t.dealerIndex);
          t.minimumRaise = t.bigBlind;
          broadcastTable();
        }
      }, 400);
    }

    cb && cb({ ok:true });
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // if seated, remove them
    for (let i=0;i<MAX_SEATS;i++) {
      const s = state.table.seats[i];
      if (s && s.socketId === socket.id) state.table.seats[i] = null;
    }
    if (state.table.owner === socket.id) state.table.owner = null;
    broadcastTable();
  });
});

// health
app.get('/healthz', (req,res) => res.send({ ok:true }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on', PORT));
