// server.js
// Simple Hold'em with side pots, dealer rotation, turn-based bets.
// Not production-ready. In-memory state. Suitable for demo and learning.

const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

// --- Config ---
const MAX_SEATS = 6;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MIN_BUYIN = 100;
const MAX_BUYIN = 1000000;

// --- Deck & cards utilities ---
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
function rankIndex(card) { return RANKS.indexOf(card[0]); }
function suitOf(card) { return card[1]; }

// --- Hand evaluator (7-card) ---
function evaluateBest7(cards) {
  // returns score array ranking hand; higher is better lexicographically
  // Implement straight, flush, quads, full house, trips, two pair, one pair, high card
  const n = cards.length;
  if (n < 5) return { score: [0], desc: 'invalid' };

  const counts = Array(13).fill(0);
  const suits = { s: [], h: [], d: [], c: [] };
  for (const c of cards) {
    const r = rankIndex(c);
    counts[r]++;
    suits[suitOf(c)].push(r);
  }

  // unique ranks descending
  const uniqueDesc = [];
  for (let i = 12; i >= 0; i--) if (counts[i]) uniqueDesc.push(i);

  function findStraight(highToLowRanks) {
    const present = Array(13).fill(false);
    for (const r of highToLowRanks) present[r] = true;
    for (let top = 12; top >= 4; top--) {
      let ok = true;
      for (let k = 0; k < 5; k++) if (!present[top - k]) { ok = false; break; }
      if (ok) return top;
    }
    // wheel
    if (present[12] && present[0] && present[1] && present[2] && present[3]) return 3;
    return null;
  }

  // Straight flush
  for (const s of SUITS) {
    if (suits[s].length >= 5) {
      const arr = Array.from(new Set(suits[s])).sort((a,b)=>b-a);
      const sf = findStraight(arr);
      if (sf !== null) return { score: [8, sf], desc: 'Straight Flush' };
    }
  }

  // Quads
  for (let r = 12; r >= 0; r--) if (counts[r] === 4) {
    let kicker = null;
    for (let k = 12; k >= 0; k--) if (k !== r && counts[k] > 0) { kicker = k; break; }
    return { score: [7, r, kicker], desc: 'Four of a Kind' };
  }

  // Full house
  let three = null;
  for (let r = 12; r >= 0; r--) if (counts[r] >= 3) { three = r; break; }
  if (three !== null) {
    // find pair
    let pair = null;
    for (let r = 12; r >= 0; r--) {
      if (r === three) continue;
      if (counts[r] >= 2) { pair = r; break; }
    }
    if (pair !== null) return { score: [6, three, pair], desc: 'Full House' };
    // two triples -> use next triple as pair
    for (let r = 12; r >= 0; r--) {
      if (r !== three && counts[r] >= 3) { pair = r; break; }
    }
    if (pair !== null) return { score: [6, three, pair], desc: 'Full House' };
  }

  // Flush
  for (const s of SUITS) {
    if (suits[s].length >= 5) {
      const top = suits[s].slice().sort((a,b)=>b-a).slice(0,5);
      return { score: [5, ...top], desc: 'Flush' };
    }
  }

  // Straight
  const straightHigh = findStraight(uniqueDesc);
  if (straightHigh !== null) return { score: [4, straightHigh], desc: 'Straight' };

  // Trips
  if (three !== null) {
    const kickers = [];
    for (let r = 12; r >= 0 && kickers.length < 2; r--) if (r !== three && counts[r] > 0) kickers.push(r);
    return { score: [3, three, ...kickers], desc: 'Trips' };
  }

  // Two pair
  let p1 = null, p2 = null;
  for (let r = 12; r >= 0; r--) {
    if (counts[r] >= 2) {
      if (!p1) p1 = r;
      else if (!p2) { p2 = r; break; }
    }
  }
  if (p1 !== null && p2 !== null) {
    let kicker = null;
    for (let r = 12; r >= 0; r--) if (r !== p1 && r !== p2 && counts[r] > 0) { kicker = r; break; }
    return { score: [2, p1, p2, kicker], desc: 'Two Pair' };
  }

  // Pair
  if (p1 !== null) {
    const kickers = [];
    for (let r = 12; r >= 0 && kickers.length < 3; r--) if (r !== p1 && counts[r] > 0) kickers.push(r);
    return { score: [1, p1, ...kickers], desc: 'Pair' };
  }

  // High card
  const top5 = [];
  for (let r = 12; r >= 0 && top5.length < 5; r--) if (counts[r] > 0) top5.push(r);
  return { score: [0, ...top5], desc: 'High Card' };
}

function compareScoreArrays(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

// --- Poker logic helpers (side pots) ---
// Calculate side pots and winners distribution given contributions per seat and active players
function buildPots(contribs, activeMask) {
  // contribs: array indexed by seat -> amount that seat contributed to pot this hand total
  // activeMask: boolean array seat -> true if player eligible to win (not folded)
  // returns array of { amount, eligibleSeats: [idxs] } in order of pot creation
  const pots = [];
  const remaining = contribs.slice();
  while (true) {
    // find positive contributions
    const positive = [];
    for (let i = 0; i < remaining.length; i++) if (remaining[i] > 0) positive.push(i);
    if (positive.length === 0) break;
    // smallest positive value among contributors
    let min = Infinity;
    for (const i of positive) if (remaining[i] < min) min = remaining[i];
    // create pot of min * contributorsCount
    const contributors = positive.slice();
    const potAmount = min * contributors.length;
    pots.push({ amount: potAmount, eligibleSeats: contributors.filter(i => activeMask[i]) });
    // reduce remaining
    for (const i of contributors) remaining[i] -= min;
  }
  return pots;
}

// Distribute pots to winners: winnersIndices may be multiple per pot -> split integer division, remainder stays as 'house' (or give to first)
function distributePots(pots, seatHands) {
  // seatHands: map seat -> {score,desc}
  const results = {}; // seat -> won amount
  for (const p of pots) {
    // among eligible seats, find best score
    let best = null;
    for (const s of p.eligibleSeats) {
      if (!seatHands[s]) continue;
      if (!best) best = { seat: s, score: seatHands[s].score };
      else {
        const cmp = compareScoreArrays(seatHands[s].score, best.score);
        if (cmp > 0) best = { seat: s, score: seatHands[s].score };
      }
    }
    if (!best) continue; // no eligible
    // find all tied
    const winners = [];
    for (const s of p.eligibleSeats) {
      if (!seatHands[s]) continue;
      if (compareScoreArrays(seatHands[s].score, best.score) === 0) winners.push(s);
    }
    const share = Math.floor(p.amount / winners.length);
    let remainder = p.amount - share * winners.length;
    for (let i = 0; i < winners.length; i++) {
      const s = winners[i];
      results[s] = (results[s] || 0) + share;
    }
    // give remainder to first winner (practical)
    if (remainder > 0 && winners.length > 0) {
      results[winners[0]] = (results[winners[0]] || 0) + remainder;
    }
  }
  return results;
}

// --- Table state ---
const state = {
  seats: Array(MAX_SEATS).fill(null), // { socketId, username, chips, id }
  ownerSocket: null,
  dealer: -1, // seat index of dealer (rotates)
  deck: [],
  community: [],
  phase: 'idle', // idle, dealing, betting, showdown
  contributions: Array(MAX_SEATS).fill(0), // total contributed this hand
  currentBets: Array(MAX_SEATS).fill(0), // for current betting round tracking
  folded: Array(MAX_SEATS).fill(false),
  holeCards: {}, // seat -> [c1,c2]
  activeSeats: [], // seats still in hand
  currentTurnSeat: null,
  minimumRaise: BIG_BLIND,
  lastAggressor: null,
  potTotal: 0
};

// --- Broadcast helper (hide hole cards except to their owner; reveal at showdown) ---
function publicStateForSocket(socketId) {
  const seatsView = state.seats.map((s, idx) => {
    if (!s) return null;
    const base = { username: s.username, chips: s.chips, seat: idx, id: s.id, contribution: state.contributions[idx] || 0, currentBet: state.currentBets[idx] || 0, folded: !!state.folded[idx] };
    if (state.holeCards[idx]) {
      // if this socket owns seat idx, reveal hole; otherwise hide unless phase is showdown
      if (s.socketId === socketId || state.phase === 'showdown') base.hole = state.holeCards[idx];
      else base.hole = ['??', '??'];
    }
    return base;
  });
  return {
    seats: seatsView,
    ownerSet: state.ownerSocket !== null,
    ownerSocket: state.ownerSocket,
    dealer: state.dealer,
    phase: state.phase,
    community: state.community.slice(),
    potTotal: state.potTotal,
    currentTurnSeat: state.currentTurnSeat,
    minimumRaise: state.minimumRaise,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND
  };
}
function broadcastAll() {
  io.sockets.sockets.forEach(sock => {
    if (!sock) return;
    sock.emit('state', publicStateForSocket(sock.id));
  });
}

// --- Seat helpers ---
function seatIndexForSocket(socketId) {
  for (let i = 0; i < MAX_SEATS; i++) {
    if (state.seats[i] && state.seats[i].socketId === socketId) return i;
  }
  return -1;
}

// --- Reset hand helpers ---
function resetHand() {
  state.deck = [];
  state.community = [];
  state.phase = 'idle';
  state.contributions = Array(MAX_SEATS).fill(0);
  state.currentBets = Array(MAX_SEATS).fill(0);
  state.folded = Array(MAX_SEATS).fill(false);
  state.holeCards = {};
  state.activeSeats = [];
  state.currentTurnSeat = null;
  state.minimumRaise = BIG_BLIND;
  state.lastAggressor = null;
  state.potTotal = 0;
}

// --- Deal hand ---
function startHand() {
  // must have >=2 seated players with chips
  const seated = [];
  for (let i = 0; i < MAX_SEATS; i++) if (state.seats[i] && state.seats[i].chips > 0) seated.push(i);
  if (seated.length < 2) return { ok: false, error: 'need at least 2 players with chips' };

  resetHand();
  state.deck = shuffle(makeDeck());
  // rotate dealer to next occupied seat
  let start = state.dealer;
  for (let step = 1; step <= MAX_SEATS; step++) {
    const idx = (start + step) % MAX_SEATS;
    if (state.seats[idx] && state.seats[idx].chips > 0) {
      state.dealer = idx;
      break;
    }
  }

  // post blinds: find next occupied after dealer
  function nextOccupied(from) {
    for (let step = 1; step <= MAX_SEATS; step++) {
      const idx = (from + step) % MAX_SEATS;
      if (state.seats[idx] && state.seats[idx].chips > 0) return idx;
    }
    return null;
  }
  const sb = nextOccupied(state.dealer);
  const bb = nextOccupied(sb);
  if (sb === null || bb === null) return { ok: false, error: 'not enough players for blinds' };
  const sbAmt = Math.min(state.seats[sb].chips, SMALL_BLIND);
  state.seats[sb].chips -= sbAmt; state.contributions[sb] = sbAmt; state.currentBets[sb] = sbAmt; state.potTotal += sbAmt;
  const bbAmt = Math.min(state.seats[bb].chips, BIG_BLIND);
  state.seats[bb].chips -= bbAmt; state.contributions[bb] = bbAmt; state.currentBets[bb] = bbAmt; state.potTotal += bbAmt;

  // deal hole cards to seated players in order starting after dealer
  const order = [];
  for (let step = 1; step <= MAX_SEATS; step++) {
    const idx = (state.dealer + step) % MAX_SEATS;
    if (state.seats[idx] && state.seats[idx].chips >= 0) order.push(idx);
  }
  for (const idx of order) {
    const c1 = state.deck.pop(); const c2 = state.deck.pop();
    state.holeCards[idx] = [c1, c2];
  }

  // active seats are those with hole cards
  state.activeSeats = order.slice();
  state.phase = 'betting';
  // current turn: first active after bb
  state.currentTurnSeat = nextOccupied(bb);
  state.minimumRaise = BIG_BLIND;
  state.lastAggressor = null;
  return { ok: true };
}

// --- Betting action handler (fold, call/check, bet/raise, all-in) ---
function advanceToNextActive(fromIdx) {
  for (let step = 1; step <= MAX_SEATS; step++) {
    const idx = (fromIdx + step) % MAX_SEATS;
    const s = state.seats[idx];
    if (!s) continue;
    if (state.folded[idx]) continue;
    // player must still have chips or have contributed (all-in) -> allow them in turn order
    return idx;
  }
  return null;
}

function activePlayersRemaining() {
  let arr = [];
  for (const idx of state.activeSeats) {
    if (!state.folded[idx]) arr.push(idx);
  }
  return arr;
}

function highestCurrentBet() { return Math.max(...state.currentBets); }

function performAction(socketId, action) {
  // action: { type: 'fold'|'call'|'check'|'bet'|'raise'|'allin', amount? }
  const seatIdx = seatIndexForSocket(socketId);
  if (seatIdx === -1) return { ok: false, error: 'not seated' };
  if (state.phase !== 'betting') return { ok: false, error: 'not in betting phase' };
  if (state.currentTurnSeat !== seatIdx) return { ok: false, error: 'not your turn' };
  if (state.folded[seatIdx]) return { ok: false, error: 'already folded' };

  const player = state.seats[seatIdx];
  const highest = highestCurrentBet();
  if (action.type === 'fold') {
    state.folded[seatIdx] = true;
    // remove from activeSeats (but keep contributions)
  } else if (action.type === 'check') {
    if (state.currentBets[seatIdx] !== highest) return { ok: false, error: 'cannot check; need to call or fold' };
    // nothing else
  } else if (action.type === 'call') {
    const toCall = highest - state.currentBets[seatIdx];
    const put = Math.min(toCall, player.chips);
    player.chips -= put;
    state.currentBets[seatIdx] += put;
    state.contributions[seatIdx] += put;
    state.potTotal += put;
    if (player.chips === 0) {
      // all-in; leave them in but note they have zero chips
    }
  } else if (action.type === 'bet' || action.type === 'raise') {
    const amt = Math.floor(Math.max(0, Number(action.amount) || 0));
    if (amt <= 0) return { ok: false, error: 'invalid amount' };
    const toCall = highest - state.currentBets[seatIdx];
    // total to put = toCall + amt
    const totalPut = Math.min(player.chips, toCall + amt);
    if (totalPut <= toCall) return { ok: false, error: 'raise amount too small' };
    // ensure minimal raise
    if (amt < state.minimumRaise) return { ok: false, error: 'raise below minimum: ' + state.minimumRaise };
    player.chips -= totalPut;
    state.currentBets[seatIdx] += totalPut;
    state.contributions[seatIdx] += totalPut;
    state.potTotal += totalPut;
    state.minimumRaise = Math.max(state.minimumRaise, amt);
    state.lastAggressor = seatIdx;
  } else if (action.type === 'allin') {
    const amt = player.chips;
    const toCall = highest - state.currentBets[seatIdx];
    const totalPut = amt;
    player.chips -= totalPut;
    state.currentBets[seatIdx] += totalPut;
    state.contributions[seatIdx] += totalPut;
    state.potTotal += totalPut;
    // if shoved for raise, update minimumRaise accordingly
    const raiseAmt = totalPut - toCall;
    if (raiseAmt > 0) state.minimumRaise = Math.max(state.minimumRaise, raiseAmt);
    state.lastAggressor = seatIdx;
  } else {
    return { ok: false, error: 'unknown action' };
  }

  // Determine next turn
  const next = advanceToNextActive(seatIdx);
  state.currentTurnSeat = next;

  // After action, check if betting round is complete:
  // betting round complete when all active players either folded or have currentBets equal to highest OR are all-in and cannot match
  function bettingRoundComplete() {
    const active = activePlayersRemaining();
    if (active.length <= 1) return true;
    const maxBet = highestCurrentBet();
    for (const idx of active) {
      // if player still has chips and their currentBet != maxBet -> round not complete
      if (state.seats[idx].chips > 0 && state.currentBets[idx] !== maxBet) return false;
    }
    // either everyone matched or remaining players are all-in and can't match
    return true;
  }

  if (bettingRoundComplete()) {
    // Move to next street
    // reset currentBets to zero while keeping contributions for sidepot calc
    state.currentBets = Array(MAX_SEATS).fill(0);
    state.minimumRaise = BIG_BLIND;
    state.lastAggressor = null;
    // Deal community based on count
    if (state.community.length === 0) {
      // burn one
      state.deck.pop();
      // flop
      state.community.push(state.deck.pop(), state.deck.pop(), state.deck.pop());
      state.phase = 'betting';
      // set next turn to first active after dealer
      state.currentTurnSeat = (function () {
        for (let step = 1; step <= MAX_SEATS; step++) {
          const idx = (state.dealer + step) % MAX_SEATS;
          if (state.seats[idx] && !state.folded[idx]) return idx;
        }
        return null;
      })();
    } else if (state.community.length === 3) {
      state.deck.pop();
      state.community.push(state.deck.pop());
      state.phase = 'betting';
      state.currentTurnSeat = (function () {
        for (let step = 1; step <= MAX_SEATS; step++) {
          const idx = (state.dealer + step) % MAX_SEATS;
          if (state.seats[idx] && !state.folded[idx]) return idx;
        }
        return null;
      })();
    } else if (state.community.length === 4) {
      state.deck.pop();
      state.community.push(state.deck.pop());
      state.phase = 'betting';
      state.currentTurnSeat = (function () {
        for (let step = 1; step <= MAX_SEATS; step++) {
          const idx = (state.dealer + step) % MAX_SEATS;
          if (state.seats[idx] && !state.folded[idx]) return idx;
        }
        return null;
      })();
    } else {
      // showdown
      state.phase = 'showdown';
      // Evaluate hands and distribute pots
      // Build active mask: seats that haven't folded
      const activeMask = Array(MAX_SEATS).fill(false);
      for (const idx of state.activeSeats) if (!state.folded[idx]) activeMask[idx] = true;
      // Build pots from contributions
      const pots = buildPots(state.contributions, activeMask);
      // Evaluate hands for eligible seats
      const handMap = {};
      for (let i = 0; i < MAX_SEATS; i++) {
        if (state.holeCards[i] && activeMask[i]) {
          const seven = state.holeCards[i].concat(state.community);
          const evalr = evaluateBest7(seven);
          handMap[i] = { score: evalr.score, desc: evalr.desc };
        }
      }
      // Distribute
      const awards = distributePots(pots, handMap);
      // Apply awards
      for (const [seatStr, amount] of Object.entries(awards)) {
        const seat = Number(seatStr);
        if (state.seats[seat]) state.seats[seat].chips += amount;
      }
      // clear pot total
      state.potTotal = 0;
      // reveal hole cards (publicState handles reveal)
      // after short delay, move to idle and allow owner to start new hand
      setTimeout(() => {
        // cleanup: remove players with zero chips? keep them seated but can't bet
        state.phase = 'idle';
        broadcastAll();
      }, 2500);
    }
  }

  broadcastAll();
  return { ok: true };
}

// --- Socket.IO events ---
io.on('connection', (socket) => {
  console.log('connect', socket.id);
  socket.data.username = null;

  // initial emit
  socket.emit('state', publicStateForSocket(socket.id));
  socket.emit('welcome', { id: socket.id });

  socket.on('set username', (name, cb) => {
    if (!name || typeof name !== 'string') return cb && cb({ ok: false, error: 'invalid' });
    name = name.trim().slice(0, 32);
    socket.data.username = name;
    cb && cb({ ok: true, username: name });
    broadcastAll();
  });

  socket.on('become owner', (cb) => {
    state.ownerSocket = socket.id;
    cb && cb({ ok: true });
    broadcastAll();
  });

  socket.on('sit', ({ seat, buyIn }, cb) => {
    if (!socket.data.username) return cb && cb({ ok: false, error: 'set username first' });
    seat = Number(seat);
    if (isNaN(seat) || seat < 0 || seat >= MAX_SEATS) return cb && cb({ ok: false, error: 'invalid seat' });
    if (state.seats[seat]) return cb && cb({ ok: false, error: 'seat occupied' });
    buyIn = Math.max(MIN_BUYIN, Math.min(MAX_BUYIN, Number(buyIn) || MIN_BUYIN));
    const id = uuidv4();
    state.seats[seat] = { socketId: socket.id, username: socket.data.username, chips: buyIn, id };
    socket.join('table');
    cb && cb({ ok: true });
    broadcastAll();
  });

  socket.on('stand', (cb) => {
    const idx = seatIndexForSocket(socket.id);
    if (idx !== -1) state.seats[idx] = null;
    socket.leave('table');
    cb && cb({ ok: true });
    broadcastAll();
  });

  socket.on('kick', (seat, cb) => {
    if (socket.id !== state.ownerSocket) return cb && cb({ ok: false, error: 'not owner' });
    seat = Number(seat);
    if (isNaN(seat) || seat < 0 || seat >= MAX_SEATS) return cb && cb({ ok: false, error: 'invalid seat' });
    if (state.seats[seat]) {
      const kickedSock = state.seats[seat].socketId;
      const kicked = io.sockets.sockets.get(kickedSock);
      if (kicked) kicked.leave('table');
      state.seats[seat] = null;
    }
    cb && cb({ ok: true });
    broadcastAll();
  });

  socket.on('start hand', (cb) => {
    if (socket.id !== state.ownerSocket) return cb && cb({ ok: false, error: 'not owner' });
    const res = startHand();
    if (!res.ok) return cb && cb(res);
    broadcastAll();
    cb && cb({ ok: true });
  });

  socket.on('action', (act, cb) => {
    const res = performAction(socket.id, act);
    broadcastAll();
    cb && cb(res);
  });

  socket.on('chat', (text) => {
    if (!text) return;
    io.emit('chat', { from: socket.data.username || 'anon', text: String(text).slice(0, 500) });
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // free seat
    const idx = seatIndexForSocket(socket.id);
    if (idx !== -1) state.seats[idx] = null;
    if (state.ownerSocket === socket.id) state.ownerSocket = null;
    broadcastAll();
  });
});

// health route
app.get('/healthz', (req, res) => res.send({ ok: true }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
