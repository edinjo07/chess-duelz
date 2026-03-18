// /app.js
console.log('[APP.JS] Loading...');

/* ===== SESSION AUTHENTICATION ===== */
// Check if user is logged in via dashboard
const userId = sessionStorage.getItem('userId');
let username = sessionStorage.getItem('username');
let balance = parseFloat(sessionStorage.getItem('balance') || '0') * 100; // Convert to cents
let displayName = username || 'Guest'; // Use username as display name
let loggedIn = !!username;
let balanceUpdateInProgress = false; // Prevent race conditions with balance updates

// If not logged in, redirect after a brief delay to allow board to render
if (!userId || !username) {
  console.warn('[APP.JS] No session data found - will redirect to dashboard in 2 seconds');
  setTimeout(() => {
    alert('Please login from the dashboard first');
    window.location.href = '/dashboard';
  }, 2000);
} else {
  console.log('[APP.JS] Logged in as:', username, 'Balance:', balance / 100);
  window.username = username;
  window.userId = userId;
  window.displayName = displayName;
}

// Hide auth card and show bet card since user is already logged in
window.addEventListener('DOMContentLoaded', () => {
  if (loggedIn) {
    const authCard = document.getElementById('authCard');
    const betCard = document.getElementById('betCard');
    if (authCard) authCard.style.display = 'none';
    if (betCard) betCard.style.display = 'block';
    
    // Update UI with user info
    const navUsername = document.getElementById('navUsername');
    if (navUsername) navUsername.textContent = displayName;
    const userNameBottom = document.getElementById('userNameBottom');
    if (userNameBottom) userNameBottom.textContent = displayName;
    
    // Fetch fresh balance from server instead of using stale sessionStorage
    // This ensures balance is always current after refresh
    fetchUserStats();
  }
});

/* ===== THEME ===== */
const THEME = { piecePath: code => `assets/themes/green-classic/pieces/${code}.png` };

/* ===== Multiplayer Callbacks ===== */
// Callback for when opponent makes a move
window.onOpponentMove = function(data) {
  console.log('[MULTIPLAYER] Opponent moved:', data.move);
  
  // Execute the move
  const moved = game.move(data.move);
  if (moved) {
    trackCapturedPiece(moved); // Track captured pieces
    lastMove = {from: moved.from, to: moved.to};
    applyIncrementForSide(moved.color);
    switchClock();
    render();
    updateCapturedPiecesDisplay(); // Update display
    
    // Play sounds
    if (moved.flags && (moved.flags.includes('c') || moved.flags.includes('e'))) {
      sCapture();
    } else {
      sMove();
    }
    if (game.in_check() && !game.in_checkmate()) sCheck();
    
    // Try to execute premove if player has one queued
    tryExecutePremove();
    
    // Don't check for game end here - server will emit game_ended event to both players
  }
};

// Callback for when game ends (from server)
window.onGameEnded = function(data) {
  console.log('[GAME_ENDED] Received from server:', data);
  
  // Update balance from server (convert dollars to cents!)
  balance = Math.round(data.newBalance * 100); // Server sends dollars, we need cents
  updateBalanceUI();
  
  // Stop the game
  stopClock();
  matchStarted = false;
  
  // Store game info for rematch (before cleaning up)
  // Extract color IDs from multiplayerGameData if available
  let whitePlayerId = null;
  let blackPlayerId = null;
  if (window.multiplayerGameData) {
    whitePlayerId = parseInt(window.multiplayerGameData.whitePlayerId);
    blackPlayerId = parseInt(window.multiplayerGameData.blackPlayerId);
  }
  
  window.lastGameInfo = {
    opponentId: data.opponentId,
    opponentUsername: data.opponentUsername,
    betAmount: data.betAmount,
    wasMultiplayer: true,
    previousWhiteId: whitePlayerId,
    previousBlackId: blackPlayerId
  };
  
  // Determine message based on outcome
  let message = '';
  if (data.outcome === 'win') {
    matchResult.className = 'result win';
    message = `You won! ${data.gameResult}\nPayout: $${(data.potAmount).toFixed(2)}`;
    showResultBanner('win', data.potAmount * 100, data.potAmount * 100);
  } else if (data.outcome === 'lose') {
    matchResult.className = 'result lose';
    message = `You lost. ${data.gameResult}\nLost: $${(data.betAmount).toFixed(2)}`;
    showResultBanner('lose', data.potAmount * 100, 0);
  } else {
    matchResult.className = 'result draw';
    const split = data.potAmount / 2;
    message = `Draw. ${data.gameResult}\nYour share: $${(split).toFixed(2)}`;
    showResultBanner('draw', data.potAmount * 100, split * 100);
  }
  
  matchResult.textContent = message;
  // Removed alert - message already shown in UI
  
  // Transform RESIGN button back to DUEL after game ends
  // Note: Use the global duelBtn variable which is already defined at line 3723
  if (duelBtn) {
    duelBtn.textContent = 'DUEL';
    duelBtn.classList.remove('danger');
    duelBtn.onclick = null; // Will be reset by the original event listener
  }
  
  // Clean up multiplayer connection (but keep opponent info for rematch)
  if (window.multiplayer) {
    multiplayer.endGame();
  }
};

// Callback for draw offer
window.onDrawOffered = function() {
  // Show draw offer in status message instead of browser confirm
  const statusMsg = document.getElementById('status-msg');
  if (statusMsg) {
    statusMsg.textContent = 'Opponent offered a draw. Use the Draw button to accept or decline.';
    statusMsg.style.color = '#ffa500';
  }
  
  // Store that there's a pending draw offer
  window.pendingDrawOffer = true;
  
  // Auto-decline after 30 seconds if no response
  setTimeout(() => {
    if (window.pendingDrawOffer) {
      multiplayer.respondToDraw(false);
      window.pendingDrawOffer = false;
      if (statusMsg) {
        statusMsg.textContent = 'Draw offer declined (timeout).';
      }
    }
  }, 30000);
};

// Callback for opponent resignation
window.onOpponentResigned = function() {
  // Show message in status instead of browser alert
  const statusMsg = document.getElementById('status-msg');
  if (statusMsg) {
    statusMsg.textContent = 'Your opponent has resigned. You win!';
    statusMsg.style.color = '#00ff00';
  }
  endMatch();
};

// Callback for rematch request
window.onRematchRequest = function(data) {
  console.log('[REMATCH] Received rematch request:', data);
  
  // Hide the result toast when rematch request comes in
  const resultToast = document.getElementById('resultToast');
  if (resultToast) {
    resultToast.style.display = 'none';
  }
  
  const rematchBanner = document.getElementById('rematchRequestBanner');
  const rematchMessage = document.getElementById('rematchRequestMessage');
  const acceptBtn = document.getElementById('rematchAcceptBtn');
  const declineBtn = document.getElementById('rematchDeclineBtn');
  
  // Show the rematch request banner
  rematchMessage.textContent = `${data.fromUsername} wants a rematch for $${data.betAmount.toFixed(2)}!`;
  rematchBanner.className = 'toast';
  rematchBanner.style.display = 'block';
  rematchBanner.style.transform = 'translate(-50%, -50%) scale(1)';
  
  // Function to close the banner
  const closeBanner = () => {
    rematchBanner.style.display = 'none';
  };
  
  // Handle Accept button
  acceptBtn.onclick = (e) => {
    e.stopPropagation();
    
    // Check balance
    const betAmountCents = data.betAmount * 100;
    if (balance < betAmountCents) {
      statusMsg.textContent = 'Insufficient balance for rematch.';
      statusMsg.style.color = '#ff0000';
      closeBanner();
      multiplayer.respondRematch(
        false, 
        data.fromPlayerId, 
        data.betAmount,
        data.previousWhiteId,
        data.previousBlackId
      );
      return;
    }
    
    console.log('[REMATCH] Accepting rematch');
    console.log('[REMATCH] Colors will be swapped - Previous White:', data.previousWhiteId, 'Previous Black:', data.previousBlackId);
    multiplayer.respondRematch(
      true, 
      data.fromPlayerId, 
      data.betAmount,
      data.previousWhiteId,
      data.previousBlackId
    );
    statusMsg.textContent = 'Rematch accepted! Starting new game...';
    statusMsg.style.color = '#00ffaf';
    closeBanner();
  };
  
  // Handle Decline button
  declineBtn.onclick = (e) => {
    e.stopPropagation();
    console.log('[REMATCH] Declining rematch');
    multiplayer.respondRematch(
      false, 
      data.fromPlayerId, 
      data.betAmount,
      data.previousWhiteId,
      data.previousBlackId
    );
    statusMsg.textContent = 'Rematch declined.';
    closeBanner();
    
    // Clear game state and return to menu
    if (window.multiplayer) {
      multiplayer.clearGameState();
    }
    window.lastGameInfo = null;
    window.multiplayerGameData = null;
  };
  
  // Auto-decline after 30 seconds
  setTimeout(() => {
    if (rematchBanner.style.display === 'block') {
      console.log('[REMATCH] Auto-declining after timeout');
      multiplayer.respondRematch(
        false, 
        data.fromPlayerId, 
        data.betAmount,
        data.previousWhiteId,
        data.previousBlackId
      );
      closeBanner();
    }
  }, 30000);
};

// Callback for rematch declined
window.onRematchDeclined = function(data) {
  console.log('[REMATCH] Rematch declined:', data.reason);
  const statusMsg = document.getElementById('statusMsg');
  if (statusMsg) {
    statusMsg.textContent = `Rematch declined: ${data.reason}`;
    statusMsg.style.color = '#ff8a8a';
  }
  
  // Clear game state and return to menu
  if (window.multiplayer) {
    multiplayer.clearGameState();
  }
  window.lastGameInfo = null;
  window.multiplayerGameData = null;
  
  // Hide any open toasts/banners
  const toast = document.getElementById('resultToast');
  const rematchBanner = document.getElementById('rematchRequestBanner');
  if (toast) toast.style.display = 'none';
  if (rematchBanner) rematchBanner.style.display = 'none';
};

// Callback for server clock updates
window.onClockUpdate = function(data) {
  console.log('[CLOCK_UPDATE] Received from server:', data);
  
  // Sync local clocks with server time
  wMillis = data.whiteTimeMs;
  bMillis = data.blackTimeMs;
  
  // Update the UI immediately
  updateClockUI();
  
  console.log('[CLOCK_UPDATE] Synced - White:', (wMillis/1000).toFixed(1), 's, Black:', (bMillis/1000).toFixed(1), 's');
};

/* ===== Admin override integration (demo) ===== */
let activeOverride = null; // { outcome: 'win'|'lose'|'draw'|'abort'|'null', difficulty?:0..20 }
const SKILL_MAP = { win: 0, lose: 20, draw: 10 }; // fallback mapping

function pullAdminOverride(name){
  try{
    const key = 'admin:override:'+name;
    const raw = localStorage.getItem(key);
    if(!raw) return null;
    localStorage.removeItem(key); // one-shot
    const obj = JSON.parse(raw);
    obj._consumedAt = Date.now();
    const histKey='admin:overrides:history';
    const arr=JSON.parse(localStorage.getItem(histKey)||'[]');
    arr.unshift({ username:name, desired:obj.outcome, consumedAt:obj._consumedAt, resolvedAt:null, actual:null });
    localStorage.setItem(histKey, JSON.stringify(arr.slice(0,200)));
    return obj;
  }catch(_){ return null; }
}
function finalizeAdminHistory(name, actual){
  try{
    const histKey='admin:overrides:history';
    const arr=JSON.parse(localStorage.getItem(histKey)||'[]');
    const row=arr.find(r=>r.username===name && r.resolvedAt===null);
    if(row){ row.resolvedAt=Date.now(); row.actual=actual; localStorage.setItem(histKey, JSON.stringify(arr)); }
  }catch(_){}
}

// =========== RIGGING SYSTEM ============
const RIGGING_KEY = 'treasureChess_rigging';
const RIG_LOGS_KEY = 'treasureChess_rigLogs';

// Active rigging state for the current match (kept in-memory for consistency)
let activeRiggingState = {
  active: false,
  username: null,
  shouldUserWin: false,
  type: null,
  meta: null,
  lockedAt: null
};

function clearActiveRigging(forUser = null) {
  if (activeRiggingState.active && (!forUser || activeRiggingState.username === forUser)) {
    console.log('[RIGGING] Clearing active rigging for', activeRiggingState.username);
  }
  activeRiggingState = {
    active: false,
    username: null,
    shouldUserWin: false,
    type: null,
    meta: null,
    lockedAt: null
  };
}

// Load rigging data from localStorage
function loadRiggingData() {
    try {
        const data = localStorage.getItem(RIGGING_KEY);
        return data ? JSON.parse(data) : {
            singleMatch: {},
            percentage: {},
            logs: []
        };
    } catch (e) {
        console.warn('[rigging] Failed to load rigging data:', e);
        return { singleMatch: {}, percentage: {}, logs: [] };
    }
}

// Save rigging data to localStorage
function saveRiggingData(data) {
    try {
        localStorage.setItem(RIGGING_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('[rigging] Failed to save rigging data:', e);
    }
}

// Add rigging log entry
function addRiggingLog(message) {
    try {
        const logs = JSON.parse(localStorage.getItem(RIG_LOGS_KEY) || '[]');
        logs.push({
            timestamp: new Date().toISOString(),
            message: message
        });
        
        // Keep only last 100 logs
        if (logs.length > 100) {
            logs.splice(0, logs.length - 100);
        }
        
        localStorage.setItem(RIG_LOGS_KEY, JSON.stringify(logs));
    } catch (e) {
        console.warn('[rigging] Failed to add log:', e);
    }
}

// Return the currently locked rigging decision for the active match (if any)
function checkRiggingForUser(username) {
  if (!username) return null;
  if (activeRiggingState.active && activeRiggingState.username === username) {
    return activeRiggingState;
  }
  return null;
}

// Lock a rigging decision for the upcoming match so all subsystems share it
function lockRiggingForMatch(username) {
  if (!username) {
    clearActiveRigging();
    return null;
  }

  if (activeRiggingState.active && activeRiggingState.username === username) {
    return activeRiggingState;
  }

  const data = loadRiggingData();
  let locked = null;

  // Highest priority: single-match rigging
  if (data.singleMatch[username]) {
    const rig = data.singleMatch[username];
    locked = {
      active: true,
      username,
      shouldUserWin: rig.outcome === 'win',
      type: 'single',
      meta: {
        note: rig.note || null,
        timestamp: rig.timestamp,
        outcome: rig.outcome
      }
    };
  } else if (data.percentage[username]) {
    const rig = data.percentage[username];

    if (rig.matchesPlayed < rig.totalMatches) {
      const targetWins = Math.round((rig.winPercentage / 100) * rig.totalMatches);
      const remainingMatches = rig.totalMatches - rig.matchesPlayed;
      const remainingWinsNeeded = targetWins - rig.matchesWon;

      let shouldWin = false;
      let decisionReason = 'probabilistic';

      if (remainingWinsNeeded <= 0) {
        shouldWin = false; // Already ahead of target
        decisionReason = 'ahead_of_target';
      } else if (remainingWinsNeeded >= remainingMatches) {
        shouldWin = true; // Must win remaining matches to hit target
        decisionReason = 'must_win_remaining';
      } else {
        const winProbability = remainingWinsNeeded / remainingMatches;
        shouldWin = Math.random() < winProbability;
        decisionReason = `randomized_${winProbability.toFixed(2)}`;
      }

      locked = {
        active: true,
        username,
        shouldUserWin: shouldWin,
        type: 'percentage',
        meta: {
          note: rig.note || null,
          targetWins,
          totalMatches: rig.totalMatches,
          matchesPlayed: rig.matchesPlayed,
          matchesWon: rig.matchesWon,
          winPercentage: rig.winPercentage,
          decisionReason,
          timestamp: rig.timestamp
        }
      };
    }
  }

  if (locked) {
    activeRiggingState = {
      ...locked,
      lockedAt: Date.now()
    };
    addRiggingLog(`[rig-lock] ${username} -> ${locked.shouldUserWin ? 'FORCE WIN' : 'no win'} via ${locked.type}`);
    console.log('[RIGGING] Locked outcome for', username, '=>', locked.shouldUserWin ? 'WIN' : 'normal');
    return activeRiggingState;
  }

  clearActiveRigging();
  return null;
}

// Update rigging progress after a match
function updateRiggingProgress(username, userWon) {
    if (!username) return;
    
    const data = loadRiggingData();
    
    // Remove single match rig if it was used
    if (data.singleMatch[username]) {
        const rig = data.singleMatch[username];
        const expectedOutcome = rig.outcome === 'win';
        addRiggingLog(`Single match rig executed for ${username}: expected ${rig.outcome}, actual ${userWon ? 'win' : 'loss'}`);
        delete data.singleMatch[username];
    }
    
    // Update percentage rig progress
    if (data.percentage[username]) {
        const rig = data.percentage[username];
        rig.matchesPlayed++;
        if (userWon) rig.matchesWon++;
        
        addRiggingLog(`Percentage rig progress for ${username}: ${rig.matchesWon}/${rig.matchesPlayed} wins (${Math.round(rig.matchesWon/rig.matchesPlayed*100)}%)`);
        
        // Remove if completed
        if (rig.matchesPlayed >= rig.totalMatches) {
            const finalPercentage = Math.round((rig.matchesWon / rig.matchesPlayed) * 100);
            addRiggingLog(`Percentage rig completed for ${username}: ${finalPercentage}% final win rate`);
            delete data.percentage[username];
        }
    }
    
  saveRiggingData(data);

  // Clear locked rigging if it belonged to this user
  clearActiveRigging(username);
}

// Comprehensive rigging diagnostic: window.diagoseRigging('username')
window.diagnoseRigging = function(username) {
  console.group('🔍 COMPREHENSIVE RIGGING DIAGNOSIS for:', username);
  
  // 1. Check rigging data
  const data = loadRiggingData();
  console.log('1. RIGGING DATA:');
  console.log('   Single Match Rigs:', Object.keys(data.singleMatch));
  console.log('   Percentage Rigs:', Object.keys(data.percentage));
  console.log('   Data for user:', {
    single: data.singleMatch[username],
    percentage: data.percentage[username]
  });
  
  // 2. Test rigging check function
  console.log('\n2. CURRENT LOCKED RIGGING:');
  const rigCheck = checkRiggingForUser(username);
  console.log('   Active rigging state:', rigCheck || '(none locked)');
  
  // 3. Check current game state
  console.log('\n3. CURRENT GAME STATE:');
  console.log('   Username:', username);
  console.log('   Match Started:', matchStarted);
  console.log('   Current Skill:', currentSkill);
  console.log('   Last Computer ELO:', window.__lastCompElo);
  console.log('   Gambling Active:', window.__gamblingActive);
  console.log('   Gambling Config:', {
    house_edge: GAMBLING_CONFIG.house_edge_on,
    loss_latency: GAMBLING_CONFIG.loss_latency_on
  });
  
  // 4. Test timing function
  console.log('\n4. TIMING FUNCTION TEST:');
  if (rigCheck && rigCheck.shouldUserWin) {
    const originalHistory = game.history();
    
    // Test different game phases
    game.reset();
    for (let i = 0; i < 25; i++) {
      try { game.move(game.moves()[0]); } catch(e) { break; }
    }
    
    const testTiming = computeThinkMs();
    console.log('   Mid-game timing test:', Math.round(testTiming/1000) + 's');
    
    // Restore original position
    game.reset();
    originalHistory.forEach(move => {
      try { game.move(move); } catch(e) {}
    });
  } else {
    console.log('   No rigging active - timing test skipped');
  }
  
  // 5. Check if there are any overrides
  console.log('\n5. POTENTIAL OVERRIDES:');
  console.log('   activeOverride:', activeOverride);
  console.log('   Gambling State:', window.__gamblingState);
  
  // 6. Test setting engine skill manually
  console.log('\n6. MANUAL ENGINE SKILL TEST:');
  const originalSkill = currentSkill;
  console.log('   Original skill:', originalSkill);
  setEngineSkill(0);
  console.log('   After setEngineSkill(0):', currentSkill);
  setEngineSkill(originalSkill);
  console.log('   Restored to:', currentSkill);
  
  // 7. Check recent logs
  console.log('\n7. RECENT RIGGING LOGS:');
  const logs = JSON.parse(localStorage.getItem(RIG_LOGS_KEY) || '[]');
  const recentLogs = logs.slice(-10);
  recentLogs.forEach(log => {
    if (log.message.includes(username)) {
      console.log('   ' + new Date(log.timestamp).toLocaleTimeString() + ': ' + log.message);
    }
  });
  
  console.groupEnd();
  
  return {
    rigData: data,
    rigCheck: rigCheck,
    currentSkill: currentSkill,
    gamblingActive: window.__gamblingActive,
    matchStarted: matchStarted
  };
};

// Test extreme rigging timing: window.testExtremeRigging('username')
window.testExtremeRigging = function(username) {
  console.group('⏰ EXTREME RIGGING TIMING TEST for:', username);
  
  // Set a single match rig to win
  const data = loadRiggingData();
  data.singleMatch[username] = {
    outcome: 'win',
    note: 'Extreme timing test',
    timestamp: new Date().toISOString()
  };
  saveRiggingData(data);
  
  console.log('✅ Set rigging for', username, 'to WIN with extreme timing');
  lockRiggingForMatch(username);
  
  // Test timing at different game phases
  const testScenarios = [
    { ply: 4, phase: 'Opening', expectedRange: '3-8s' },
    { ply: 15, phase: 'Early Mid', expectedRange: '12-25s' },
    { ply: 25, phase: 'Late Mid', expectedRange: '20-40s' },
    { ply: 40, phase: 'Endgame', expectedRange: '25-50s' }
  ];
  
  // Simulate game state for testing
  const originalPly = game.history().length;
  
  testScenarios.forEach(scenario => {
    // Mock the ply count
    while (game.history().length < scenario.ply) {
      try {
        game.move('e4'); // Add dummy moves
      } catch(e) {
        break; // If we can't add more moves, stop
      }
    }
    
    const timing = computeThinkMs();
    const seconds = Math.round(timing / 1000);
    
    console.log(`${scenario.phase} (ply ${scenario.ply}): ${seconds}s (expected ${scenario.expectedRange})`);
    
    // Reset game state
    game.reset();
  });
  
  // Test with low time pressure
  wMillis = 8000; // 8 seconds left
  bMillis = 8000;
  const panicTiming = computeThinkMs();
  console.log(`Panic mode (8s left): ${Math.round(panicTiming/1000)}s (should be 8-20s but capped)`);
  
  // Reset time
  wMillis = 60000;
  bMillis = 60000;
  
  console.log('\n🎯 Expected behavior:');
  console.log('- Opening: 3-8 seconds');
  console.log('- Early Mid: 12-25 seconds'); 
  console.log('- Late Mid: 20-40 seconds');
  console.log('- Endgame: 25-50 seconds');
  console.log('- Computer should be in serious time trouble');
  console.log('- Weak players may win on time alone');
  
  console.groupEnd();
  return { rigSet: true, expectedTimings: testScenarios };
};

// Test rigging for xhejms: window.testRigForUser('xhejms')
window.testRigForUser = function(username) {
  console.group('🔧 RIGGING TEST for:', username);
  
  // Set a single match rig to win
  const data = loadRiggingData();
  data.singleMatch[username] = {
    outcome: 'win',
    note: 'Debug test rig',
    timestamp: new Date().toISOString()
  };
  saveRiggingData(data);
  addRiggingLog(`Test rig set for ${username}: should win next match`);
  
  console.log('✅ Set single match rig for', username, 'to WIN');
  
  // Lock the decision for consistency
  const rigCheck = lockRiggingForMatch(username);
  console.log('Locked rigging decision:', rigCheck);
  
  // Test ELO computation with rigging
  const userElo = getUserElo(username);
  
  if (window.__gamblingActive && GAMBLING_CONFIG.house_edge_on) {
    console.log('Testing gambling system with rigging...');
    const gamblingResult = configureNextGamblingGame(username);
    console.log('Gambling system result:', gamblingResult);
    console.log('Expected ELO 200, got:', gamblingResult.E_engine);
  } else {
    console.log('Testing casino system with rigging...');
    const casinoResult = computeCasinoBotEloForGame(username, userElo);
    console.log('Casino system result:', casinoResult);
    console.log('Expected ELO 200, got:', casinoResult.botElo);
  }
  
  console.groupEnd();
  return rigCheck;
};

// Debug rigging system: window.debugRigging('username')
window.debugRigging = function(username) {
  if (!username) {
    console.log('[rigging-debug] Please provide username: window.debugRigging("username")');
    return;
  }
  
  console.group('🎰 RIGGING DEBUG for:', username);
  
  // Active rigging state vs stored configuration
  const activeRigging = checkRiggingForUser(username);
  console.log('Active Rigging State:', activeRigging || '(none locked)');
  const storedRigging = loadRiggingData();
  console.log('Stored Single Rig:', storedRigging.singleMatch[username] || '(none)');
  console.log('Stored Percentage Rig:', storedRigging.percentage[username] || '(none)');
  
  // Check which ELO system is active
  console.log('Gambling Active:', window.__gamblingActive);
  console.log('House Edge Config:', GAMBLING_CONFIG.house_edge_on);
  console.log('Current Computer ELO:', window.__lastCompElo);
  console.log('Current Engine Skill:', currentSkill);
  
  // Test both ELO systems
  const userElo = getUserElo(username);
  console.log('User ELO:', userElo);
  
  if (window.__gamblingActive && GAMBLING_CONFIG.house_edge_on) {
    console.log('🎲 GAMBLING SYSTEM ACTIVE');
    const gamblingState = loadGamblingState(username);
    console.log('Gambling State:', gamblingState);
    
    // Test what configureNextGamblingGame would return
    const testGambling = configureNextGamblingGame(username);
    console.log('Test Gambling Config:', testGambling);
    
    const engineParams = eloToEngineSkill(testGambling.E_engine);
    console.log('Engine Params:', engineParams);
  } else {
    console.log('🏰 CASINO SYSTEM ACTIVE');
    const casinoResult = computeCasinoBotEloForGame(username, userElo);
    console.log('Casino Result:', casinoResult);
    
    const skill = skillFromUserElo(casinoResult.botElo);
    console.log('Skill Level:', skill);
  }
  
  // Check rigging logs
  const logs = JSON.parse(localStorage.getItem(RIG_LOGS_KEY) || '[]');
  const userLogs = logs.filter(log => log.message.includes(username)).slice(-5);
  console.log('Recent Rigging Logs for user:', userLogs);
  
  console.groupEnd();
  
  return { activeRigging, userElo, gamblingActive: window.__gamblingActive, currentElo: window.__lastCompElo, currentSkill };
};

// =========== END RIGGING SYSTEM ============

/* ===== Engine loader (Stockfish or offline) ===== */
let engine, engineReady=false, engineQueue=[], engineBusy=false, engineOffline=false;

/* ===== Leela Chess Zero Integration ===== */
let lc0Engine = null;
let useLc0 = true; // Toggle between Stockfish and Lc0 (DEFAULT: Lc0)
let lc0Ready = false;

/* ===== Game Profile Engine - Per-Game Distribution System ===== */
let gameProfileEngine = null;
let currentGameProfile = null;

async function initializeGameProfileEngine() {
  if (!window.GameProfileEngine) {
    console.warn('[Game Profile] GameProfileEngine class not available');
    return false;
  }
  
  try {
    gameProfileEngine = new GameProfileEngine();
    console.log('[Game Profile] Engine initialized');
    return true;
  } catch (error) {
    console.error('[Game Profile] Initialization failed:', error);
    return false;
  }
}

/* ===== Opening Book Integration ===== */
let openingBookEngine = null;
let useOpeningBook = true; // Use real game data for openings

/* ===== Blunder Pattern Integration ===== */
let blunderEngine = null;
let useBlunderPatterns = true; // Inject realistic mistakes based on ELO

/* ===== Middlegame Pattern Integration ===== */
let middlegamePatternEngine = null;
let useMiddlegamePatterns = true; // Use human-like move patterns in middlegame

/* ===== Position Evaluation Tracking ===== */
let lastEngineEvaluation = 0;  // Centipawns from white's perspective
let evaluationHistory = [];     // Track last 5 evaluations for trend analysis

async function initializeMiddlegamePatterns() {
  if (!window.MiddlegamePatternEngine) {
    console.warn('[Middlegame] MiddlegamePatternEngine class not available');
    return false;
  }
  
  try {
    middlegamePatternEngine = new MiddlegamePatternEngine();
    const loaded = await middlegamePatternEngine.loadPatterns();
    console.log('[Middlegame] Initialized:', loaded);
    return loaded;
  } catch (error) {
    console.error('[Middlegame] Initialization failed:', error);
    return false;
  }
}

async function initializeBlunderEngine() {
  if (!window.BlunderEngine) {
    console.warn('[Blunder Engine] BlunderEngine class not available');
    return false;
  }
  
  try {
    blunderEngine = new BlunderEngine();
    const loaded = await blunderEngine.loadBlunderPatterns();
    console.log('[Blunder Engine] Initialized:', loaded);
    return loaded;
  } catch (error) {
    console.error('[Blunder Engine] Initialization failed:', error);
    return false;
  }
}

async function initializeOpeningBook() {
  if (!window.OpeningBookEngine) {
    console.warn('[Opening Book] OpeningBookEngine class not available');
    return false;
  }
  
  try {
    openingBookEngine = new OpeningBookEngine();
    const loaded = await openingBookEngine.loadOpeningBook();
    console.log('[Opening Book] Initialized:', loaded);
    return loaded;
  } catch (error) {
    console.error('[Opening Book] Initialization failed:', error);
    return false;
  }
}

async function initializeLc0(skillLevel) {
  if (!window.Lc0Engine) {
    console.warn('[LC0] Lc0Engine class not available');
    return false;
  }
  
  try {
    lc0Engine = new Lc0Engine();
    lc0Ready = await lc0Engine.initialize({
      useServer: true,
      skillLevel: skillLevel || 1500
    });
    
    if (lc0Ready) {
      console.log('[LC0] Engine initialized successfully');
    } else {
      console.warn('[LC0] Engine not available on server');
    }
    
    return lc0Ready;
  } catch (error) {
    console.error('[LC0] Initialization error:', error);
    return false;
  }
}

// Get move from Lc0 engine (with opening book integration)
async function getLc0Move(skillLevel = 1500) {
  console.log('[ENGINE] getLc0Move called with skillLevel:', skillLevel);
  const moveCount = game.history().length;
  const moveNumber = Math.floor(moveCount / 2) + 1; // Full move number (both sides)
  
  console.log('[ENGINE] Move', moveNumber, '(half-move', moveCount + 1, ')');
  
  // NEW SYSTEM: Check game profile for scheduled actions
  if (gameProfileEngine && currentGameProfile) {
    // 1. Check if we should use opening book (based on profile's opening depth)
    if (useOpeningBook && openingBookEngine && openingBookEngine.loaded) {
      if (gameProfileEngine.shouldUseOpeningBook(moveNumber)) {
        console.log('[ENGINE] Profile allows opening book for move', moveNumber);
        
        const bookResult = await openingBookEngine.getBestMove(
          game,
          skillLevel,
          async () => {
            // Fallback to Lc0 if no book move
            console.log('[ENGINE] No book move found, falling back to Lc0');
            return await getLc0MoveInternal(skillLevel);
          }
        );
        
        if (bookResult) {
          console.log('[ENGINE] Using book move:', bookResult);
          return bookResult;
        }
      } else {
        console.log('[ENGINE] Profile: beyond opening depth, using engine');
      }
    }
    
    // Get the best move first
    const bestMove = await getLc0MoveInternal(skillLevel);
    if (!bestMove) {
      return null;
    }
    
    // 2. Check for errors using dynamic system (with fallback to scheduled)
    let errorToExecute = { type: 'none' };
    
    // Try dynamic system first
    if (typeof gameProfileEngine.shouldMakeErrorDynamic === 'function') {
      try {
        const pressure = (typeof isUnderPressure === 'function') 
          ? isUnderPressure() 
          : null;
        
        errorToExecute = gameProfileEngine.shouldMakeErrorDynamic(moveNumber, pressure);
        
        if (errorToExecute.type !== 'none') {
          console.log(`[ENGINE] � Dynamic ${errorToExecute.type} at move ${moveNumber} (${(errorToExecute.probability * 100).toFixed(1)}% chance, ${errorToExecute.remaining} remaining)`);
        }
      } catch (error) {
        console.error('[Dynamic Error] Failed, using scheduled system:', error);
        errorToExecute = { type: 'none' };
      }
    }
    
    // Fallback to scheduled system if dynamic didn't trigger
    if (errorToExecute.type === 'none') {
      if (gameProfileEngine.shouldBlunderThisMove && gameProfileEngine.shouldBlunderThisMove(moveNumber)) {
        errorToExecute = { type: 'blunder' };
        console.log(`[ENGINE] 🔴 SCHEDULED BLUNDER at move ${moveNumber}!`);
      } else if (gameProfileEngine.shouldMistakeThisMove && gameProfileEngine.shouldMistakeThisMove(moveNumber)) {
        errorToExecute = { type: 'mistake' };
        console.log(`[ENGINE] 🟡 SCHEDULED MISTAKE at move ${moveNumber}!`);
      } else if (gameProfileEngine.shouldInaccuracyThisMove && gameProfileEngine.shouldInaccuracyThisMove(moveNumber)) {
        errorToExecute = { type: 'inaccuracy' };
        console.log(`[ENGINE] � SCHEDULED INACCURACY at move ${moveNumber}!`);
      }
    }
    
    // Execute blunder
    if (errorToExecute.type === 'blunder') {
      if (blunderEngine && blunderEngine.loaded) {
        const blunderMove = await blunderEngine.getBlunderMove(game, bestMove, skillLevel);
        if (blunderMove) {
          console.log(`[ENGINE] Executing blunder: ${JSON.stringify(blunderMove)}`);
          return blunderMove;
        }
      }
    }
    
    // Execute mistake
    if (errorToExecute.type === 'mistake') {
      if (blunderEngine && blunderEngine.loaded) {
        const mistakeMove = await blunderEngine.getBlunderMove(game, bestMove, skillLevel);
        if (mistakeMove) {
          console.log(`[ENGINE] Executing mistake: ${JSON.stringify(mistakeMove)}`);
          return mistakeMove;
        }
      }
    }
    
    // Execute inaccuracy
    if (errorToExecute.type === 'inaccuracy') {
      // Inaccuracies: pick 2nd or 3rd best move
      const legalMoves = game.moves({ verbose: true });
      if (legalMoves.length > 1) {
        const alternatives = legalMoves.filter(move => 
          !(move.from === bestMove.from && move.to === bestMove.to)
        ).slice(0, 3); // Top 3 alternatives
        
        if (alternatives.length > 0) {
          const inaccuracy = alternatives[Math.floor(Math.random() * alternatives.length)];
          console.log(`[ENGINE] Executing inaccuracy: ${inaccuracy.san}`);
          return {
            from: inaccuracy.from,
            to: inaccuracy.to,
            promotion: inaccuracy.promotion
          };
        }
      }
    }
    
    // 4. Check for middlegame pattern usage (11-30 moves)
    if (useMiddlegamePatterns && middlegamePatternEngine && middlegamePatternEngine.loaded) {
      if (gameProfileEngine.shouldUseMiddlegamePattern(moveNumber)) {
        const patternMove = middlegamePatternEngine.getPatternMove(game, skillLevel, moveNumber);
        if (patternMove) {
          console.log(`[ENGINE] Using middlegame pattern at move ${moveNumber}`);
          return patternMove;
        }
      }
    }
    
    // 5. No errors - return best move
    console.log('[ENGINE] No errors triggered, returning best move');
    return bestMove;
    
  } else {
    // LEGACY SYSTEM: Use old probability-based approach if profile not available
    console.warn('[ENGINE] Game profile not available, using legacy system');
    
    // Try opening book first (if in opening phase and book is loaded)
    if (useOpeningBook && openingBookEngine && openingBookEngine.loaded) {
      if (moveCount < 10) { // First 10 moves
        console.log('[ENGINE] Trying opening book for move', moveCount + 1);
        
        const bookResult = await openingBookEngine.getBestMove(
          game,
          skillLevel,
          async () => {
            // Fallback to Lc0 if no book move
            console.log('[ENGINE] No book move found, falling back to Lc0');
            return await getLc0MoveInternal(skillLevel);
          }
        );
        
        if (bookResult) {
          console.log('[ENGINE] Using book move:', bookResult);
          return bookResult;
        }
      }
    }
    
    // Use Lc0 directly
    const bestMove = await getLc0MoveInternal(skillLevel);
    
    if (!bestMove) {
      return null;
    }
    
    // Check if we should use human middlegame pattern (moves 11-30)
    if (useMiddlegamePatterns && middlegamePatternEngine && middlegamePatternEngine.loaded) {
      const patternMove = middlegamePatternEngine.shouldUsePattern(game, skillLevel, moveCount);
      if (patternMove) {
        return patternMove;
      }
    }
    
    // Check if we should inject a blunder (after opening, moves 11+)
    if (useBlunderPatterns && blunderEngine && blunderEngine.loaded && moveCount >= 10) {
      const shouldBlunder = blunderEngine.shouldBlunder(skillLevel, moveCount + 1);
      
      if (shouldBlunder) {
        const blunderMove = await blunderEngine.getBlunderMove(game, bestMove, skillLevel);
        if (blunderMove) {
          console.log(`[ENGINE] Injecting blunder: ${JSON.stringify(blunderMove)}`);
          return blunderMove;
        }
      }
    }
    
    return bestMove;
  }
}

// Internal Lc0 move getter (separated for fallback)
async function getLc0MoveInternal(skillLevel = 1500) {
  if (!lc0Engine || !lc0Ready) {
    console.log('[LC0] Engine not ready, initializing...');
    const initialized = await initializeLc0(skillLevel);
    if (!initialized) {
      console.warn('[LC0] Falling back to Stockfish');
      return null;
    }
  }
  
  try {
    // Set skill level if it has changed
    if (lc0Engine.skillLevel !== skillLevel) {
      lc0Engine.setSkillLevel(skillLevel);
    }
    
    const fen = game.fen();
    
    // Get move history in verbose format to convert to UCI
    const history = game.history({ verbose: true });
    
    console.log('[LC0] Sending request with FEN:', fen);
    console.log('[LC0] Move history (verbose):', history);
    
    // Convert chess.js verbose history to UCI format
    const uciMoves = history.map(move => {
      // move.from and move.to are already in UCI format (e.g., 'e2', 'e4')
      const uci = move.from + move.to + (move.promotion || '');
      return uci;
    });
    
    console.log('[LC0] UCI moves:', uciMoves);
    console.log('[LC0] Calling lc0Engine.getBestMove...');
    const moveData = await lc0Engine.getBestMove(fen, uciMoves);
    console.log('[LC0] Got move:', moveData);
    
    return moveData;
  } catch (error) {
    console.error('[LC0] Error getting move:', error);
    console.error('[LC0] Error stack:', error.stack);
    return null;
  }
}

// Switch between Stockfish and Lc0
function setEngineType(type) {
  useLc0 = (type === 'lc0');
  console.log(`[ENGINE] Switched to: ${useLc0 ? 'Leela Chess Zero' : 'Stockfish'}`);
  
  // Update UI if there's a bot selection dropdown
  const engineSelect = document.getElementById('engineType');
  if (engineSelect) {
    engineSelect.value = type;
  }
}

// Get engine name for display
function getEngineDisplayName() {
  return useLc0 ? 'Leela' : 'Stockfish';
}

// Helper function to execute engine moves (works for both Stockfish and Lc0)
function executeEngineMove(from, to, promotion) {
  console.log('[executeEngineMove] Called with:', {from, to, promotion, matchStarted, isEngineTurn: isEngineTurn(), turn: game.turn(), humanPlays});
  
  if (!matchStarted || !isEngineTurn()) {
    console.log('[ENGINE] Ignoring move - match ended or not engine turn');
    return;
  }
  
  const moved = game.move({from: from, to: to, promotion: promotion || 'q'});
  console.log('[executeEngineMove] Move result:', moved);
  
    recordMoveToDatabase(moved.san, game.fen());
  if (moved) {
    trackCapturedPiece(moved);
    clearLegalGlows();
    lastMove = {from: moved.from, to: moved.to};
    applyIncrementForSide(moved.color);
    switchClock();
    render();
    updateCapturedPiecesDisplay();
    
    // Play sounds
    if (moved.flags && (moved.flags.includes('c') || moved.flags.includes('e'))) {
      sCapture();
    } else {
      sMove();
    }
    if (game.in_check() && !game.in_checkmate()) sCheck();
    
    // Check game end
    if (game.in_checkmate() || game.in_draw()) {
      endMatch();
      return;
    }
    
    tryExecutePremove();
  } else {
    console.error('[executeEngineMove] Move was illegal!');
  }
}
function onEngineMessage(line){
  if(typeof line!=='string') return;
  if(line==='readyok'){ engineReady=true; while(engineReady&&engineQueue.length) engine.postMessage(engineQueue.shift()); return; }
  
  // Collect MultiPV info lines (score + pv)
  if(waitingForMultiPv && line.startsWith('info') && line.includes('pv')){
    // Parse: info depth 10 multipv 1 score cp 25 pv e2e4 e7e5 ...
    const multipvMatch = line.match(/multipv (\d+)/);
    const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
    const pvMatch = line.match(/pv ([a-h][1-8][a-h][1-8][qrbn]?\s*)+/);
    
    if(multipvMatch && pvMatch){
      const pvNum = parseInt(multipvMatch[1]);
      const pvMoves = pvMatch[0].replace('pv ', '').trim().split(/\s+/);
      const firstMove = pvMoves[0];
      
      let score = 0;
      if(scoreMatch){
        const scoreType = scoreMatch[1]; // 'cp' or 'mate'
        const scoreValue = parseInt(scoreMatch[2]);
        if(scoreType === 'mate'){
          // Mate scores: positive = winning, negative = losing
          score = scoreValue > 0 ? 10000 : -10000;
        } else {
          // Centipawn scores
          score = scoreValue;
        }
      }
      
      // NEW: Store evaluation for best move (multipv 1) for dynamic error system
      if(pvNum === 1) {
        lastEngineEvaluation = score;
        evaluationHistory.push(score);
        if(evaluationHistory.length > 5) {
          evaluationHistory.shift(); // Keep only last 5 evaluations
        }
      }
      
      // Store or update this PV line
      const existing = multiPvMoves.find(m => m.pvNum === pvNum);
      if(existing){
        existing.move = firstMove;
        existing.score = score;
      } else {
        multiPvMoves.push({ pvNum, move: firstMove, score });
      }
      console.log(`[MULTIPV] Line ${pvNum}: ${firstMove} (score: ${score}cp)`);
    }
    return;
  }
  
  if(line.startsWith('bestmove')){
    engineBusy=false;
    
    // CRITICAL: Don't execute moves if match has ended
    if (!matchStarted) {
      console.log('[ENGINE] Ignoring bestmove - match has ended');
      multiPvMoves = [];
      waitingForMultiPv = false;
      return;
    }
    
    // CRITICAL: Don't execute Stockfish moves when rigging controller is active
    if (isRigLose()) {
      console.log('[RIGGING] Ignoring Stockfish bestmove - rig controller is active');
      multiPvMoves = [];
      waitingForMultiPv = false;
      return;
    }
    
    const u=line.split(' ')[1]||'', from=u.slice(0,2), to=u.slice(2,4), promo=u[4];
    let selectedMove = from + to + (promo || '');
    
    // Check if this is for the human-like move callback system
    if (engineMoveCallback) {
      console.log('[ENGINE] Calling back with move:', selectedMove);
      const callback = engineMoveCallback;
      engineMoveCallback = null;
      multiPvMoves = [];
      waitingForMultiPv = false;
      callback(selectedMove);
      return;
    }
    
    // Move quality selection disabled - using pure engine evaluation
    // if(waitingForMultiPv && multiPvMoves.length > 0 && opponent && opponent.rating){
    //   const quality = getRandomMoveQuality(opponent.rating);
    //   selectedMove = selectMoveByQuality(quality, multiPvMoves);
    //   console.log(`[BOT-QUALITY] ELO ${opponent.rating} -> quality: ${quality}, selected: ${selectedMove}`);
    // }
    
    multiPvMoves = [];
    waitingForMultiPv = false;
    
    // Execute the selected move
    const moveFrom = selectedMove.slice(0,2);
    const moveTo = selectedMove.slice(2,4);
    const movePromo = selectedMove[4];
    
    const moved=game.move({from: moveFrom, to: moveTo, promotion: movePromo||'q'});
    if(moved){
      recordMoveToDatabase(moved.san, game.fen());
      trackCapturedPiece(moved); // Track captured pieces
      clearLegalGlows(); // ensure glow is cleared on engine move
      lastMove={from:moved.from,to:moved.to};
      applyIncrementForSide(moved.color);
      switchClock(); render();
      updateCapturedPiecesDisplay(); // Update display
      if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
      if(game.in_check()&&!game.in_checkmate()) sCheck();
      if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
      tryExecutePremove();
    }
  }
}
function sendToEngine(cmd){ engineReady? engine.postMessage(cmd) : engineQueue.push(cmd); }
async function createEngineWorker(){
  const paths=['assets/stockfish/stockfish.js','/assets/stockfish/stockfish.js'];
  const abs=p=>new URL(p,location.href).toString();
  const waitReady=w=>new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('not ready')),10000);const h=e=>{const s=String(e.data);if(s==='readyok'||s.includes('uciok')){clearTimeout(t);w.removeEventListener('message',h);engineReady=true;while(engineReady&&engineQueue.length) w.postMessage(engineQueue.shift());res();}};w.addEventListener('message',h);w.postMessage('uci');w.postMessage('isready');});
  for(const rel of paths){try{const b=new Blob([`importScripts("${abs(rel)}");`],{type:'application/javascript'});const u=URL.createObjectURL(b);const w=new Worker(u);URL.revokeObjectURL(u);w.onmessage=e=>onEngineMessage(e.data);await waitReady(w);return w;}catch(e){}}
  for(const rel of paths){try{const r=await fetch(abs(rel),{cache:'no-store'});if(!r.ok) throw 0;const code=await r.text();const b=new Blob([code],{type:'application/javascript'});const u=URL.createObjectURL(b);const w=new Worker(u);URL.revokeObjectURL(u);w.onmessage=e=>onEngineMessage(e.data);await waitReady(w);return w;}catch(e){}}
  return null;
}
async function ensureEngine(){
  if(engine) return;
  engineReady=false; engineBusy=false; engineQueue=[];
  engine=await createEngineWorker();
  if(!engine){ engineOffline=true; return; }
  engineOffline=false; sendToEngine('setoption name Threads value 1'); sendToEngine('setoption name Hash value 16'); sendToEngine('uci'); sendToEngine('isready');
}

/* === Map skill → ELO and cap engine strength === */
function mapSkillToElo(skill){
  const s = Math.max(0, Math.min(20, skill|0));
  return 1000 + Math.round(s * 50); // 1000..2000
}

function setEngineSkill(v){
  let rigData = null;

  // RIGGING PROTECTION: Don't allow skill changes when rigging is active
  if (username) {
    rigData = checkRiggingForUser(username);
    if (rigData && rigData.shouldUserWin && v !== 0) {
      console.log(`[RIGGING] Blocking skill change from ${currentSkill} to ${v} - keeping skill 0 for rigging`);
      addRiggingLog(`Blocked skill change for ${username}: attempted ${v}, kept 0`);
      return; // Don't change skill when rigging is active
    }
  }
  
  currentSkill = Math.max(0, Math.min(20, parseInt(v,10) || 0));
  if(!engineOffline){
    // limit strength by ELO + set skill level; do not change later in the game
    const targetElo = (rigData && rigData.shouldUserWin) ? 200 : mapSkillToElo(currentSkill);
    sendToEngine('setoption name UCI_LimitStrength value true');
    sendToEngine('setoption name UCI_Elo value '+targetElo);
    sendToEngine('setoption name Skill Level value '+currentSkill);

    if (rigData && rigData.shouldUserWin) {
      console.log(`[RIGGING] Engine forced to minimum strength (skill ${currentSkill}, ELO ${targetElo})`);
      addRiggingLog(`Engine downgraded for ${username}: skill ${currentSkill}, ELO ${targetElo}`);
    } else {
      console.log(`[ENGINE] Skill set to ${currentSkill}, ELO: ${targetElo}`);
    }
  }
}

/* ===== Position Analysis Functions for Dynamic Error System ===== */

/**
 * Get position evaluation from bot's perspective
 * Positive = bot winning, Negative = bot losing
 */
function getPositionEvaluation() {
  if (!lastEngineEvaluation) return 0;
  // Flip sign if bot is playing black (Stockfish evaluations are from white's perspective)
  const multiplier = (humanPlays === 'w') ? -1 : 1;
  return lastEngineEvaluation * multiplier;
}

/**
 * Detect if position is deteriorating (stress indicator)
 * Returns true if last 3 evaluations show worsening position
 */
function isPositionDeteriorating() {
  if (evaluationHistory.length < 3) return false;
  
  const recent = evaluationHistory.slice(-3);
  const multiplier = (humanPlays === 'w') ? -1 : 1;
  const adjusted = recent.map(e => e * multiplier);
  
  // Position is deteriorating if each evaluation is worse than previous
  return adjusted[0] > adjusted[1] && adjusted[1] > adjusted[2];
}

/**
 * Calculate position complexity
 * Higher values = more complex position (more pieces, moves, tactical opportunities)
 */
function calculatePositionComplexity() {
  if (!game) return 10;
  
  try {
    const fen = game.fen();
    const pieces = fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
    const legalMoves = game.moves().length;
    
    // Count captures available (tactical complexity)
    const captures = game.moves({ verbose: true })
      .filter(m => m.flags && m.flags.includes('c')).length;
    
    // Complexity formula: weighted sum
    // Starting position: ~32 pieces, ~20 moves, ~0 captures = ~16
    // Complex middlegame: ~24 pieces, ~35 moves, ~8 captures = ~31
    // Simple endgame: ~8 pieces, ~15 moves, ~3 captures = ~12
    return (pieces * 0.3) + (legalMoves * 0.5) + (captures * 2);
  } catch (error) {
    console.error('[COMPLEXITY] Error calculating:', error);
    return 10; // Safe default
  }
}

/**
 * Determine if bot is under pressure based on evaluation and complexity
 * Used to adjust error probabilities dynamically
 */
function isUnderPressure() {
  try {
    const evaluation = getPositionEvaluation();
    const deteriorating = isPositionDeteriorating();
    const complexity = calculatePositionComplexity();
    
    return {
      losing: evaluation < -100,           // Down by 1+ pawn
      losingBadly: evaluation < -300,      // Down by 3+ pawns
      gettingWorse: deteriorating,   // Position deteriorating
      complex: complexity > 25,      // Complex position
      veryComplex: complexity > 35   // Very complex position
    };
  } catch (error) {
    console.error('[PRESSURE] Error analyzing:', error);
    // Safe fallback: no pressure indicators
    return {
      losing: false,
      losingBadly: false,
      gettingWorse: false,
      complex: false,
      veryComplex: false
    };
  }
}

/* ===== Auth + balance ===== */

/* ===== ELO (per-user) ===== */
const ELO_STORAGE_PREFIX = 'elo:';

/** Returns user's ELO, default 1200 on first game */
function getUserElo(u){
  try{
    const raw = localStorage.getItem(ELO_STORAGE_PREFIX + u);
    const v = parseInt(raw, 10);
    return Number.isFinite(v) ? v : 1200;
  }catch(_){ return 1200; }
}

/** Persists user's ELO (clamped to a sane range) */
function setUserElo(u, elo){
  try{
    const v = Math.max(100, Math.min(3000, Math.round(elo)));
    localStorage.setItem(ELO_STORAGE_PREFIX + u, String(v));
    return v;
  }catch(_){ return elo; }
}

/** Adjusts ELO based on outcome ('win'|'lose'|'draw'), returns new ELO */
function adjustEloForOutcome(u, outcome){
  let elo = getUserElo(u);
  if (outcome === 'win') elo += 6;
  else if (outcome === 'lose') elo -= 10;
  return setUserElo(u, elo);
}

/** Map user's ELO to engine skill [0..20] */
function skillFromUserElo(elo){
  // 800 → 0, 1200 → 8, 2200 → 28 (clamped to 20). Tunable.
  return Math.max(0, Math.min(20, Math.round((elo - 800) / 50)));
}

/** Random int in [a,b] */
function randInt(a,b){ return a + Math.floor(Math.random()*(b-a+1)); }


/** Ensure ELO seeded once per username */
function ensureEloInitForUser(u){
  if (!u) return;
  const key = ELO_STORAGE_PREFIX + u;
  try{
    if (!localStorage.getItem(key)) setUserElo(u, 1200);
  }catch(_){}
}
/* ===== Casino Psychology Features ===== */
const CASINO_PSYCHOLOGY = {
  // Near-miss mechanics (almost winning)
  nearMiss: {
    enabled: false, // DISABLED - Using streak system only
    frequency: 0.12, // 12% of losses are "close"
    triggerEvalDiff: 75 // Within 75cp of winning
  },
  
  // Hot/cold streaks feel more pronounced
  streakAmplification: {
    hotStreak: { bonusTime: -100, confidence: 1.2 },
    coldStreak: { penaltyTime: +150, desperation: 1.3 }
  },
  
  // Beginner's luck
  beginnerBonus: {
    gamesThreshold: 0, // DISABLED - Using streak system only
    winRateBoost: 0 // No boost
  },
  
  // Progressive jackpot for long losing streaks
  comebackBonus: {
    triggerLosses: 999, // DISABLED - Using streak system only
    maxBonus: 0 // No bonus
  }
};

function detectNearMiss(finalOutcome, gameState) {
  if (finalOutcome !== 'lose' || !CASINO_PSYCHOLOGY.nearMiss.enabled) return false;
  
  // Check if game was close (within eval threshold)
  const finalEval = evalForColorCp(game, humanPlays);
  const wasClose = Math.abs(finalEval) <= CASINO_PSYCHOLOGY.nearMiss.triggerEvalDiff;
  
  // Near-miss if game was close and random chance
  return wasClose && Math.random() < CASINO_PSYCHOLOGY.nearMiss.frequency;
}

function showNearMissMessage(wasNearMiss) {
  if (!wasNearMiss) return;
  
  // Add near-miss messaging to make losses feel closer
  const nearMissMessages = [
    "So close! That was a tough game.",
    "Almost had it! Great fighting spirit.",
    "Unlucky! You were very close to winning.",
    "Nice try! That was a close battle.",
    "Good game! You almost turned it around."
  ];
  
  const message = nearMissMessages[Math.floor(Math.random() * nearMissMessages.length)];
  
  // Show as a subtle toast notification
  setTimeout(() => {
    const statusMsg = document.getElementById('statusMsg');
    if (statusMsg) {
      const originalText = statusMsg.textContent;
      statusMsg.textContent = message;
      statusMsg.style.color = '#ffa500'; // Orange color for near-miss
      
      setTimeout(() => {
        statusMsg.textContent = originalText;
        statusMsg.style.color = '';
      }, 3000);
    }
  }, 1500);
}

function applyProgressiveJackpot(u) {
  const emotional = loadEmotionalState(u);
  
  if (emotional.consecutiveLosses >= CASINO_PSYCHOLOGY.comebackBonus.triggerLosses) {
    // Progressive bonus gets stronger with more losses
    const bonusMultiplier = Math.min(3.0, 1 + (emotional.consecutiveLosses - 6) * 0.3);
    const eloReduction = Math.min(CASINO_PSYCHOLOGY.comebackBonus.maxBonus, 100 * bonusMultiplier);
    
    console.log(`[Progressive Jackpot] Player on ${emotional.consecutiveLosses} loss streak, applying ${eloReduction} Elo reduction`);
    return eloReduction;
  }
  
  return 0;
}

/* ===== Emotional AI & Streak Tracking ===== */
const EMOTIONAL_STORAGE_KEY = u => `emotional:${u}`;

function loadEmotionalState(u) {
  try {
    const raw = localStorage.getItem(EMOTIONAL_STORAGE_KEY(u));
    if (!raw) {
      return {
        consecutiveWins: 0,
        consecutiveLosses: 0,
        sessionGames: 0,
        frustrationLevel: 0,
        confidenceLevel: 0.5,
        lastGameMood: 'neutral'
      };
    }
    return JSON.parse(raw);
  } catch {
    return {
      consecutiveWins: 0,
      consecutiveLosses: 0,
      sessionGames: 0,
      frustrationLevel: 0,
      confidenceLevel: 0.5,
      lastGameMood: 'neutral'
    };
  }
}

function saveEmotionalState(u, state) {
  try {
    localStorage.setItem(EMOTIONAL_STORAGE_KEY(u), JSON.stringify(state));
  } catch {}
}

function updateEmotionalState(u, outcome) {
  const state = loadEmotionalState(u);
  
  if (outcome === 'win') {
    state.consecutiveWins++;
    state.consecutiveLosses = 0;
    state.frustrationLevel = Math.max(0, state.frustrationLevel - 0.2);
    state.confidenceLevel = Math.min(1.0, state.confidenceLevel + 0.15);
    state.lastGameMood = state.consecutiveWins >= 3 ? 'confident' : 'happy';
  } else if (outcome === 'lose') {
    state.consecutiveWins = 0;
    state.consecutiveLosses++;
    state.frustrationLevel = Math.min(1.0, state.frustrationLevel + 0.25);
    state.confidenceLevel = Math.max(0.1, state.confidenceLevel - 0.1);
    state.lastGameMood = state.consecutiveLosses >= 3 ? 'frustrated' : 'disappointed';
  } else {
    state.consecutiveWins = 0;
    state.consecutiveLosses = 0;
    state.lastGameMood = 'neutral';
  }
  
  state.sessionGames++;
  saveEmotionalState(u, state);
  return state;
}

function getEmotionalMultiplier(u) {
  const state = loadEmotionalState(u);
  let multiplier = 1.0;
  
  // Anti-frustration system
  if (state.consecutiveLosses >= 4) {
    multiplier = 0.7; // Make opponent 30% weaker after 4 losses
  } else if (state.consecutiveLosses >= 6) {
    multiplier = 0.5; // Make opponent 50% weaker after 6 losses (emergency)
  }
  
  // Progressive jackpot system for very long streaks
  const jackpotReduction = applyProgressiveJackpot(u);
  if (jackpotReduction > 0) {
    const jackpotMultiplier = 1.0 - (jackpotReduction / 400); // Convert Elo reduction to multiplier
    multiplier = Math.min(multiplier, jackpotMultiplier);
  }
  
  // Beginner protection
  if (state.sessionGames <= 3) {
    multiplier *= 0.8; // 20% easier for first 3 games
  }
  
  // Confidence boost when winning
  if (state.consecutiveWins >= 3) {
    multiplier *= 1.2; // Slightly harder when on a winning streak
  }
  
  return Math.max(0.3, Math.min(1.5, multiplier)); // Cap between 30% and 150%
}

/* ===== Casino ELO (per-user mood state) ===== */
// Stored per user: mood, lastBotElo, recent results
const CASINO_KEY = u => `casino:${u}`;

function loadCasino(u){
  try {
    const raw = localStorage.getItem(CASINO_KEY(u));
    return raw ? JSON.parse(raw) : { mood:'normal', last_bot_elo:null, results:'' }; // results is a short string like "WLLWD..."
  } catch { return { mood:'normal', last_bot_elo:null, results:'' }; }
}
function saveCasino(u, s){
  try { localStorage.setItem(CASINO_KEY(u), JSON.stringify(s)); } catch {}
}

const MOODS = ['cold','normal','hot'];
const TRANS = { // Markov persistence (streaky feel)
  cold:   [0.60, 0.25, 0.15],  // -> cold, normal, hot
  normal: [0.15, 0.70, 0.15],
  hot:    [0.15, 0.25, 0.60],
};

function stepMood(curr){
  const row = TRANS[curr] || TRANS.normal;
  const u = Math.random();
  return u < row[0] ? 'cold' : (u < row[0]+row[1] ? 'normal' : 'hot');
}

// sample target bot win prob p by mood (with jitter)
function sampleP(mood){
  const clamp01 = x => Math.max(0.05, Math.min(0.95, x));
  const jitter = (base, w=0.10) => clamp01(base + (Math.random()-0.5)*2*w);
  if(mood==='cold')   return jitter(0.25, 0.10);
  if(mood==='hot')    return jitter(0.75, 0.10);
  return jitter(0.50, 0.12);
}

// Elo ↔ win prob (Elo model)
function botEloFromP(userElo, p){ return userElo + 400 * Math.log10(p/(1-p)); }

// Main: compute temporary bot Elo for this game, persist mood/last
function computeCasinoBotEloForGame(u, userElo){
  // Check for rigging overrides first
  const rigData = checkRiggingForUser(u);
  if (rigData && rigData.shouldUserWin) {
    console.log('[RIGGING] User should win - setting computer ELO to 200');
    addRiggingLog(`Rigging activated for ${u}: computer ELO set to 200 for easy win`);
    return { 
      botElo: 200, 
      mood: 'rigged_easy', 
      p_bot_win: 0.1, 
      user_wr_recent: 1.0, 
      emotional_mult: 0.5,
      rigged: true 
    };
  }
  
  const st = loadCasino(u);

  // ---- RTP controller knobs (DISABLED - using streak system only) ----
  let TARGET_USER_WR = 0.50;    // 50% base (neutral, no manipulation)
  const MIN_GAMES_FOR_FULL_GAIN = 12;
  const BASE_GAIN = 0;          // DISABLED - no RTP adjustment
  const MAX_SHIFT_LOGIT = 0;    // DISABLED - no shift allowed
  const STREAK_KICKER = 0;      // DISABLED - using dedicated streak system instead

  // Get emotional state for progressive RTP
  const emotional = loadEmotionalState(u);

  // Progressive RTP DISABLED - using streak system only
  // All players get neutral 50% base regardless of experience
  
  // Anti-frustration boost DISABLED - using streak system only

  // ---- 1) advance mood (streaky feel) with emotional bias ----
  const last = st.results.slice(0, 16);
  let biasToNormal = 0;
  if (last.length >= 6){
    const wins = [...last].filter(x => x === 'W').length;
    const wr = wins / last.length;
    if (Math.abs(wr - 0.5) > 0.18) biasToNormal = 1;
  }
  
  // Emotional influence on mood transitions
  let mood = stepMood(st.mood);
  if (emotional.frustrationLevel > 0.6) {
    mood = (Math.random() < 0.7) ? 'cold' : mood; // More likely to be in "cold" (favorable) mood when frustrated
  }
  if (biasToNormal) mood = (Math.random() < 0.55) ? 'normal' : mood;

  // ---- 2) base bot win prob from mood (variety) ----
  let p = sampleP(mood); // bot win probability BEFORE control

  // ---- 3) RTP control: nudge p so user’s rolling win-rate tends to target ----
  // We operate in logit space for smooth, bounded adjustments:
  const logit = x => Math.log(x/(1-x));
  const invlogit = z => 1 / (1 + Math.exp(-z));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // Compute recent user win-rate (ignore draws)
  const recent = st.results.slice(0, 30);
  let w = 0, l = 0;
  for (const ch of recent) { if (ch === 'W') w++; else if (ch === 'L') l++; }
  const denom = Math.max(1, w + l);
  const userWR = w / denom;

  // Controller gain ramps up with data availability
  const ramp = Math.min(1, denom / MIN_GAMES_FOR_FULL_GAIN);
  const k = BASE_GAIN * ramp;

  // error = (target - actual user WR). Positive error => user under target (losing).
  const err = TARGET_USER_WR - userWR;

  // Shift the BOT’s logit(p). If user is under target (err>0), we LOWER bot p.
  let z = logit(p) - k * err;

  // Enhanced streak kickers with emotional awareness
  const streakLen = (() => {
    let s = 0;
    for (const ch of st.results) { if (ch === st.results[0]) s++; else break; }
    return s;
  })();
  
  if (streakLen >= 3) {
    if (st.results[0] === 'L') {
      z -= STREAK_KICKER * (1 + emotional.frustrationLevel); // Stronger help when frustrated
    } else if (st.results[0] === 'W') {
      z += STREAK_KICKER * (1 + emotional.confidenceLevel * 0.5); // Moderate challenge when confident
    }
  }

  // Cap total shift so it never feels forced
  const baseZ = logit(p);
  z = clamp(z, baseZ - MAX_SHIFT_LOGIT, baseZ + MAX_SHIFT_LOGIT);

  // Back to prob
  p = invlogit(z);

  // ---- 4) Convert final p → bot Elo with emotional multiplier ----
  let botElo = userElo + 400 * Math.log10(p / (1 - p));
  
  // Apply emotional state multiplier
  const emotionalMult = getEmotionalMultiplier(u);
  if (emotionalMult !== 1.0) {
    const targetElo = userElo; // Target should be user's level when helping
    botElo = targetElo + (botElo - targetElo) * emotionalMult;
  }

  // ---- 5) Guardrails: add noise, cap swing, clamp ----
  const ELO_MIN = 100, ELO_MAX = 3000, SWING_CAP = 250, NOISE_SD = 40;

  // small Gaussian noise
  const gauss = (() => {
    let u=0, v=0; while(!u) u=Math.random(); while(!v) v=Math.random();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  })();
  botElo += gauss * NOISE_SD;

  if (Number.isFinite(st.last_bot_elo)){
    const delta = botElo - st.last_bot_elo;
    const capped = Math.max(-SWING_CAP, Math.min(SWING_CAP, delta));
    botElo = st.last_bot_elo + capped;
  }

  botElo = Math.round(clamp(botElo, ELO_MIN, ELO_MAX));

  // ---- 6) persist state for next round ----
  st.mood = mood;
  st.last_bot_elo = botElo;
  saveCasino(u, st);

  return { botElo, mood, p_bot_win: p, user_wr_recent: userWR, emotional_mult: emotionalMult };
}


// call after each game to record result (keeps last ~24)
function recordCasinoResult(u, outcome){
  const st = loadCasino(u);
  const tag = outcome==='win' ? 'W' : outcome==='lose' ? 'L' : 'D';
  st.results = (tag + (st.results || '')).slice(0, 24);
  saveCasino(u, st);
}

/* ===== GAMBLING CHESS SYSTEM (SPEC-1) ===== */
// Casino-style Elo system with house edge and RTP control

// Feature flags - enable/disable specific gambling features
const GAMBLING_CONFIG = {
  house_edge_on: false,       // M2: DISABLED - Using streak system only
  loss_latency_on: false,     // M4: DISABLED - Using streak system only
  rtp_controller_on: false,   // S1: DISABLED - Using streak system only
  audit_logging: true,        // M5: Enable detailed audit logs
};

// Constants for gambling Elo system
const GAMBLING_CONST = {
  // Elo bounds
  E_MIN: 100,
  E_MAX: 3000,
  
  // Learning rates (aggressive convergence in first 3 games)
  K: [120, 200, 320],         // K-values for games 1, 2, 3
  F: [0.50, 0.75, 1.00],      // Convergence factors by game
  
  // House advantage tiers (Elo range -> Delta offset)
  DELTA_BASE_BY_TIER: [
    [0, 800, 350],            // Weak players: +350 Elo house edge
    [800, 1400, 500],         // Average players: +500 Elo
    [1400, 9999, 650]         // Strong players: +650 Elo
  ],
  DELTA_MIN: 200,
  DELTA_MAX: 800,
  
  // RTP controller
  RTP_TARGET: 0.49,           // Target 49% RTP
  DELTA_STEP: 25,             // Elo adjustment step
  RTP_BAND: 0.01,             // ±1% deadband
  ROLL_N: 5000,               // Rolling window size
  
  // Latency model (ms)
  L_MIN: 60,
  L_MAX: 400,
  JITTER_SIGMA: 25,
  LOSS_SLOW_PER_TOKEN: 4,     // +4ms per net-lost token
  LOSS_SLOW_CAP: 120,         // Max extra slowdown
  BETA: 0.6,                  // Clock pressure exponent
  
  // Calibration
  MS_PER_50ELO: 20,           // Every +20ms ~ -50 Elo in bullet
};

// Helper: clamp value between bounds
function clampGambling(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Helper: get tiered delta based on player Elo
function tieredDelta(P_hat, tiers) {
  for (let i = 0; i < tiers.length; i++) {
    const [lo, hi, val] = tiers[i];
    if (P_hat >= lo && P_hat < hi) return val;
  }
  return tiers[tiers.length - 1][2];
}

// Helper: Gaussian random (Box-Muller transform)
function randomGaussian(mean, sigma) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sigma;
}

// Storage key for gambling state
const GAMBLING_KEY = u => `gambling:${u}`;
const GAMBLING_GLOBAL_KEY = 'gambling:global';
const GAMBLING_AUDIT_KEY = 'gambling:audit';

// Load gambling state for user
function loadGamblingState(u) {
  try {
    const raw = localStorage.getItem(GAMBLING_KEY(u));
    if (!raw) {
      // Initialize new player
      return {
        P_hat: 1200,          // Initial Elo estimate
        E_engine: 1200,       // Engine Elo
        games_played: 0,
        net_tokens: 0,        // Wins - losses
        session_start: Date.now(),
      };
    }
    return JSON.parse(raw);
  } catch {
    return {
      P_hat: 1200,
      E_engine: 1200,
      games_played: 0,
      net_tokens: 0,
      session_start: Date.now(),
    };
  }
}

// Save gambling state
function saveGamblingState(u, state) {
  try {
    localStorage.setItem(GAMBLING_KEY(u), JSON.stringify(state));
  } catch {}
}

// Load global RTP data
function loadGlobalRTP() {
  try {
    const raw = localStorage.getItem(GAMBLING_GLOBAL_KEY);
    if (!raw) {
      return {
        outcomes: [],         // Last ROLL_N outcomes [1.0, 0.5, 0.0]
        delta_adjustment: 0,  // Global delta adjustment
        last_update: Date.now(),
      };
    }
    return JSON.parse(raw);
  } catch {
    return { outcomes: [], delta_adjustment: 0, last_update: Date.now() };
  }
}

// Save global RTP data
function saveGlobalRTP(data) {
  try {
    localStorage.setItem(GAMBLING_GLOBAL_KEY, JSON.stringify(data));
  } catch {}
}

// Audit log entry
function logGamblingGame(state, outcome, p_exp, delta, latencies) {
  if (!GAMBLING_CONFIG.audit_logging) return;
  
  try {
    const raw = localStorage.getItem(GAMBLING_AUDIT_KEY) || '[]';
    const logs = JSON.parse(raw);
    
    logs.unshift({
      user: username,
      ts: Date.now(),
      stake: currentBet,
      outcome: outcome,
      P_hat_pre: state.P_hat,
      E_engine_pre: state.E_engine,
      delta: delta,
      latency_avg: latencies.avg || 0,
      latency_max: latencies.max || 0,
      p_exp: p_exp,
      games_played: state.games_played,
      net_tokens: state.net_tokens,
    });
    
    // Keep last 1000 games
    localStorage.setItem(GAMBLING_AUDIT_KEY, JSON.stringify(logs.slice(0, 1000)));
  } catch {}
}

// Configure engine for next game (called before match starts)
function configureNextGamblingGame(u) {
  // Check for rigging overrides first - gambling system can also be rigged
  const rigData = checkRiggingForUser(u);
  if (rigData && rigData.shouldUserWin) {
    console.log('[RIGGING] User should win - overriding gambling system with ELO 200');
    addRiggingLog(`Rigging activated for ${u}: gambling system overridden with ELO 200`);
    const state = loadGamblingState(u);
    state.E_engine = 200; // Force very weak computer
    saveGamblingState(u, state);
    return state;
  }
  
  const state = loadGamblingState(u);
  const gc = GAMBLING_CONST;
  
  const g = Math.min(state.games_played + 1, 3);
  
  if (!GAMBLING_CONFIG.house_edge_on) {
    // No house edge - just match player
    state.E_engine = state.P_hat;
    saveGamblingState(u, state);
    return state;
  }
  
  if (g < 3) {
    // Pre-convergence: pull toward P_hat by F factor
    const diff = state.E_engine - state.P_hat;
    const F_factor = gc.F[g - 1];
    state.E_engine = clampGambling(
      Math.round(state.P_hat + (1 - F_factor) * diff),
      gc.E_MIN,
      gc.E_MAX
    );
  } else {
    // Post-convergence: enforce house advantage Delta
    const globalRTP = loadGlobalRTP();
    let delta_base = tieredDelta(state.P_hat, gc.DELTA_BASE_BY_TIER);
    
    // Apply global RTP adjustment
    delta_base += globalRTP.delta_adjustment;
    
    // Loss compensation (if player is down)
    let delta_loss = 0;
    if (GAMBLING_CONFIG.loss_latency_on && state.net_tokens < 0) {
      const loss_ms = Math.min(gc.LOSS_SLOW_CAP, Math.abs(state.net_tokens) * gc.LOSS_SLOW_PER_TOKEN);
      delta_loss = Math.round((loss_ms / gc.MS_PER_50ELO) * 50);
    }
    
    const delta = clampGambling(delta_base + delta_loss, gc.DELTA_MIN, gc.DELTA_MAX);
    state.E_engine = clampGambling(Math.round(state.P_hat + delta), gc.E_MIN, gc.E_MAX);
    state._last_delta = delta; // Store for logging
  }
  
  saveGamblingState(u, state);
  return state;
}

// Calculate engine latency for move (called per engine move)
function calculateEngineLatency(u, engineSecsLeft) {
  if (!GAMBLING_CONFIG.loss_latency_on) {
    // Use enhanced think time logic
    return computeThinkMs();
  }
  
  const state = loadGamblingState(u);
  const emotional = loadEmotionalState(u);
  const gc = GAMBLING_CONST;
  
  // Base latency from Elo (lower Elo = much slower)
  const base_ms = gc.L_MAX - (state.E_engine - gc.E_MIN) * (gc.L_MAX - gc.L_MIN) / (gc.E_MAX - gc.E_MIN);
  
  // Enhanced loss-based slowdown with Elo consideration
  let loss_ms = 0;
  if (state.net_tokens < 0) {
    loss_ms = Math.min(gc.LOSS_SLOW_CAP * 3, Math.abs(state.net_tokens) * gc.LOSS_SLOW_PER_TOKEN * 2);
  }
  
  // Player Elo-based delays (lower player Elo = much longer computer delays)
  const playerElo = getUserElo(u);
  let eloDelayMultiplier = 1.0;
  if (playerElo < 1000) {
    eloDelayMultiplier = 4.0; // 4x slower for very struggling players
  } else if (playerElo < 1100) {
    eloDelayMultiplier = 2.8; // 2.8x slower for struggling players
  } else if (playerElo < 1200) {
    eloDelayMultiplier = 1.8; // 1.8x slower for below average
  }
  
  // Emotional frustration multiplier
  let emotionalMultiplier = 1.0;
  if (emotional.consecutiveLosses >= 4) {
    emotionalMultiplier = 2.5 + (emotional.consecutiveLosses - 4) * 0.3;
  }
  emotionalMultiplier += emotional.frustrationLevel * 1.2;
  
  // Clock pressure (faster when low on time)
  const pressure = Math.max(0.35, Math.pow(engineSecsLeft / 60.0, gc.BETA));
  
  // Add jitter
  const jitter = randomGaussian(0, gc.JITTER_SIGMA);
  
  // Final latency with all multipliers
  const latency = clampGambling(
    (base_ms * pressure + loss_ms) * eloDelayMultiplier * emotionalMultiplier + jitter,
    gc.L_MIN * 0.8,
    gc.L_MAX * 6.0  // Allow up to 6x longer delays
  );
  
  return Math.round(latency);
}

// Settle game and update state (called after match ends)
function settleGamblingGame(u, outcome) {
  const state = loadGamblingState(u);
  const gc = GAMBLING_CONST;
  
  // Convert outcome to numeric score
  let o = 0.5; // draw
  if (outcome === 'win') o = 1.0;
  else if (outcome === 'lose') o = 0.0;
  
  // Update net tokens
  if (o === 1.0) state.net_tokens += 1;
  else if (o === 0.0) state.net_tokens -= 1;
  
  // Calculate expected score
  const p_exp = 1.0 / (1.0 + Math.pow(10, (state.E_engine - state.P_hat) / 400.0));
  
  // Update player Elo estimate with aggressive K-factor
  const g = Math.min(state.games_played + 1, 3);
  const K = g <= 3 ? gc.K[g - 1] : 32; // Use standard K after convergence
  
  const old_P_hat = state.P_hat;
  state.P_hat = clampGambling(
    state.P_hat + K * (o - p_exp),
    gc.E_MIN,
    gc.E_MAX
  );
  
  // Cap per-game change to ±100 after convergence (S3 guardrail)
  if (g > 3) {
    const delta_change = state.P_hat - old_P_hat;
    if (Math.abs(delta_change) > 100) {
      state.P_hat = old_P_hat + Math.sign(delta_change) * 100;
    }
  }
  
  state.games_played += 1;
  
  // Log to audit trail
  logGamblingGame(state, o, p_exp, state._last_delta || 0, { avg: 0, max: 0 });
  
  // Update global RTP
  updateGlobalRTP(o);
  
  saveGamblingState(u, state);
  
  return state;
}

// Update global RTP and adjust delta if needed
function updateGlobalRTP(outcome) {
  if (!GAMBLING_CONFIG.rtp_controller_on) return;
  
  const globalRTP = loadGlobalRTP();
  const gc = GAMBLING_CONST;
  
  // Add outcome to rolling window
  globalRTP.outcomes.push(outcome);
  if (globalRTP.outcomes.length > gc.ROLL_N) {
    globalRTP.outcomes.shift();
  }
  
  // Calculate RTP (only if we have enough data)
  if (globalRTP.outcomes.length >= 100) {
    const sum = globalRTP.outcomes.reduce((a, b) => a + b, 0);
    const rtp = sum / globalRTP.outcomes.length;
    
    // Check if outside deadband
    if (rtp > gc.RTP_TARGET + gc.RTP_BAND) {
      // Players winning too much - increase house edge
      const bump = Math.ceil((rtp - (gc.RTP_TARGET + gc.RTP_BAND)) / 0.01) * gc.DELTA_STEP;
      globalRTP.delta_adjustment = clampGambling(
        globalRTP.delta_adjustment + bump,
        -100, // Max decrease
        200   // Max increase
      );
      globalRTP.last_update = Date.now();
    } else if (rtp < gc.RTP_TARGET - gc.RTP_BAND) {
      // Players losing too much - decrease house edge
      const bump = Math.ceil(((gc.RTP_TARGET - gc.RTP_BAND) - rtp) / 0.01) * gc.DELTA_STEP;
      globalRTP.delta_adjustment = clampGambling(
        globalRTP.delta_adjustment - bump,
        -100,
        200
      );
      globalRTP.last_update = Date.now();
    }
  }
  
  saveGlobalRTP(globalRTP);
}

// Map Elo to engine skill level (for Stockfish)
function eloToEngineSkill(E_engine) {
  const gc = GAMBLING_CONST;
  
  // Skill level 0-20
  const skill = clampGambling(Math.round((E_engine - 600) / 100), 0, 20);
  
  // Depth 4-24
  const depth = clampGambling(Math.round(6 + (E_engine - 800) / 150), 4, 24);
  
  // Node time 5-60ms
  const nodetime = clampGambling(Math.round(15 + (E_engine - 800) / 3), 5, 60);
  
  return { skill, depth, nodetime };
}




// Generate unique display name based on username
function generateDisplayName(user) {
  if (!user) return 'Guest ' + Math.floor(1000 + Math.random() * 9000);
  // Generate a consistent 4-digit number from username hash
  let hash = 0;
  for (let i = 0; i < user.length; i++) {
    hash = ((hash << 5) - hash) + user.charCodeAt(i);
    hash = hash & hash;
  }
  const num = Math.abs(hash) % 9000 + 1000; // 1000-9999
  return 'User ' + num;
}

const fmt=c=>'$'+(c/100).toFixed(2);
const loginBtn=document.getElementById('loginBtn');
const registerBtn=document.getElementById('registerBtn');
const usernameInput=document.getElementById('username');
const passwordInput=document.getElementById('password');
const balanceInput=document.getElementById('balance');
const balanceRow=document.getElementById('balanceRow');
const authMessage=document.getElementById('authMessage');

document.getElementById('userNameBottom').textContent = displayName || 'Guest';
// Hide user rating display
const userRatingEl = document.getElementById('userRatingBottom');
if (userRatingEl) userRatingEl.style.display = 'none';

const balanceEl=document.getElementById('balance'), balanceTopEl=document.getElementById('balanceTop');
const navBalanceEl = document.getElementById('navBalance');
const authCard=document.getElementById('authCard'), betCard=document.getElementById('betCard'), matchResult=document.getElementById('matchResult');
function updateBalanceUI() {
  const t = fmt(balance);
  if (balanceEl) balanceEl.textContent = t;
  if (balanceTopEl) balanceTopEl.textContent = 'BALANCE: ' + t;
  if (navBalanceEl) navBalanceEl.textContent = t;
}

// Sync balance to server (called after each game)
async function syncBalanceToServer(outcome, betAmount, potAmount) {
  const authToken = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
  if (!authToken) {
    console.log('[balance-sync] ⚠️  No auth token, skipping sync');
    return;
  }
  
  // Convert from cents to dollars for API
  const betDollars = (betAmount / 100).toFixed(2);
  const potDollars = (potAmount / 100).toFixed(2);
  
  try {
    const response = await fetch((window.CHESS_API || 'http://localhost:3000') + '/chess/update-balance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ 
        outcome: outcome,
        betAmount: parseFloat(betDollars),
        potAmount: parseFloat(potDollars)
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      const newBalanceDollars = data.newBalance;
      const newBalanceCents = Math.round(newBalanceDollars * 100);
      
      // Update local balance variable
      balance = newBalanceCents;
      
      // Update sessionStorage so dashboard sees updated balance
      sessionStorage.setItem('balance', newBalanceDollars.toFixed(2));
      
      // Update UI
      updateBalanceUI();
      
      console.log('[balance-sync] ✅ Balance synced to server:', {
        outcome,
        betAmount: betDollars,
        potAmount: potDollars,
        newBalance: newBalanceDollars,
        balanceChange: data.balanceChange
      });
    } else {
      const errorData = await response.json().catch(() => ({}));
      console.error('[balance-sync] ❌ Failed to sync balance:', response.status, errorData);
    }
  } catch (error) {
    console.error('[balance-sync] ❌ Error syncing balance:', error);
  }
}

// Toggle to show/hide balance input for registration
registerBtn.addEventListener('click', () => {
  if (balanceRow.style.display === 'none') {
    // Show registration mode
    balanceRow.style.display = 'block';
    registerBtn.textContent = 'Create Account';
    loginBtn.style.display = 'none';
    authMessage.textContent = '';
  } else {
    // Actually register
    handleRegister();
  }
});

async function handleRegister() {
  const user = usernameInput.value.trim();
  const pass = passwordInput.value.trim();
  const bal = parseFloat(balanceInput.value) || 10000;
  
  if (!user || !pass) {
    authMessage.textContent = '❌ Username and password required';
    authMessage.style.color = '#ff4444';
    return;
  }
  
  if (user.length < 3) {
    authMessage.textContent = '❌ Username must be at least 3 characters';
    authMessage.style.color = '#ff4444';
    return;
  }
  
  if (pass.length < 6) {
    authMessage.textContent = '❌ Password must be at least 6 characters';
    authMessage.style.color = '#ff4444';
    return;
  }
  
  try {
    authMessage.textContent = '⏳ Creating account...';
    authMessage.style.color = '#ffaa00';
    
    const response = await fetch((window.CHESS_API || 'http://localhost:3000') + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass, balance: bal })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      authMessage.textContent = '❌ ' + (data.error || 'Registration failed');
      authMessage.style.color = '#ff4444';
      return;
    }
    
    authMessage.textContent = '✅ Account created! You can now login.';
    authMessage.style.color = '#44ff44';
    
    // Reset to login mode
    balanceRow.style.display = 'none';
    registerBtn.textContent = 'Register';
    loginBtn.style.display = 'block';
    passwordInput.value = '';
    
  } catch (error) {
    console.error('Registration error:', error);
    authMessage.textContent = '❌ Server error - please try again';
    authMessage.style.color = '#ff4444';
  }
}

loginBtn.addEventListener('click', async () => { 
  const user = usernameInput.value.trim();
  const pass = passwordInput.value.trim();
  
  if (!user || !pass) {
    authMessage.textContent = '❌ Username and password required';
    authMessage.style.color = '#ff4444';
    return;
  }
  
  try {
    authMessage.textContent = '⏳ Logging in...';
    authMessage.style.color = '#ffaa00';
    
    const response = await fetch(window.location.origin + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      authMessage.textContent = '❌ ' + (data.error || 'Login failed');
      authMessage.style.color = '#ff4444';
      return;
    }
    
    // Login successful
    username = user;
    displayName = generateDisplayName(user); // Generate unique display name
    balance = Math.round(data.user.balance * 100); // Convert to cents
    
    // CRITICAL FIX: Store username AND userId globally for multiplayer
    window.username = username;
    window.displayName = displayName;
    window.userId = data.user.id; // ← THIS WAS MISSING! Critical for multiplayer
    
    // Use sessionStorage for userId to prevent tab conflicts
    // (localStorage is shared across tabs, causing both players to get same ID)
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('userId', data.user.id.toString());
    sessionStorage.setItem('authToken', data.accessToken);  // FIX: Server sends accessToken not token
    
    // Also keep in localStorage for persistence across sessions
    localStorage.setItem('username', username);
    localStorage.setItem('authToken', data.accessToken);  // FIX: Server sends accessToken not token
    
    // Initialize ELO for user
    ensureEloInitForUser(username);
    
    loggedIn = true;
    authCard.style.display = 'none';
    betCard.style.display = 'block';
    updateBalanceUI();
    updateEloDisplay();
    
    // Update navigation username and bottom display
    const navUsername = document.getElementById('navUsername');
    if (navUsername) navUsername.textContent = displayName;
    
    const userNameBottom = document.getElementById('userNameBottom');
    if (userNameBottom) userNameBottom.textContent = displayName;
    
    statusMsg.textContent = 'Choose a bet and press DUEL.';
    renderMatchHistory();
    
  } catch (error) {
    console.error('Login error:', error);
    authMessage.textContent = '❌ Server error - please try again';
    authMessage.style.color = '#ff4444';
  }
});

/* ===== Board, DnD, Premoves ===== */
const boardEl=document.getElementById('board'), statusMsg=document.getElementById('statusMsg'), legalMovesEl=document.getElementById('legalMoves');
const potBadge=document.getElementById('potBadge');
const files=['a','b','c','d','e','f','g','h'];
let whiteOnBottom=true;

// Helpers: flip only rows (not files) when black is at bottom
function domIndex(r, c){
  // When black is on bottom, flip both rows AND columns for proper mirror
  return whiteOnBottom ? (r*8 + c) : ((7 - r)*8 + (7 - c));
}
function domIndexFromSquare(sq){
  const c = sq.charCodeAt(0)-97;
  const r = 8 - parseInt(sq[1],10);
  return domIndex(r, c);
}

function coordOf(r,c){return files[c]+(8-r);}
function indexOf(sq){const c=sq.charCodeAt(0)-97; const r=8-parseInt(sq[1],10); return {r,c};}
function pieceName(p){return ({k:'King',q:'Queen',r:'Rook',b:'Bishop',n:'Knight',p:'Pawn'})[p]||'?';}
function setPot(c){
  const potBadge = document.getElementById('potBadge');
  const potDisplay = document.getElementById('potDisplay');
  const potAmount = document.getElementById('potAmount');
  const navPotAmount = document.getElementById('navPotAmount');
  const potInfo = document.getElementById('potInfo');
  
  // Hide the floating pot badge
  if (potBadge) {
    potBadge.style.display = 'none';
  }
  
  // Show pot in sidebar and navigation
  if (potDisplay && potAmount) {
    if (matchStarted && c > 0) {
      const potText = fmt(c);
      potAmount.textContent = potText;
      potDisplay.style.display = 'block';
      
      // Update navigation pot
      if (navPotAmount) navPotAmount.textContent = potText;
      if (potInfo) potInfo.style.display = 'flex';
    } else {
      potDisplay.style.display = 'none';
    }
  }
}
/* ===== Pot Fee (Rake) ===== */
const POT_FEE_RATE = 0.00; // No fee - pot = full sum of bets
function netPot(totalPotCents){
  // keep integers (cents); clamp floor at 0
  return Math.max(0, Math.round(totalPotCents * (1 - POT_FEE_RATE)));
}
const STATS_KEYS = { day: 'stats:day', games: 'stats:gamesToday', money: 'stats:moneyToday' };

function todayId(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtInt(n){ return Number(n).toLocaleString('en-US'); }
function fmtUsd(n){ return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }

function initDailyStats(){
  try{
    const now=todayId(), prev=localStorage.getItem(STATS_KEYS.day);
    if(prev!==now){
      localStorage.setItem(STATS_KEYS.day, now);
      localStorage.setItem(STATS_KEYS.games, String(randInt(100000,300000)));
      localStorage.setItem(STATS_KEYS.money, String(randInt(300000,600000))); // start ≥ 300k
    }else{
      if(!localStorage.getItem(STATS_KEYS.games)) localStorage.setItem(STATS_KEYS.games, String(randInt(100000,300000)));
      if(!localStorage.getItem(STATS_KEYS.money)) localStorage.setItem(STATS_KEYS.money, String(randInt(300000,600000)));
    }
  }catch(_){}
}
function getGamesToday(){ try{ return parseInt(localStorage.getItem(STATS_KEYS.games),10)||0; }catch(_){ return 0; } }
function setGamesToday(v){ try{ localStorage.setItem(STATS_KEYS.games, String(Math.max(0,v|0))); }catch(_){ } }
function getMoneyToday(){ try{ return parseInt(localStorage.getItem(STATS_KEYS.money),10)||0; }catch(_){ return 0; } }
function setMoneyToday(v){ try{ localStorage.setItem(STATS_KEYS.money, String(Math.max(0,v|0))); }catch(_){ } }

// Players online (random)
let playersNow = randInt(4800, 5500);
const liveStatsEl = document.getElementById('liveStats');

function updateLiveStatsUI(){
  if(!liveStatsEl) return;
  liveStatsEl.textContent = `${fmtInt(playersNow)} playing | ${fmtInt(getGamesToday())} Games Today | ${fmtUsd(getMoneyToday())} won today`;
}

// Soft jitter for “players now”
let playersTicker=null;
function jitterPlayersNow(){
  const delta = randInt(-12,12);
  playersNow = Math.max(4800, Math.min(5500, playersNow + delta));
  updateLiveStatsUI();
}
function startPlayersJitter(){ if(!playersTicker) playersTicker=setInterval(jitterPlayersNow, 7000+Math.floor(Math.random()*6000)); }
function stopPlayersJitter(){ if(playersTicker){ clearInterval(playersTicker); playersTicker=null; } }

// *** NEW: background drift for games/money today ***
let statsDriftTicker=null;
function driftStep(){
  // Guard against day change mid-session
  if(localStorage.getItem(STATS_KEYS.day)!==todayId()) initDailyStats();

  // Random small growth
  const gInc = randInt(10,300);          // +1..5 games
  const mInc = randInt(150,12000);       // +$15..$120
  setGamesToday(getGamesToday() + gInc);
  setMoneyToday(getMoneyToday() + mInc);
  updateLiveStatsUI();
}
function scheduleNextDrift(){
  const nextMs = randInt(8000, 18000);  // every 8–18 seconds
  statsDriftTicker = setTimeout(()=>{ driftStep(); scheduleNextDrift(); }, nextMs);
}
function startStatsDrift(){ if(!statsDriftTicker){ scheduleNextDrift(); } }
function stopStatsDrift(){ if(statsDriftTicker){ clearTimeout(statsDriftTicker); statsDriftTicker=null; } }

// Boot live stats
(function bootLiveStats(){
  try{
    initDailyStats();
    updateLiveStatsUI();
    startPlayersJitter();
    startStatsDrift();   // <<< start passive growth
  }catch(_){}
})();

// Keep growing even if no games; never block gameplay.
window.addEventListener('beforeunload', ()=>{ stopPlayersJitter(); stopStatsDrift(); });

// Optional: clarify in UI what the pot represents
(function tryAnnotatePotBadge(){
  try { potBadge.title = 'Total prize pool'; } catch(_){}
})();

/* keep badge inside the board container so it floats above it */
function attachPotBadgeToBoard(){ 
  if(potBadge && boardEl && !boardEl.contains(potBadge)) {
    boardEl.appendChild(potBadge); 
  }
}
/* ===== Platform Fee Banner (UI) ===== */
let feeCentsCurrent = 0;
function ensureFeeInfoNode(){
  let el = document.getElementById('feeInfo');
  if (!el) {
    el = document.createElement('div');
    el.id = 'feeInfo';
    // Minimal inline style; avoids CSS file edits.
    el.style.cssText = `
      display:none; margin:8px 0 6px; padding:8px 10px;
      font: 600 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: rgba(0,0,0,0.06); border: 1px solid rgba(0,0,0,0.12);
      border-radius: 8px;
    `;
    // Insert right above the chessboard
    const host = boardEl?.parentElement || document.body;
    host.insertBefore(el, boardEl);
  }
  return el;
}

function hidePlatformFee(){
  feeCentsCurrent = 0;
  const el = document.getElementById('feeInfo');
  if (el) el.style.display = 'none';
}
function buildSquares(){
  boardEl.innerHTML='';
  for(let rr=0; rr<8; rr++){
    for(let cc=0; cc<8; cc++){
      // Visual flip for black: flip both rows and columns for display
      const visualR = whiteOnBottom ? rr : (7 - rr);
      const visualC = whiteOnBottom ? cc : (7 - cc);

      const el=document.createElement('div');
      const dark=(visualR + visualC)%2===0;
      el.className='square '+(dark?'dark':'light');
      // IMPORTANT: dataset.square is ALWAYS standard chess notation (a1-h8)
      // regardless of visual orientation
      el.dataset.square=coordOf(visualR, visualC);

      // rank label on left edge - shows flipped numbers for black
      if(cc===0){
        const sp=document.createElement('span');
        sp.className='coord rank';
        sp.textContent=String(8 - visualR);
        el.appendChild(sp);
      }
      // file label on bottom - shows flipped letters for black (h→a)
      if(rr===7){
        const sp=document.createElement('span');
        sp.className='coord file';
        sp.textContent = files[visualC];
        el.appendChild(sp);
      }

      el.addEventListener('click', onSquareClick, {passive:true});
      el.addEventListener('dragover', onDragOver);
      el.addEventListener('drop', onDrop);
      
      // Add touch event support for better mobile interaction
      el.addEventListener('touchstart', onTouchStart, {passive: false});
      el.addEventListener('touchend', onTouchEnd, {passive: false});
      
      boardEl.appendChild(el);
    }
  }
  attachPotBadgeToBoard();
}

let game=new Chess(), selected=null, lastMove=null;
let premove=null;
let premoveQueue = []; // Queue for multiple premoves (max depth 3)
let dragFrom=null, dragMode='move'; let dragTargets=new Set();
let touchStartSquare=null, touchStartTime=0;

// Custom smooth drag system (chess.com style)
let customDrag = {
  active: false,
  ghostPiece: null,
  startSquare: null,
  startSquareEl: null,
  originalPiece: null,
  legalMoves: [],
  mode: 'move', // 'move' or 'premove'
  startX: 0,
  startY: 0,
  startTime: 0,
  hasMoved: false,
  justTapped: false // Flag to prevent click deselection after tap
};

function createGhostPiece(pieceImg) {
  const ghost = pieceImg.cloneNode(true);
  
  // Capture the actual rendered size of the piece
  const rect = pieceImg.getBoundingClientRect();
  
  // Get square size to ensure ghost doesn't exceed it
  const square = pieceImg.parentElement;
  const squareRect = square ? square.getBoundingClientRect() : null;
  const maxSize = squareRect ? Math.min(squareRect.width, squareRect.height) : rect.width;
  
  // Use the smaller of piece size or square size to prevent oversized ghosts
  const ghostSize = Math.min(rect.width, rect.height, maxSize);
  
  ghost.id = 'drag-ghost';
  ghost.style.position = 'fixed';
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '1000';
  ghost.style.opacity = '1';
  ghost.style.visibility = 'visible'; // Ensure ghost is visible even if original is hidden
  ghost.style.width = ghostSize + 'px'; // Set explicit width, constrained to square size
  ghost.style.height = ghostSize + 'px'; // Set explicit height, constrained to square size
  ghost.style.maxWidth = ghostSize + 'px'; // Prevent any CSS from making it larger
  ghost.style.maxHeight = ghostSize + 'px';
  ghost.style.transform = 'scale(1.1)';
  ghost.style.filter = 'drop-shadow(0 4px 8px rgba(0,0,0,.6))';
  ghost.style.transition = 'none';
  ghost.classList.remove('dragging');
  document.body.appendChild(ghost);
  return ghost;
}

function moveGhostToMouse(e, ghost) {
  const rect = ghost.getBoundingClientRect();
  ghost.style.left = (e.clientX - rect.width / 2) + 'px';
  ghost.style.top = (e.clientY - rect.height / 2) + 'px';
}

function startCustomDrag(square, pieceEl, e) {
  const piece = game.get(square);
  if (!piece || piece.color !== humanPlays) return false;
  
  const playersTurn = !isEngineTurn();
  customDrag.mode = playersTurn ? 'move' : 'premove';
  customDrag.startSquare = square;
  customDrag.startSquareEl = pieceEl.parentElement;
  customDrag.originalPiece = pieceEl;
  customDrag.legalMoves = getLegal(square, customDrag.mode === 'premove');
  customDrag.active = true;
  customDrag.startX = e.clientX;
  customDrag.startY = e.clientY;
  customDrag.startTime = Date.now();
  customDrag.hasMoved = false;
  
  // Set selected when drag starts so highlights appear
  selected = square;
  
  // Hide original piece completely (use visibility instead of opacity)
  pieceEl.style.visibility = 'hidden';
  
  // Create and position ghost
  customDrag.ghostPiece = createGhostPiece(pieceEl);
  moveGhostToMouse(e, customDrag.ghostPiece);
  
  // Show legal moves
  showLegalFrom(square, customDrag.mode === 'premove');
  
  return true;
}

function updateCustomDrag(e) {
  if (!customDrag.active || !customDrag.ghostPiece) return;
  
  // Check if mouse has moved significantly
  const dx = e.clientX - customDrag.startX;
  const dy = e.clientY - customDrag.startY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  
  if (distance > 5) { // 5px threshold
    customDrag.hasMoved = true;
  }
  
  moveGhostToMouse(e, customDrag.ghostPiece);
  
  // Highlight the square under the cursor (for mobile touch feedback)
  const targetEl = document.elementFromPoint(e.clientX, e.clientY);
  const targetSquare = targetEl?.closest('[data-square]');
  
  // Remove previous drag-over highlight
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  
  // Add highlight to current square if it's legal
  if (targetSquare && targetSquare.classList.contains('legal')) {
    targetSquare.classList.add('drag-over');
  }
}

async function endCustomDrag(e) {
  if (!customDrag.active) return;
  
  const duration = Date.now() - customDrag.startTime;
  const wasTap = !customDrag.hasMoved && duration < 200; // Quick tap without movement
  
  // Hide ghost piece BEFORE using elementFromPoint to ensure we detect the square underneath
  if (customDrag.ghostPiece) {
    customDrag.ghostPiece.style.display = 'none';
  }
  
  // Find target square - try multiple times to ensure we get it
  let targetEl = document.elementFromPoint(e.clientX, e.clientY);
  let targetSquare = targetEl?.closest('[data-square]')?.dataset?.square;
  
  // If we didn't find a square, try looking for .square class directly
  if (!targetSquare && targetEl) {
    const squareEl = targetEl.classList?.contains('square') ? targetEl : targetEl.closest('.square');
    targetSquare = squareEl?.dataset?.square;
  }
  
  // Cleanup
  if (customDrag.ghostPiece) {
    customDrag.ghostPiece.remove();
    customDrag.ghostPiece = null;
  }
  if (customDrag.originalPiece) {
    customDrag.originalPiece.style.visibility = 'visible';
  }
  // Remove drag-over highlighting
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  
  const from = customDrag.startSquare;
  const mode = customDrag.mode;
  customDrag.active = false;
  customDrag.startSquare = null;
  customDrag.originalPiece = null;
  customDrag.hasMoved = false;
  
  // If it was a tap (not a drag), just keep piece selected
  if (wasTap) {
    selected = from;
    customDrag.justTapped = true; // Mark to prevent click deselection
    showLegalFrom(from, mode === 'premove');
    render();
    return;
  }
  
  if (!targetSquare || !from) {
    // Dragged piece but didn't drop on valid square - keep it selected
    selected = from;
    showLegalFrom(from, mode === 'premove');
    render();
    return;
  }
  
  // Recalculate legal moves at drop time (in case opponent moved while dragging)
  const currentMoves = getLegal(from, mode === 'premove');
  const cands = currentMoves.filter(m => m.to === targetSquare);
  if (!cands.length) {
    // Tried to move to illegal square - keep piece selected
    sounds.illegalMove.currentTime = 0;
    sounds.illegalMove.play().catch(() => {});
    selected = from;
    showLegalFrom(from, mode === 'premove');
    render();
    return;
  }
  
  // Execute move
  if (mode === 'premove') {
    let promo = cands[0].promotion ? 'q' : undefined;
    setPremove(from, targetSquare, promo || 'q');
    selected = null;
    clearLegalGlows();
    render();
  } else {
    let promo = cands[0].promotion ? 'q' : undefined;
    const moved = game.move({from, to: targetSquare, promotion: promo || 'q'});
    
    if (moved) {
      trackCapturedPiece(moved); // Track captured pieces
      clearLegalGlows();
      lastMove = {from: moved.from, to: moved.to};
      selected = null;
      legalMovesEl.textContent = '';
      applyIncrementForSide(moved.color);
      switchClock();
      render();
      updateCapturedPiecesDisplay(); // Update display
      if (moved.flags && (moved.flags.includes('c') || moved.flags.includes('e'))) sCapture();
      else sMove();
      if (game.in_check() && !game.in_checkmate()) sCheck();
      
      if (opponent && opponent.isHuman && window.multiplayer) {
        multiplayer.sendMove(moved);
      } else {
        if (game.in_checkmate() || game.in_draw()) {
          endMatch();
          return;
        }
      }
      maybeEngineReply();
    } else {
      selected = null;
      clearHighlights();
      render();
    }
  }
}

// ESC key listener for canceling premoves
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (premove || premoveQueue.length > 0)) {
    clearAllPremoves();
  }
});

function clearAllPremoves() {
  premove = null;
  premoveQueue = [];
  render();
  legalMovesEl.textContent = 'Premoves cleared';
  setTimeout(() => { if(legalMovesEl.textContent === 'Premoves cleared') legalMovesEl.textContent = ''; }, 1000);
}

// Touch event handlers for mobile interaction
function onTouchStart(e) {
  if (!matchStarted) return;
  
  // If the touch target is a piece element, let the piece's touch handler deal with it
  const touchTarget = e.target;
  if (touchTarget.classList.contains('piece')) {
    return; // Let piece drag system handle this
  }
  
  const square = e.currentTarget.dataset.square;
  const piece = game.get(square);
  
  // Only prevent default if we're touching a piece that belongs to the current player
  // OR if we're touching an empty square/opponent piece while we have a piece selected
  if ((piece && piece.color === humanPlays) || selected) {
    e.preventDefault(); // Prevent scrolling when interacting with the board
    touchStartSquare = square;
    touchStartTime = Date.now();
  }
}

function onTouchEnd(e) {
  if (!matchStarted || !touchStartSquare) return;
  
  // Check if touch target is a piece
  const touchTarget = e.target;
  const square = e.currentTarget.dataset.square;
  const piece = game.get(square);
  
  // If touching our own piece AND nothing is selected, let piece's touch handler deal with it
  // But if we have a piece selected, we should convert to click for move completion
  if (touchTarget.classList.contains('piece') && piece && piece.color === humanPlays && !selected) {
    touchStartSquare = null;
    return; // Let piece drag system handle initial selection
  }
  
  const touchDuration = Date.now() - touchStartTime;
  
  // If touch was very short (< 300ms), treat as click
  if (touchDuration < 300) {
    e.preventDefault();
    console.log('[onTouchEnd] Converting touch to click on square:', square, 'touchTarget:', touchTarget.className, 'duration:', touchDuration, 'selected:', selected);
    // Simulate a click event
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    });
    e.currentTarget.dispatchEvent(clickEvent);
  }
  
  touchStartSquare = null;
  touchStartTime = 0;
}

// Sound system
const sounds = {
  moveUser: new Audio('NEW SOUNDS/MoveUser.wav'),
  moveOpponent: new Audio('NEW SOUNDS/MoveOpponent.wav'),
  captureUser: new Audio('NEW SOUNDS/CaptureUser.wav'),
  captureOpponent: new Audio('NEW SOUNDS/CaptureOpponent.wav'),
  castlingUser: new Audio('NEW SOUNDS/CastlingUser.wav'),
  castlingOpponent: new Audio('NEW SOUNDS/CastlingOpponent.wav'),
  checkUser: new Audio('NEW SOUNDS/CheckUser.wav'),
  checkOpponent: new Audio('NEW SOUNDS/CheckOpponent.wav'),
  checkmate: new Audio('NEW SOUNDS/CheckMate.wav'),
  stalemate: new Audio('NEW SOUNDS/SalesMate.wav'),
  gameStart: new Audio('NEW SOUNDS/GameStart.wav'),
  gameOver: new Audio('NEW SOUNDS/GameOver.wav'),
  illegalMove: new Audio('NEW SOUNDS/ilegalMove.mp3')
};

// Set volume for all sounds
Object.values(sounds).forEach(sound => {
  sound.volume = 0.5;
  sound.preload = 'auto';
});

// Helper functions to play sounds
function playSound(soundName) {
  try {
    const sound = sounds[soundName];
    if (sound) {
      sound.currentTime = 0; // Reset to start
      sound.play().catch(e => console.log('Sound play failed:', e));
    }
  } catch(e) {
    console.log('Sound error:', e);
  }
}

// Play move sound based on move type
function playMoveSound(moved) {
  const isUserMove = game.turn() !== humanPlays; // Move was made by opposite color
  
  // Check flags: k = kingside castle, q = queenside castle, c = capture, e = en passant
  if (moved.flags && (moved.flags.includes('k') || moved.flags.includes('q'))) {
    // Castling
    playSound(isUserMove ? 'castlingUser' : 'castlingOpponent');
  } else if (moved.flags && (moved.flags.includes('c') || moved.flags.includes('e'))) {
    // Capture or en passant
    playSound(isUserMove ? 'captureUser' : 'captureOpponent');
  } else {
    // Normal move
    playSound(isUserMove ? 'moveUser' : 'moveOpponent');
  }
}

function sMove() { 
  playSound(active === humanPlays ? 'moveUser' : 'moveOpponent'); 
}

function sCapture() { 
  playSound(active === humanPlays ? 'captureUser' : 'captureOpponent'); 
}

function sCheck() { 
  playSound(active === humanPlays ? 'checkUser' : 'checkOpponent'); 
}

function sCastling() {
  playSound(active === humanPlays ? 'castlingUser' : 'castlingOpponent');
}

function sCheckmate() { 
  playSound('checkmate'); 
}

function sStalemate() { 
  playSound('stalemate'); 
}

function sGameStart() { 
  playSound('gameStart'); 
}

function sGameOver() { 
  playSound('gameOver'); 
}

function sError() {
  playSound('error');
}

// Legacy function for compatibility
function sFlag() { 
  playSound('gameOver'); 
}

function clearHighlights(){
  [...boardEl.children].forEach(s=>s.classList.remove('selected','legal','lastmove','in-check','premove-from','premove-to'));
  [...boardEl.querySelectorAll('.hint')].forEach(h=>h.remove());
  legalMovesEl.textContent='';
}

// RAF batching for 60 FPS
let rafPending = false;
let pendingRender = false;

function scheduleRender() {
  if (pendingRender) return; // Already scheduled
  pendingRender = true;
  
  requestAnimationFrame(() => {
    pendingRender = false;
    renderImmediate();
  });
}

function render() {
  // Use RAF batching for smooth 60 FPS
  scheduleRender();
}

function renderImmediate(){
  const state = game.board();
  
  // Store current selection to restore after render
  const currentSelection = selected;
  const currentLegalSquares = [...boardEl.querySelectorAll('.legal')].map(el => el.dataset.square);

  // 1) DIFFERENTIAL RENDERING: Only update changed pieces
  // Build a map of what SHOULD be on each square
  const targetState = {}; // {square: 'wK', 'bQ', etc.}
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = state[r][c];
      const sq = String.fromCharCode(97 + c) + (8 - r);
      if (piece) {
        const code = (piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase();
        targetState[sq] = code;
      }
    }
  }

  // 2) Check each square and only update what changed
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = String.fromCharCode(97 + c) + (8 - r);
      const idx = domIndex(r, c);
      const squareEl = boardEl.children[idx];
      
      // Skip if currently dragging from this square
      if (dragFrom && sq === dragFrom) continue;
      if (customDrag.active && sq === customDrag.startSquare) continue;
      
      // Find existing piece on this square
      let existingPiece = null;
      for (const child of squareEl.children) {
        if (child.classList && child.classList.contains('piece')) {
          // Don't touch dragging pieces
          if (child.classList.contains('dragging')) continue;
          if (child === customDrag.originalPiece) continue;
          existingPiece = child;
          break;
        }
      }
      
      const targetCode = targetState[sq];
      const existingCode = existingPiece ? existingPiece.alt : null;
      
      // Case 1: No change needed
      if (targetCode === existingCode) {
        continue; // Perfect - nothing to do!
      }
      
      // Case 2: Need to remove piece
      if (!targetCode && existingPiece) {
        existingPiece.remove();
        continue;
      }
      
      // Case 3: Need to add or change piece
      if (targetCode) {
        // Remove old piece if exists
        if (existingPiece) {
          existingPiece.remove();
        }
        
        // Create new piece
        const piece = state[r][c];
        const img = document.createElement('img');
        img.className = 'piece';
        
        // Add player-piece class only for player's own pieces
        if (piece.color === humanPlays) {
          img.classList.add('player-piece');
        }
        
        img.alt = targetCode;
        img.src = THEME.piecePath(targetCode);
        img.draggable = false;
        img.style.touchAction = 'none';
        
        // Attach event listeners ONCE when piece is created
        img.addEventListener('mousedown', (e) => {
          if (!matchStarted) return;
          e.preventDefault();
          const square = img.parentElement.dataset.square;
          if (startCustomDrag(square, img, e)) {
            const mouseMoveHandler = (e) => updateCustomDrag(e);
            const mouseUpHandler = (e) => {
              endCustomDrag(e);
              document.removeEventListener('mousemove', mouseMoveHandler);
              document.removeEventListener('mouseup', mouseUpHandler);
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);
          }
        });
        
        img.addEventListener('touchstart', (e) => {
          if (!matchStarted) return;
          
          const square = img.parentElement.dataset.square;
          const piece = game.get(square);
          
          // If this is an opponent's piece and we have a piece selected, don't interfere
          // Let the event bubble through to the square handler for move completion
          if (selected && piece && piece.color !== humanPlays) {
            console.log('[TOUCH] Opponent piece tapped while piece selected - letting event bubble');
            return; // Don't preventDefault, don't stopPropagation - let square handle it
          }
          
          // For our own pieces, prevent default and handle drag
          e.preventDefault();
          e.stopPropagation();
          
          const touch = e.touches[0];
          if (startCustomDrag(square, img, {clientX: touch.clientX, clientY: touch.clientY})) {
            const touchMoveHandler = (e) => {
              e.preventDefault();
              const touch = e.touches[0];
              updateCustomDrag({clientX: touch.clientX, clientY: touch.clientY});
            };
            const touchEndHandler = (e) => {
              e.preventDefault();
              const touch = e.changedTouches[0];
              endCustomDrag({clientX: touch.clientX, clientY: touch.clientY});
              document.removeEventListener('touchmove', touchMoveHandler);
              document.removeEventListener('touchend', touchEndHandler);
              document.removeEventListener('touchcancel', touchEndHandler);
            };
            document.addEventListener('touchmove', touchMoveHandler, {passive: false});
            document.addEventListener('touchend', touchEndHandler, {passive: false});
            document.addEventListener('touchcancel', touchEndHandler, {passive: false});
          }
        }, {passive: false});
        
        squareEl.appendChild(img);
      }
    }
  }

  // 3) Update CSS classes (these are cheap to update)
  [...boardEl.children].forEach(s => s.classList.remove('lastmove', 'in-check'));

  // 4) Apply last-move highlight (exactly two squares)
  if (lastMove) {
    const fd = domIndexFromSquare(lastMove.from);
    const td = domIndexFromSquare(lastMove.to);
    boardEl.children[fd].classList.add('lastmove');
    boardEl.children[td].classList.add('lastmove');
  }

  // 5) Status text & in-check highlight (ONLY if currently in check)
  const turnWord = game.turn() === 'w' ? 'White' : 'Black';
  statusMsg.textContent = (game.in_checkmate()
    ? `${turnWord} is checkmated`
    : game.in_draw() ? `Draw` : `${turnWord} to move`);

  // Only highlight king if CURRENTLY in check and NOT checkmated
  if (game.in_check() && !game.in_checkmate()) {
    const turn = game.turn();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = state[r][c];
        if (piece && piece.type === 'k' && piece.color === turn) {
          const idx = domIndex(r, c);
          boardEl.children[idx].classList.add('in-check');
          break; // Only one king per color
        }
      }
    }
  }

  // 6) Premove highlight
  if (premove) {
    const fd = domIndexFromSquare(premove.from);
    const td = domIndexFromSquare(premove.to);
    boardEl.children[fd]?.classList.add('premove-from');
    boardEl.children[td]?.classList.add('premove-to');
  }

  // 7) Restore selection and legal moves - works ANYTIME (not just on player's turn)
  // This allows planning next move while opponent is thinking
  // ALSO maintain highlights during active drag
  const selectionToRestore = currentSelection || (customDrag.active ? customDrag.startSquare : null);
  
  if (selectionToRestore) {
    console.log('[RESTORE] Attempting to restore selection:', selectionToRestore);
    // Check if the piece is still there and belongs to the player
    const piece = game.get(selectionToRestore);
    console.log('[RESTORE] Piece at square:', piece, 'humanPlays:', humanPlays);
    if (piece && piece.color === humanPlays) {
      selected = selectionToRestore;
      const diFrom = domIndexFromSquare(selectionToRestore);
      boardEl.children[diFrom]?.classList.add('selected');
      
      // IMPORTANT: Calculate legal moves correctly based on whose turn it is
      // If opponent's turn, use premove logic (hypothetical position where we can move)
      // If our turn, use actual current position
      const needsPremove = (game.turn() !== humanPlays);
      const moves = getLegal(selectionToRestore, needsPremove);
      
      // If actively dragging, update the legal moves in customDrag
      if (customDrag.active && customDrag.startSquare === selectionToRestore) {
        customDrag.legalMoves = moves;
        customDrag.mode = needsPremove ? 'premove' : 'move';
      }
      
      console.log('[RESTORE] Calculated', moves.length, 'legal moves (needsPremove:', needsPremove + ')');
      moves.forEach(m => {
        const di = domIndexFromSquare(m.to);
        const squareEl = boardEl.children[di];
        squareEl?.classList.add('legal');
        
        // Check if this is a capture move
        const targetPiece = game.get(m.to);
        if(targetPiece) {
          squareEl?.classList.add('capture');
        }
      });
    } else {
      // Piece no longer there or not player's piece - clear selection
      console.log('[RESTORE] Clearing selection - piece invalid');
      selected = null;
    }
  } else {
    console.log('[RESTORE] No currentSelection to restore');
  }

  // 8) Moves list
  renderMoves();
}

// (kept for API completeness, but we no longer append dots in showLegalFrom)
function addHint(di){ const host=boardEl.children[di]; const hint=document.createElement('div'); hint.className='hint'; const dot=document.createElement('i'); hint.appendChild(dot); host.appendChild(hint); }
function getLegal(from, forPremove=false){
  if(!forPremove) return game.moves({square:from, verbose:true});
  const fen=game.fen().split(' '); 
  console.log('[getLegal] Original FEN:', fen.join(' '));
  console.log('[getLegal] Original turn (fen[1]):', fen[1], 'humanPlays:', humanPlays);
  fen[1]=humanPlays; // Change turn
  fen[3]='-'; // Clear en passant (it's only valid for opponent's immediate response)
  console.log('[getLegal] Modified FEN:', fen.join(' '));
  const tmp=new Chess(fen.join(' '));
  const allMoves = tmp.moves({square:from, verbose:true});
  console.log('[getLegal] All moves from tmp:', allMoves.length);
  const filtered = allMoves.filter(m=>m.color===humanPlays);
  console.log('[getLegal] Filtered moves:', filtered.length);
  return filtered;
}
function showLegalFrom(from, forPremove=false){
  // remove previous legal glows but keep last-move + other markers
  clearLegalGlows();

  // (re)mark the selected origin
  const diFrom = domIndexFromSquare(from);
  // clear previous selection (only selection)
  [...boardEl.children].forEach(s=>s.classList.remove('selected'));
  boardEl.children[diFrom].classList.add('selected');

  const moves=getLegal(from, forPremove);
  for(const m of moves){
    const di = domIndexFromSquare(m.to);
    const squareEl = boardEl.children[di];
    squareEl.classList.add('legal');
    
    // Check if this is a capture move (target square has a piece)
    const targetPiece = game.get(m.to);
    if(targetPiece) {
      squareEl.classList.add('capture'); // Add capture class for ring style
    }
  }

  const p=game.get(from);
  const sanList=moves.map(m=>m.san || (m.from+m.to)).join(', ');
  legalMovesEl.textContent = moves.length
    ? `${pieceName(p?.type)} ${from}: ${sanList}`
    : `${pieceName(p?.type)} ${from}: (no legal moves)`;
  
  // Render once at the end to show selection + legal moves
  render();
  return moves;
}

function clearLegalGlows(){
  [...boardEl.querySelectorAll('.legal')].forEach(el=>el.classList.remove('legal'));
  [...boardEl.querySelectorAll('.capture')].forEach(el=>el.classList.remove('capture'));
  [...boardEl.querySelectorAll('.hint')].forEach(el=>el.remove());
  [...boardEl.querySelectorAll('.premove-from')].forEach(el=>el.classList.remove('premove-from'));
  [...boardEl.querySelectorAll('.premove-to')].forEach(el=>el.classList.remove('premove-to'));
}

function setPremove(from,to,promotion='q'){
  console.log('[PREMOVE] Setting premove:', from, '→', to, 'promo:', promotion);
  const newPremove = {from, to, promotion};
  
  // If no premove set yet, set it as the primary premove
  if (!premove) {
    premove = newPremove;
    console.log('[PREMOVE] Set as primary premove');
  } else if (premoveQueue.length < 3) {
    // Add to queue (max depth 3)
    premoveQueue.push(newPremove);
    console.log('[PREMOVE] Added to queue, queue length:', premoveQueue.length);
  } else {
    // Queue full, replace oldest
    premoveQueue.shift();
    premoveQueue.push(newPremove);
    console.log('[PREMOVE] Queue full, replaced oldest');
  }
  
  clearHighlights();
  const fd=domIndexFromSquare(from), td=domIndexFromSquare(to);
  boardEl.children[fd]?.classList.add('premove-from'); 
  boardEl.children[td]?.classList.add('premove-to');
  
  const totalPremoves = 1 + premoveQueue.length;
  legalMovesEl.textContent=`Premove${totalPremoves > 1 ? 's' : ''} set (${totalPremoves}): ${from} → ${to}${promotion?` (= ${promotion.toUpperCase()})`:''}`;
  console.log('[PREMOVE] UI updated, total premoves:', totalPremoves);
}

function clearPremove(){ 
  premove=null; 
  // Don't clear queue here - only clear current premove
  render(); 
}

function tryExecutePremove(){
  if(!premove || !matchStarted) return;
  if(game.turn()!==humanPlays) return;
  
  console.log('[PREMOVE] Attempting to execute premove:', premove);
  
  // Execute premove with minimal delay for visual feedback  (50ms for bullet chess)
  setTimeout(() => {
    if(!premove || game.turn()!==humanPlays) return; // Double-check
    
    const legal=game.moves({verbose:true});
    const m=legal.find(x=>x.from===premove.from && x.to===premove.to && (!x.promotion || x.promotion===premove.promotion));
    if(!m){ 
      console.log('[PREMOVE] ❌ Premove is illegal, clearing');
      // Premove is illegal, clear it and the queue
      clearAllPremoves();
      return; 
    }
    
    console.log('[PREMOVE] ✅ Executing premove:', m);
    const moved=game.move({from:m.from,to:m.to,promotion:premove.promotion||m.promotion||'q'}); 
    
    // Shift queue: move next premove to primary
    if (premoveQueue.length > 0) {
      premove = premoveQueue.shift();
    } else {
      premove = null;
    }
    
    if(moved){
      trackCapturedPiece(moved); // Track captured pieces
      clearLegalGlows();
      lastMove={from:moved.from,to:moved.to};
      applyIncrementForSide(moved.color);
      switchClock(); render();
      updateCapturedPiecesDisplay(); // Update display
      if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
      if(game.in_check()&&!game.in_checkmate()) sCheck();
      
      // Send move to opponent if multiplayer
      if (opponent && opponent.isHuman && window.multiplayer) {
        multiplayer.sendMove(moved);
        // Don't call endMatch() here - server will emit game_ended to both players
      } else {
        // Single player vs bot - check for game end locally
        if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
      }
      
      maybeEngineReply();
    }
  }, 50); // 50ms delay for smooth visual feedback
}

const promoteModal=document.getElementById('promoteModal');
function needsPromotion(from,to){
  const p=game.get(from); if(!p || p.type!=='p') return false;
  const rank=parseInt(to[1],10);
  return (p.color==='w'&&rank===8)||(p.color==='b'&&rank===1);
}

// For bullet chess: auto-promote to queen (no modal blocking)
// Users can hold Ctrl/Cmd for modal if they want different piece
function choosePromotion(showModal = false){
  if (!showModal) {
    // Instant promotion to queen for bullet speed
    return Promise.resolve('q');
  }
  
  return new Promise(resolve=>{
    const handler=(e)=>{
      const btn=e.target.closest('[data-piece]'); if(!btn) return;
      promoteModal.removeEventListener('click',handler);
      promoteModal.style.display='none';
      resolve(btn.dataset.piece);
    };
    promoteModal.style.display='flex';
    promoteModal.addEventListener('click',handler);
  });
}

async function onSquareClick(e){
  // Prevent double-tap zoom on mobile
  e.preventDefault();
  
  const sq=e.currentTarget.dataset.square;
  const piece=game.get(sq);
  console.log('[onSquareClick] Clicked square:', sq, 'piece:', piece, 'matchStarted:', matchStarted, 'selected:', selected, 'playersTurn:', !isEngineTurn());
  if(!matchStarted) return;
  
  // If this click is from a tap that just selected this piece, ignore it
  if (customDrag.justTapped && selected === sq) {
    console.log('[onSquareClick] Ignoring click after tap');
    customDrag.justTapped = false;
    return;
  }
  customDrag.justTapped = false;
  
  const playersTurn = !isEngineTurn();

  if(!playersTurn){
    const piece=game.get(sq);
    if(!selected){
      if(piece && piece.color===humanPlays){ 
        selected=sq; 
        showLegalFrom(sq,true);
      }
      return;
    }
    if(selected===sq){ selected=null; clearHighlights(); return; }
    const moves=getLegal(selected,true);
    const cands=moves.filter(m=>m.to===sq);
    if(!cands.length){ 
      // Play illegal move sound since the attempted move was invalid
      sounds.illegalMove.currentTime = 0;
      sounds.illegalMove.play().catch(() => {});
      
      const p=game.get(sq); 
      if(p && p.color===humanPlays){ 
        // Clicked on another piece of yours - switch selection
        selected=sq; 
        showLegalFrom(sq,true);
      } else { 
        // Clicked on empty square or opponent piece
        selected=null;  
        clearLegalGlows(); 
      } 
      return; 
    }
    let promo='q'; // Auto-promote to queen for bullet speed
    // No modal - instant execution for speed
    setPremove(selected, sq, promo); 
    selected=null; 
    return;
  }

  if(!selected){
    const piece=game.get(sq);
    if(piece && piece.color===game.turn()){ 
      selected=sq; 
      showLegalFrom(sq,false);
    }
    return;
  }
  if(selected===sq){ selected=null; clearHighlights(); return; }

  const legal=game.moves({square:selected, verbose:true});
  const cands=legal.filter(m=>m.to===sq);
  if(!cands.length){ 
    // Play illegal move sound since the attempted move was invalid
    sounds.illegalMove.currentTime = 0;
    sounds.illegalMove.play().catch(() => {});
    
    const p=game.get(sq); 
    if(p && p.color===game.turn()){ 
      // Clicked on another piece of yours - switch selection
      selected=sq; 
      showLegalFrom(sq,false);
    } else { 
      // Clicked on empty square or opponent piece
      selected=null; 
      clearHighlights(); 
    } 
    return; 
  }

  // Auto-promote to queen for bullet speed (no blocking modal)
  let promo = cands[0].promotion ? 'q' : undefined;
  const moved=game.move({from:selected,to:sq,promotion:promo||'q'});

  if(moved){
    trackCapturedPiece(moved); // Track captured pieces
    clearLegalGlows(); // <<< ensure glow is cleared after your click-move
    lastMove={from:moved.from,to:moved.to}; selected=null; legalMovesEl.textContent='';
    applyIncrementForSide(moved.color); switchClock(); render();
    updateCapturedPiecesDisplay(); // Update display
    if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
    if(game.in_check()&&!game.in_checkmate()) sCheck();
    
    // Send move to opponent if multiplayer
    if (opponent && opponent.isHuman && window.multiplayer) {
      multiplayer.sendMove(moved);
      // Don't call endMatch() here - server will emit game_ended to both players
    } else {
      // Single player vs bot - check for game end locally
      if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
    }
    
    maybeEngineReply();
  } else { selected=null; clearHighlights(); }
}

function onDragStart(e){
  if(!matchStarted) { e.preventDefault(); return; }
  const pieceEl=e.target; const parent=pieceEl.parentElement; if(!parent?.dataset?.square){ e.preventDefault(); return; }
  const from=parent.dataset.square; const piece=game.get(from);
  if(!piece || piece.color!==humanPlays){ e.preventDefault(); return; }
  const playersTurn = !isEngineTurn();
  dragFrom=from; dragMode = playersTurn ? 'move' : 'premove';
  const moves= getLegal(from, dragMode==='premove');
  dragTargets=new Set(moves.map(m=>m.to));
  showLegalFrom(from, dragMode==='premove');
  
  // Center the drag image on cursor
  try {
    const rect = pieceEl.getBoundingClientRect();
    const offsetX = rect.width / 2;
    const offsetY = rect.height / 2;
    e.dataTransfer.setDragImage(pieceEl, offsetX, offsetY);
    e.dataTransfer.setData('text/plain', JSON.stringify({from, mode:dragMode}));
  } catch(_) {}
  
  // Hide the original piece immediately after setDragImage
  requestAnimationFrame(() => {
    pieceEl.style.opacity = '0';
    pieceEl.classList.add('dragging');
  });
}
function onDragOver(e){
  if(!dragFrom) return;
  const to=e.currentTarget.dataset.square;
  if(dragTargets.has(to)) e.preventDefault();
}
async function onDrop(e){
  e.preventDefault();
  const to=e.currentTarget.dataset.square;
  let dataStr=''; try{ dataStr = e.dataTransfer.getData('text/plain'); }catch(_){}
  let data; try{ data=JSON.parse(dataStr||'{}'); }catch(_){ data={}; }
  const from=data.from || dragFrom; const mode=data.mode || dragMode;
  dragFrom=null; dragTargets.clear(); 
  [...boardEl.querySelectorAll('.dragging')].forEach(el=>{
    el.classList.remove('dragging');
    el.style.opacity = ''; // Clear inline opacity
  });

  if(!from){ clearHighlights(); render(); return; }

  if(mode==='premove'){
    const moves=getLegal(from,true); const cands=moves.filter(m=>m.to===to);
    if(cands.length){
      let promo='q'; if(cands.some(m=>m.promotion)){ promo=await choosePromotion(); }
      setPremove(from,to,promo); selected=null;
    } else {
      sounds.illegalMove.currentTime = 0;
      sounds.illegalMove.play().catch(() => {});
    }
    clearHighlights(); render(); return;
  }

  const legal=game.moves({square:from, verbose:true});
  const cands=legal.filter(m=>m.to===to);
  if(!cands.length){ 
    sounds.illegalMove.currentTime = 0;
    sounds.illegalMove.play().catch(() => {});
    clearHighlights(); 
    render(); 
    return; 
  }
  let promo=cands[0].promotion || (needsPromotion(from,to) ? await choosePromotion() : undefined);
  const moved=game.move({from,to,promotion:promo||'q'});
  clearHighlights();
  if(moved){
    trackCapturedPiece(moved); // Track captured pieces
    clearLegalGlows(); // <<< ensure glow is cleared after drag-drop move
    lastMove={from:moved.from,to:moved.to}; selected=null; legalMovesEl.textContent='';
    applyIncrementForSide(moved.color); switchClock(); render();
    updateCapturedPiecesDisplay(); // Update display
    if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
    if(game.in_check()&&!game.in_checkmate()) sCheck();
    
    // Send move to opponent if multiplayer
    if (opponent && opponent.isHuman && window.multiplayer) {
      multiplayer.sendMove(moved);
      // Don't call endMatch() here - server will emit game_ended to both players
    } else {
      // Single player vs bot - check for game end locally
      if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
    }
    
    maybeEngineReply();
  } else { render(); }
}

const movesBox=document.getElementById('movesBox');
function renderMoves(){
  if(!matchStarted){ movesBox.style.display='none'; return; }
  const hist=game.history({verbose:true}); let html='<table><tbody>';
  for(let i=0;i<hist.length;i+=2){ const n=Math.floor(i/2)+1, w=hist[i]?hist[i].san:'', b=hist[i+1]?hist[i+1].san:''; html+=`<tr><td class="ply-num">${n}.</td><td>${w}</td><td>${b}</td></tr>`; }
  html+='</tbody></table>'; movesBox.innerHTML=html; movesBox.scrollTop=movesBox.scrollHeight; movesBox.style.display='block';
}

/* ===== Clocks (1+1) ===== */
const wClockEl=document.getElementById('wClock'), bClockEl=document.getElementById('bClock');
const wTimeEl=document.getElementById('wTime'), bTimeEl=document.getElementById('bTime');
let wMillis=60000,bMillis=60000,active=null,ticker=null,running=false;
let lastTickTime = 0; // For drift correction

function timeFmt(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const m = Math.floor(s/60), r=s%60, cs=Math.floor((ms%1000)/10);
  // Show tenths in final second for bullet precision
  return (ms>=1000) ? `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}` : `0.${String(Math.floor(ms/100)).padStart(1,'0')}`;
}

function updateClockUI(){ 
  wTimeEl.textContent=timeFmt(wMillis); 
  bTimeEl.textContent=timeFmt(bMillis); 
  wClockEl.classList.toggle('active',active==='w'); 
  bClockEl.classList.toggle('active',active==='b'); 
  
  // Critical time warnings (color shifts)
  wClockEl.classList.toggle('critical', wMillis < 10000 && wMillis > 0);
  bClockEl.classList.toggle('critical', bMillis < 10000 && bMillis > 0);
  wClockEl.classList.toggle('danger', wMillis < 5000 && wMillis > 0);
  bClockEl.classList.toggle('danger', bMillis < 5000 && bMillis > 0);
}

// Track last played tick sound to prevent duplicates
let lastTickSecond = -1;

function tick(){ 
  const now = performance.now();
  const delta = lastTickTime ? Math.min(200, now - lastTickTime) : 100; // Cap delta at 200ms to prevent jumps
  lastTickTime = now;
  
  if(active==='w'){ 
    const prevSecond = Math.ceil(wMillis / 1000); // Second before tick
    wMillis -= delta; 
    if(wMillis<=0){wMillis=0;flag('w');} 
    
    // Play tick sound in last 5 seconds (once per second when crossing into new second)
    const currentSecond = Math.ceil(wMillis / 1000);
    if(wMillis > 0 && currentSecond <= 5 && currentSecond !== prevSecond && currentSecond !== lastTickSecond) {
      lastTickSecond = currentSecond;
      playTickSound(currentSecond);
    }
  } else if(active==='b'){ 
    const prevSecond = Math.ceil(bMillis / 1000); // Second before tick
    bMillis -= delta; 
    if(bMillis<=0){bMillis=0;flag('b');} 
    
    // Play tick sound in last 5 seconds (once per second when crossing into new second)
    const currentSecond = Math.ceil(bMillis / 1000);
    if(bMillis > 0 && currentSecond <= 5 && currentSecond !== prevSecond && currentSecond !== lastTickSecond) {
      lastTickSecond = currentSecond;
      playTickSound(currentSecond);
    }
  } 
  updateClockUI(); 
}

function playTickSound(secondsRemaining) {
  try {
    const tickAudio = new Audio('NEW SOUNDS/Countdown2.wav');
    tickAudio.volume = 0.3; // Quieter than normal sounds
    tickAudio.play().catch(() => {}); // Ignore errors
  } catch(e) {}
}

function startClock(){ 
  if(running) return; 
  running=true; 
  lastTickTime = performance.now(); // Initialize drift-free timing
  ticker=setInterval(tick,100); 
  updateClockUI(); 
}

function stopClock(){ 
  running=false; 
  if(ticker){clearInterval(ticker); ticker=null;} 
  lastTickTime = 0;
  lastTickSecond = -1; // Reset tick sound tracker
  updateClockUI(); 
}

function switchClock(){ 
  if(!running) return; 
  active=(active==='w')?'b':'w'; 
  lastTickTime = performance.now(); // Reset drift on clock switch
  lastTickSecond = -1; // Reset tick sound tracker when switching sides
  updateClockUI(); 
}
function applyIncrementForSide(color){
  const inc=1000; if(color==='w') wMillis+=inc; else bMillis+=inc; updateClockUI();
}
function flag(side){ stopClock(); (side==='w'?wClockEl:bClockEl).classList.add('flag'); statusMsg.textContent=(side==='w')?'White flagged — Black wins on time':'Black flagged — White wins on time'; sFlag(); endMatch(true); }

// Update player headers to show correct player in correct position based on color
function updatePlayerHeaders() {
  const topHeader = document.querySelector('.player-header.top');
  const bottomHeader = document.querySelector('.player-header.bottom');
  
  // Get player info containers
  const topPlayerInfo = topHeader.querySelector('.player-info strong');
  const bottomPlayerInfo = bottomHeader.querySelector('.player-info strong');
  
  // Store references to the original parent positions
  const topClockParent = topHeader;
  const bottomClockParent = bottomHeader;
  
  // Remove existing clocks from headers
  const existingTopClock = topHeader.querySelector('.clock');
  const existingBottomClock = bottomHeader.querySelector('.clock');
  if (existingTopClock) existingTopClock.remove();
  if (existingBottomClock) existingBottomClock.remove();
  
  if (humanPlays === 'w') {
    // User plays white (bottom), opponent plays black (top)
    topPlayerInfo.textContent = opponent.name;
    bottomPlayerInfo.textContent = displayName || 'Guest ' + Math.floor(1000 + Math.random() * 9000);
    
    // Append black clock to top, white clock to bottom
    topHeader.appendChild(bClockEl);
    bottomHeader.appendChild(wClockEl);
  } else {
    // User plays black (bottom), opponent plays white (top)
    topPlayerInfo.textContent = opponent.name;
    bottomPlayerInfo.textContent = displayName || 'Guest ' + Math.floor(1000 + Math.random() * 9000);
    
    // Append white clock to top, black clock to bottom
    topHeader.appendChild(wClockEl);
    bottomHeader.appendChild(bClockEl);
  }
}

/* ===== Matchmaking & bets ===== */
const betButtons=[...document.querySelectorAll('.bet-btn')], duelBtn=document.getElementById('duelBtn');
const mm=document.getElementById('matchmaking'), mmAmount=document.getElementById('mmAmount');
const oppBox=document.getElementById('opponentBox'), oppAvatar=document.getElementById('oppAvatar'), oppNameEl=document.getElementById('oppNameTop'), oppRatingEl=document.getElementById('oppRatingTop');
const actionRow=document.getElementById('actionRow');

let selectedBetCents=0,humanPlays='w',currentSkill=8,matchStarted=false,stake=0,opponent=null,potCents=0,hideOppRating=false;
let rig = null; // ensure declared before first assignment

// Streak tracking for ELO adjustments
let winStreak = 0;
let lossStreak = 0;
let streakBaseElo = null; // Store the ELO when streak reaches 2
let streakBetAmount = null; // Track the bet amount for the current streak

/* ===== Captured Pieces Tracking ===== */
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
let capturedPieces = { white: [], black: [] }; // pieces captured BY each side

function resetCapturedPieces() {
  capturedPieces = { white: [], black: [] };
  updateCapturedPiecesDisplay();
}

function trackCapturedPiece(move) {
  if (!move.captured) return;
  
  // The piece that was captured belongs to the opposite color
  // move.color is the one who made the move (and captured)
  const capturedBy = move.color; // 'w' or 'b'
  const capturedPieceType = move.captured; // 'p', 'n', 'b', etc.
  
  if (capturedBy === 'w') {
    capturedPieces.white.push(capturedPieceType);
  } else {
    capturedPieces.black.push(capturedPieceType);
  }
}

function calculateMaterialAdvantage() {
  let whiteTotal = capturedPieces.white.reduce((sum, p) => sum + PIECE_VALUES[p], 0);
  let blackTotal = capturedPieces.black.reduce((sum, p) => sum + PIECE_VALUES[p], 0);
  
  return {
    white: whiteTotal - blackTotal, // positive if white is ahead
    black: blackTotal - whiteTotal  // positive if black is ahead
  };
}

function updateCapturedPiecesDisplay() {
  const capturedByPlayerDiv = document.getElementById('capturedByPlayerDisplay'); // TOP - opponent's header
  const capturedByOpponentDiv = document.getElementById('capturedByOpponentDisplay'); // BOTTOM - player's header
  const playerAdvantageSpan = document.getElementById('playerMaterialAdvantage'); // TOP
  const opponentAdvantageSpan = document.getElementById('opponentMaterialAdvantage'); // BOTTOM
  
  if (!capturedByPlayerDiv || !capturedByOpponentDiv) return;
  
  const advantage = calculateMaterialAdvantage();
  
  // Determine which side is the player
  const playerColor = humanPlays; // 'w' or 'b'
  const opponentColor = playerColor === 'w' ? 'b' : 'w';
  
  // What each player captured
  const playerCaptured = playerColor === 'w' ? capturedPieces.white : capturedPieces.black;
  const opponentCaptured = opponentColor === 'w' ? capturedPieces.white : capturedPieces.black;
  
  // Sort captured pieces by value (display higher value pieces first)
  const sortByValue = (a, b) => PIECE_VALUES[b] - PIECE_VALUES[a];
  playerCaptured.sort(sortByValue);
  opponentCaptured.sort(sortByValue);
  
  // BOTTOM (player's header) - show what PLAYER captured (opponent's pieces)
  capturedByOpponentDiv.innerHTML = playerCaptured.map(piece => {
    const pieceCode = opponentColor + piece.toUpperCase(); // e.g., 'bP' if player captured black pawn
    return `<div class="captured-piece" style="background-image: url('${THEME.piecePath(pieceCode)}')"></div>`;
  }).join('');
  
  // TOP (opponent's header) - show what OPPONENT captured (player's pieces)
  capturedByPlayerDiv.innerHTML = opponentCaptured.map(piece => {
    const pieceCode = playerColor + piece.toUpperCase(); // e.g., 'wP' if opponent captured white pawn
    return `<div class="captured-piece" style="background-image: url('${THEME.piecePath(pieceCode)}')"></div>`;
  }).join('');
  
  // Display material advantage - only show on the side with advantage
  const playerAdv = playerColor === 'w' ? advantage.white : advantage.black;
  const opponentAdv = opponentColor === 'w' ? advantage.white : advantage.black;
  
  // Only one side should show advantage (the one that's ahead)
  if (playerAdv > 0) {
    opponentAdvantageSpan.textContent = `+${playerAdv}`; // Show on PLAYER's header (bottom)
    playerAdvantageSpan.textContent = ''; // Clear opponent's header (top)
  } else if (opponentAdv > 0) {
    playerAdvantageSpan.textContent = `+${opponentAdv}`; // Show on OPPONENT's header (top)
    opponentAdvantageSpan.textContent = ''; // Clear player's header (bottom)
  } else {
    // Equal material
    playerAdvantageSpan.textContent = '';
    opponentAdvantageSpan.textContent = '';
  }
}

// === Bot "User 000001 ... 300000" generator ===
const TOTAL_BOTS = 300000;
const usedBotIds = new Set();

function pad6(n){ return String(n).padStart(6,'0'); }

function pickBotIdUnique(){
  // Try up to 400 random picks to find an unused ID, then reset the set.
  for (let t=0; t<400; t++){
    const id = 1 + Math.floor(Math.random() * TOTAL_BOTS);
    if (!usedBotIds.has(id)){ usedBotIds.add(id); return id; }
  }
  usedBotIds.clear();
  const id = 1 + Math.floor(Math.random() * TOTAL_BOTS);
  usedBotIds.add(id);
  return id;
}

function seedAvatar(el, seedStr){
  // keep your nice gradient avatar — seed by numeric id
  const h = [...seedStr].reduce((a,c)=>a+c.charCodeAt(0),0);
  const c1 = `hsl(${h%360} 70% 35%)`;
  const c2 = `hsl(${(h*7)%360} 70% 55%)`;
  el.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  // show last two digits as "initials" for a subtle ID hint
  el.textContent = (seedStr.slice(-2)).toUpperCase();
}

/* ===== Random ELO System ===== */
function generateRandomElo() {
  // Generate random ELO between 100 and 3000
  return Math.floor(Math.random() * (3000 - 100 + 1)) + 100;
}

function getStockfishSkillForElo(elo) {
  // Map ELO to Stockfish skill level (0-20)
  // REALISTIC MAPPING: Stockfish skill levels already simulate human mistakes
  // We just need to map them correctly to ELO ranges
  
  // ELO 100-600: skill 0-5 (beginner - hangs pieces, poor tactics)
  // ELO 600-1200: skill 5-10 (intermediate - basic tactics, some mistakes)
  // ELO 1200-1800: skill 10-15 (advanced - good tactics, occasional blunders)
  // ELO 1800-2400: skill 15-19 (strong - solid play, rare mistakes)
  // ELO 2400+: skill 20 (expert - near perfect play)
  
  if (elo <= 600) {
    return Math.floor((elo - 100) / 100); // 0-5
  } else if (elo <= 1200) {
    return Math.floor(5 + (elo - 600) / 120); // 5-10
  } else if (elo <= 1800) {
    return Math.floor(10 + (elo - 1200) / 120); // 10-15
  } else if (elo <= 2400) {
    return Math.floor(15 + (elo - 1800) / 150); // 15-19
  } else {
    return 20; // Maximum skill for 2400+
  }
}

function getThinkingTimeForElo(elo) {
  // Comprehensive human-like timing algorithm with LINEAR INTERPOLATION
  // Smooth progression every 50 ELO points
  
  const moveCount = game.history().length;
  const phase = moveCount < 10 ? 'opening' : moveCount < 30 ? 'middlegame' : 'endgame';
  const legalMoves = game.moves().length;
  const lastMove = game.history({ verbose: true }).slice(-1)[0];
  
  // 1. BASE TIME with LINEAR INTERPOLATION (smooth every 50 ELO)
  let baseMin, baseMax;
  
  // Linear interpolation function
  const lerp = (start, end, t) => start + (end - start) * t;
  
  // Define key ELO breakpoints with their time ranges
  // INVERTED TIMING FOR GAMBLING: Low ELO = impulsive/fast, High ELO = methodical/slower
  // This creates engaging, dynamic gameplay where weak bots play quickly (like blitz hustlers)
  // and strong opponents take time to calculate (building tension)
  const timeRanges = {
    100:  { opening: [300, 800],    middlegame: [400, 1000],   endgame: [500, 1200] },   // Very fast - impulsive beginners
    800:  { opening: [400, 1000],   middlegame: [600, 1400],   endgame: [700, 1600] },   // Fast - casual players
    1500: { opening: [800, 1800],   middlegame: [1000, 2200],  endgame: [1200, 2500] },  // Moderate - thinking players
    2200: { opening: [1200, 2500],  middlegame: [1500, 3000],  endgame: [1800, 3500] },  // Slower - calculating masters
    3000: { opening: [1500, 3000],  middlegame: [2000, 3500],  endgame: [2200, 4000] }   // Slowest - deep calculation
  };
  
  // Find which range we're in and interpolate
  if (elo <= 800) {
    const t = (elo - 100) / 700; // 0 to 1
    baseMin = lerp(timeRanges[100][phase][0], timeRanges[800][phase][0], t);
    baseMax = lerp(timeRanges[100][phase][1], timeRanges[800][phase][1], t);
  } else if (elo <= 1500) {
    const t = (elo - 800) / 700; // 0 to 1
    baseMin = lerp(timeRanges[800][phase][0], timeRanges[1500][phase][0], t);
    baseMax = lerp(timeRanges[800][phase][1], timeRanges[1500][phase][1], t);
  } else if (elo <= 2200) {
    const t = (elo - 1500) / 700; // 0 to 1
    baseMin = lerp(timeRanges[1500][phase][0], timeRanges[2200][phase][0], t);
    baseMax = lerp(timeRanges[1500][phase][1], timeRanges[2200][phase][1], t);
  } else {
    const t = Math.min(1, (elo - 2200) / 800); // 0 to 1, capped
    baseMin = lerp(timeRanges[2200][phase][0], timeRanges[3000][phase][0], t);
    baseMax = lerp(timeRanges[2200][phase][1], timeRanges[3000][phase][1], t);
  }
  
  // 2. OPENING BOOK SIMULATION (only high ELO knows theory)
  let openingBookMultiplier = 1.0;
  if (moveCount < 5 && elo >= 2200) {
    openingBookMultiplier = 0.5; // 50% faster - masters know theory (was 0.2 - too fast)
  } else if (moveCount < 8 && elo >= 1800) {
    openingBookMultiplier = 0.6; // 40% faster - strong players know theory (was 0.35)
  } else if (moveCount < 10 && elo >= 1500) {
    openingBookMultiplier = 0.75; // 25% faster - intermediate knows some theory (was 0.6)
  }
  // Low ELO (<1500) doesn't get opening book bonus - they don't know theory!
  
  // 3. MOVE COMPLEXITY (obvious moves = faster, complex = slower)
  // High ELO recognizes simple positions and plays them quickly
  // Low ELO plays impulsively regardless of complexity
  let complexityMultiplier = 1.0;
  if (elo >= 1500) {
    // High ELO: complexity aware
    if (legalMoves <= 3) {
      // Forced or nearly forced - very quick decision
      complexityMultiplier = 0.5; // 50% faster
    } else if (legalMoves <= 8) {
      // Few options - quick calculation
      complexityMultiplier = 0.75; // 25% faster
    } else if (legalMoves >= 25) {
      // Many options - needs deep calculation
      complexityMultiplier = 1.4; // 40% slower
    }
  } else if (elo >= 800) {
    // Mid ELO: slight complexity awareness
    if (legalMoves <= 3) {
      complexityMultiplier = 0.8; // Slightly faster on forced moves
    } else if (legalMoves >= 25) {
      complexityMultiplier = 1.2; // Slightly slower on complex
    }
  }
  // Low ELO (<800): complexityMultiplier stays 1.0 - plays impulsively regardless!
  
  // 4. PIECE-SPECIFIC PATTERNS
  // High ELO has refined pattern recognition
  // Low ELO plays impulsively with all pieces
  let pieceMultiplier = 1.0;
  if (elo >= 1800 && lastMove) {
    // Only strong players have sophisticated piece patterns
    const piece = lastMove.piece;
    if (piece === 'p' && phase === 'opening') {
      pieceMultiplier = 0.6; // Pawn moves in opening are fast (theory)
    } else if ((piece === 'q' || piece === 'r') && phase === 'middlegame') {
      pieceMultiplier = 1.2; // Heavy pieces require calculation
    } else if (lastMove.captured) {
      // Response to captures - strong players recalculate quickly
      pieceMultiplier = 0.9;
    }
  } else if (elo >= 1200 && lastMove && lastMove.captured) {
    // Mid-level players slow down after captures (reconsider position)
    pieceMultiplier = 1.1;
  }
  // Low ELO (<1200): No pattern recognition - impulsive on all pieces
  
  // 5. SCIENTIFIC TIME MANAGEMENT SIMULATION (Based on real bullet data)
  // Determines move type: time scramble, long move, or normal
  const engineColor = game.turn();
  const engineTime = (engineColor === 'w' ? wMillis : bMillis) / 1000;
  
  // Get time management statistics for this ELO
  const timeManagement = getTimeManagementForElo(elo);
  const rand = Math.random() * 100;
  
  let timePressureMultiplier = 1.0;
  let isTimeScramble = false;
  let isLongMove = false;
  
  // Determine move type based on scientific data
  if (engineTime < 3) {
    // TIME SCRAMBLE: <3 seconds left (panic mode)
    isTimeScramble = true;
    // Time scramble moves are MUCH faster
    if (elo >= 2500) {
      timePressureMultiplier = 0.15; // Super fast, but controlled
    } else if (elo >= 2000) {
      timePressureMultiplier = 0.20; // Fast with some control
    } else if (elo >= 1500) {
      timePressureMultiplier = 0.25; // Fast but panicky
    } else if (elo >= 1000) {
      timePressureMultiplier = 0.30; // Very panicky
    } else {
      // Low ELO: completely panicked, extremely inconsistent
      timePressureMultiplier = Math.random() < 0.5 ? 0.15 : 0.35;
    }
  } else if (rand < timeManagement.longMoveChance && engineTime > 5 && moveCount > 5) {
    // LONG MOVE: Taking >5 seconds for critical thinking (only if we have time)
    isLongMove = true;
    // Long moves are 2-4x slower
    timePressureMultiplier = 2.0 + Math.random() * 2.0; // 2x to 4x normal time
  } else if (engineTime < 10) {
    // MILD TIME PRESSURE: 3-10 seconds
    if (elo >= 2500) {
      timePressureMultiplier = 0.6; // Masters stay calm
    } else if (elo >= 2000) {
      timePressureMultiplier = 0.65;
    } else if (elo >= 1500) {
      timePressureMultiplier = 0.7;
    } else if (elo >= 1000) {
      timePressureMultiplier = 0.75;
    } else {
      timePressureMultiplier = Math.random() < 0.4 ? 0.5 : 0.85; // Inconsistent
    }
  } else if (engineTime < 30) {
    // MODERATE TIME PRESSURE: 10-30 seconds
    if (elo >= 2200) {
      timePressureMultiplier = 0.8; // Masters manage well
    } else if (elo >= 1500) {
      timePressureMultiplier = 0.85;
    } else {
      timePressureMultiplier = 0.9;
    }
  } else if (engineTime < 60) {
    // LIGHT TIME PRESSURE: 30-60 seconds
    timePressureMultiplier = elo >= 1500 ? 0.9 : 0.95;
  }
  // else: No time pressure (>60 seconds), multiplier stays 1.0
  
  // Store time scramble flag for move quality adjustment later
  window.__isTimeScramble = isTimeScramble;
  window.__isLongMove = isLongMove;
  window.__timeManagement = timeManagement;
  
  // 6. CRITICAL MOMENT THINKING (rare deep calculation)
  const criticalMoment = Math.random() < 0.04 ? 1.5 : 1.0; // 4% chance, 1.5x longer (was 6% / 1.8x - too frequent/extreme)
  
  // 7. NATURAL HUMAN VARIATION (realistic rhythm with ELO-based consistency)
  // High ELO: NARROW variation for consistent rhythm
  // Low ELO: WIDER variation for erratic play
  const humanVariation = elo >= 2200 ? 
    (0.75 + Math.random() * 0.4) :  // 75-115% - VERY consistent for masters (was 50-130%)
    elo >= 1500 ?
    (0.65 + Math.random() * 0.6) :  // 65-125% - moderate consistency (was 50-130%)
    elo >= 1000 ?
    (0.7 + Math.random() * 0.5) :   // 70-120% - some consistency (was 80-130%)
    (0.8 + Math.random() * 0.5);    // 80-130% - low ELO still erratic
  
  // CALCULATE FINAL TIME with all multipliers
  let time = Math.floor(
    (baseMin + Math.random() * (baseMax - baseMin)) *
    openingBookMultiplier *
    complexityMultiplier *
    pieceMultiplier *
    timePressureMultiplier *
    criticalMoment *
    humanVariation
  );
  
  // Ensure minimum realistic times (LOW ELO = HIGHER MINIMUMS)
  // UPDATED FOR BETTING CONTEXT: Faster floors to match new base ranges
  const absoluteMin = (elo >= 2500 && moveCount < 5) ? 150 :  // Masters quick in opening (was 250ms)
                      (elo >= 2200) ? 200 :  // High ELO minimum for fast play (was 350ms)
                      (elo >= 1500) ? 600 :  // Reduced from 800ms to 600ms
                      (elo >= 1200) ? 800 :  // Reduced from 1200ms to 800ms
                      (elo >= 800) ? 1000 :  // Reduced from 1500ms to 1000ms
                      (elo >= 400) ? 1200 : 1500; // <400 ELO: minimum 1.5s (was 3s), 400-800: 1.2s (was 2.5s)
  time = Math.max(time, absoluteMin);
  
  // Prevent unrealistically long times (also reduced for betting context)
  const absoluteMax = elo >= 2200 ? 1200 : elo >= 1500 ? 4500 : elo >= 800 ? 6000 : 8000; // Masters capped at 1.2s for fast games (was 2.2s)
  time = Math.min(time, absoluteMax);
  
  return time;
}

function getSearchDepthForElo(elo) {
  // Map ELO to Stockfish search depth
  // For ELO < 1350: Use limited depth (Stockfish UCI_Elo doesn't go below 1350)
  // For ELO >= 1350: Use UCI_Elo parameter with reasonable depth
  
  if (elo <= 200) {
    return 1; // Depth 1: completely random, hangs pieces constantly
  } else if (elo <= 400) {
    return 2; // Depth 2: very weak, no tactics
  } else if (elo <= 600) {
    return 3; // Depth 3: beginner level
  } else if (elo <= 800) {
    return 4; // Depth 4: novice
  } else if (elo <= 1000) {
    return 5; // Depth 5: beginner+
  } else if (elo <= 1200) {
    return 6; // Depth 6: intermediate low
  } else if (elo <= 1350) {
    return 8; // Depth 8: transition to UCI_Elo
  } else {
    // For 1350+ ELO, use deeper depth (UCI_Elo will control strength)
    return 15; // Let UCI_Elo control the errors, not depth
  }
}

function getUciEloForRating(elo) {
  // Stockfish UCI_Elo range: 1350-2850
  // For lower ELO, we use depth control instead
  if (elo < 1350) {
    return null; // Don't use UCI_Elo for low ratings
  }
  // Clamp to Stockfish's supported range
  return Math.min(2850, Math.max(1350, Math.round(elo)));
}

/**
 * Get time management statistics for ELO (scientific data from bullet chess)
 * Returns percentages for different move types based on ELO
 */
function getTimeManagementForElo(elo) {
  // Linear interpolation helper
  const lerp = (v1, v2, t) => v1 + (v2 - v1) * t;
  
  // Data from scientific bullet chess analysis
  const dataPoints = [
    // ELO: [timeScramble%, tsBlunder%, tsMistake%, tsInaccuracy%, longMove%, badLongMove%, normalMove%]
    { elo: 150,  data: [19.65, 3.93, 2.95, 1.97, 4.96, 2.95, 72.45] },
    { elo: 250,  data: [18.94, 3.78, 2.84, 1.91, 4.88, 2.84, 73.34] },
    { elo: 350,  data: [18.23, 3.64, 2.74, 1.84, 4.79, 2.74, 74.24] },
    { elo: 450,  data: [17.52, 3.49, 2.64, 1.78, 4.71, 2.64, 75.14] },
    { elo: 550,  data: [16.81, 3.34, 2.53, 1.72, 4.62, 2.53, 76.03] },
    { elo: 650,  data: [16.10, 3.20, 2.43, 1.66, 4.54, 2.43, 76.93] },
    { elo: 750,  data: [15.40, 3.05, 2.32, 1.59, 4.46, 2.32, 77.82] },
    { elo: 850,  data: [14.69, 2.91, 2.22, 1.53, 4.38, 2.22, 78.72] },
    { elo: 950,  data: [13.98, 2.76, 2.11, 1.47, 4.29, 2.11, 79.61] },
    { elo: 1050, data: [13.27, 2.61, 2.01, 1.41, 4.21, 2.01, 80.51] },
    { elo: 1150, data: [12.56, 2.47, 1.91, 1.34, 4.12, 1.91, 81.41] },
    { elo: 1250, data: [11.85, 2.32, 1.80, 1.28, 4.04, 1.80, 82.30] },
    { elo: 1350, data: [11.15, 2.18, 1.70, 1.22, 3.96, 1.70, 83.20] },
    { elo: 1450, data: [10.44, 2.03, 1.59, 1.16, 3.88, 1.59, 84.09] },
    { elo: 1550, data: [9.73,  1.89, 1.49, 1.09, 3.79, 1.49, 84.99] },
    { elo: 1650, data: [9.02,  1.74, 1.39, 1.03, 3.71, 1.39, 85.89] },
    { elo: 1750, data: [8.31,  1.59, 1.28, 0.97, 3.62, 1.28, 86.78] },
    { elo: 1850, data: [7.60,  1.45, 1.18, 0.91, 3.54, 1.18, 87.68] },
    { elo: 1950, data: [6.90,  1.30, 1.07, 0.84, 3.46, 1.07, 88.57] },
    { elo: 2050, data: [6.19,  1.16, 0.97, 0.78, 3.38, 0.97, 89.47] },
    { elo: 2150, data: [5.48,  1.01, 0.86, 0.72, 3.29, 0.86, 90.36] },
    { elo: 2250, data: [4.77,  0.86, 0.76, 0.66, 3.21, 0.76, 91.26] },
    { elo: 2350, data: [4.06,  0.72, 0.66, 0.59, 3.12, 0.66, 92.16] },
    { elo: 2450, data: [3.35,  0.57, 0.55, 0.53, 3.04, 0.55, 93.05] },
    { elo: 2600, data: [1.23,  0.14, 0.24, 0.34, 2.79, 0.24, 95.74] },
  ];
  
  // Find surrounding data points
  let lowerPoint = dataPoints[0];
  let upperPoint = dataPoints[dataPoints.length - 1];
  
  for (let i = 0; i < dataPoints.length - 1; i++) {
    if (elo >= dataPoints[i].elo && elo <= dataPoints[i + 1].elo) {
      lowerPoint = dataPoints[i];
      upperPoint = dataPoints[i + 1];
      break;
    }
  }
  
  // Clamp to bounds
  if (elo < dataPoints[0].elo) {
    lowerPoint = upperPoint = dataPoints[0];
  } else if (elo > dataPoints[dataPoints.length - 1].elo) {
    lowerPoint = upperPoint = dataPoints[dataPoints.length - 1];
  }
  
  // Interpolate
  const t = lowerPoint.elo === upperPoint.elo ? 0 : 
            (elo - lowerPoint.elo) / (upperPoint.elo - lowerPoint.elo);
  
  return {
    timeScrambleRate: lerp(lowerPoint.data[0], upperPoint.data[0], t),
    tsBlunderRate: lerp(lowerPoint.data[1], upperPoint.data[1], t),
    tsMistakeRate: lerp(lowerPoint.data[2], upperPoint.data[2], t),
    tsInaccuracyRate: lerp(lowerPoint.data[3], upperPoint.data[3], t),
    longMoveChance: lerp(lowerPoint.data[4], upperPoint.data[4], t),
    badLongMoveRate: lerp(lowerPoint.data[5], upperPoint.data[5], t),
    normalMoveRate: lerp(lowerPoint.data[6], upperPoint.data[6], t)
  };
}

/**
 * Get random move quality based on ELO using SCIENTIFIC DATA from 1+1 bullet chess analysis
 * Source: notjoemartinez.com - Real bullet chess move quality distributions
 * Returns: 'best', 'excellent', 'good', 'okay', 'inaccuracy', 'mistake', 'blunder'
 * 
 * Mapping:
 * - 'best' = brilliant + critical + best moves (top-tier play)
 * - 'excellent' = excellent moves (strong accurate moves)
 * - 'good' = theory moves (known opening lines)
 * - 'okay' = okay moves (decent but not optimal)
 * - 'inaccuracy' = inaccuracies (small errors, -100 to -200cp)
 * - 'mistake' = mistakes (significant errors, -200 to -300cp)
 * - 'blunder' = blunders (game-changing errors, -300cp+)
 */
function getRandomMoveQuality(elo) {
  // Check if we're in a time scramble (set by getThinkingTimeForElo)
  const isTimeScramble = window.__isTimeScramble || false;
  const isLongMove = window.__isLongMove || false;
  const timeManagement = window.__timeManagement || getTimeManagementForElo(elo);
  
  // TIME SCRAMBLE OVERRIDE: Use special time scramble distributions
  if (isTimeScramble) {
    const tsRand = Math.random() * 100;
    const tsTotal = timeManagement.tsBlunderRate + timeManagement.tsMistakeRate + timeManagement.tsInaccuracyRate;
    
    // In time scrambles, most moves are errors
    if (tsRand < timeManagement.tsBlunderRate) {
      return 'blunder'; // Time scramble blunders
    }
    if (tsRand < timeManagement.tsBlunderRate + timeManagement.tsMistakeRate) {
      return 'mistake'; // Time scramble mistakes
    }
    if (tsRand < tsTotal) {
      return 'inaccuracy'; // Time scramble inaccuracies
    }
    // Rest are panic "okay" moves (fast but not terrible)
    return Math.random() < 0.7 ? 'okay' : 'good';
  }
  
  // LONG MOVE: Slightly better quality (more time = more calculation)
  // But not guaranteed - can still make bad long moves
  if (isLongMove) {
    const badLongMoveChance = (timeManagement.badLongMoveRate / timeManagement.longMoveChance) * 100;
    if (Math.random() * 100 < badLongMoveChance) {
      // Bad long move - still made a mistake despite thinking
      return Math.random() < 0.5 ? 'mistake' : 'inaccuracy';
    }
    // Good long move - boost quality slightly
    // Continue to normal distribution but with +10% to best/excellent
  }
  
  const rand = Math.random() * 100;
  
  // Linear interpolation helper
  const lerp = (v1, v2, t) => v1 + (v2 - v1) * t;
  
  // Find the appropriate range and interpolate
  // Data points from the scientific table (every 100 ELO)
  const dataPoints = [
    // ELO: [best(brilliant+critical+best), excellent, good(theory), okay, inaccuracy, mistake, blunder]
    { elo: 150,  dist: [3.59, 9.68, 15.9, 35.07, 14.14, 9.43, 12.19] },  // 100-200 avg
    { elo: 250,  dist: [4.03, 9.77, 16.5, 34.57, 13.97, 9.31, 11.86] },  // 200-300 avg
    { elo: 350,  dist: [4.46, 9.86, 17.1, 34.07, 13.79, 9.20, 11.52] },  // 300-400 avg
    { elo: 450,  dist: [4.89, 9.95, 17.7, 33.57, 13.62, 9.08, 11.18] },  // 400-500 avg
    { elo: 550,  dist: [5.32, 10.04, 18.3, 33.08, 13.45, 8.96, 10.85] }, // 500-600 avg
    { elo: 650,  dist: [5.75, 10.13, 18.9, 32.58, 13.27, 8.85, 10.51] }, // 600-700 avg
    { elo: 750,  dist: [6.18, 10.22, 19.5, 32.09, 13.10, 8.73, 10.17] }, // 700-800 avg
    { elo: 850,  dist: [6.62, 10.31, 20.1, 31.60, 12.93, 8.62, 9.84] },  // 800-900 avg
    { elo: 950,  dist: [7.04, 10.40, 20.7, 31.10, 12.75, 8.50, 9.50] },  // 900-1000 avg
    { elo: 1050, dist: [7.48, 10.49, 21.3, 30.61, 12.58, 8.39, 9.16] },  // 1000-1100 avg
    { elo: 1150, dist: [7.90, 10.58, 21.9, 30.12, 12.41, 8.27, 8.82] },  // 1100-1200 avg
    { elo: 1250, dist: [8.34, 10.66, 22.5, 29.62, 12.23, 8.16, 8.49] },  // 1200-1300 avg
    { elo: 1350, dist: [8.76, 10.75, 23.1, 29.13, 12.06, 8.04, 8.15] },  // 1300-1400 avg
    { elo: 1450, dist: [9.19, 10.84, 23.7, 28.64, 11.89, 7.92, 7.81] },  // 1400-1500 avg
    { elo: 1550, dist: [9.62, 10.93, 24.3, 28.15, 11.71, 7.81, 7.48] },  // 1500-1600 avg
    { elo: 1650, dist: [10.05, 11.02, 24.9, 27.66, 11.54, 7.69, 7.14] }, // 1600-1700 avg
    { elo: 1750, dist: [10.47, 11.11, 25.5, 27.17, 11.37, 7.58, 6.80] }, // 1700-1800 avg
    { elo: 1850, dist: [10.90, 11.19, 26.1, 26.69, 11.19, 7.46, 6.47] }, // 1800-1900 avg
    { elo: 1950, dist: [11.32, 11.28, 26.7, 26.20, 11.02, 7.35, 6.13] }, // 1900-2000 avg
    { elo: 2050, dist: [11.76, 11.37, 27.3, 25.71, 10.85, 7.23, 5.79] }, // 2000-2100 avg
    { elo: 2150, dist: [12.18, 11.46, 27.9, 25.22, 10.67, 7.11, 5.45] }, // 2100-2200 avg
    { elo: 2250, dist: [12.60, 11.54, 28.5, 24.74, 10.50, 7.00, 5.12] }, // 2200-2300 avg
    { elo: 2350, dist: [13.03, 11.63, 29.1, 24.25, 10.33, 6.88, 4.78] }, // 2300-2400 avg
    { elo: 2450, dist: [13.45, 11.72, 29.7, 23.77, 10.15, 6.77, 4.44] }, // 2400-2500 avg
    { elo: 2600, dist: [14.72, 11.98, 31.5, 22.32, 9.63, 6.42, 3.43] },  // 2500+ avg
  ];
  
  // Find surrounding data points
  let lowerPoint = dataPoints[0];
  let upperPoint = dataPoints[dataPoints.length - 1];
  
  for (let i = 0; i < dataPoints.length - 1; i++) {
    if (elo >= dataPoints[i].elo && elo <= dataPoints[i + 1].elo) {
      lowerPoint = dataPoints[i];
      upperPoint = dataPoints[i + 1];
      break;
    }
  }
  
  // Clamp to bounds
  if (elo < dataPoints[0].elo) {
    lowerPoint = upperPoint = dataPoints[0];
  } else if (elo > dataPoints[dataPoints.length - 1].elo) {
    lowerPoint = upperPoint = dataPoints[dataPoints.length - 1];
  }
  
  // Interpolate between data points
  const t = lowerPoint.elo === upperPoint.elo ? 0 : 
            (elo - lowerPoint.elo) / (upperPoint.elo - lowerPoint.elo);
  
  let best = lerp(lowerPoint.dist[0], upperPoint.dist[0], t);
  let excellent = lerp(lowerPoint.dist[1], upperPoint.dist[1], t);
  const good = lerp(lowerPoint.dist[2], upperPoint.dist[2], t);
  const okay = lerp(lowerPoint.dist[3], upperPoint.dist[3], t);
  const inaccuracy = lerp(lowerPoint.dist[4], upperPoint.dist[4], t);
  const mistake = lerp(lowerPoint.dist[5], upperPoint.dist[5], t);
  const blunder = lerp(lowerPoint.dist[6], upperPoint.dist[6], t);
  
  // Long move quality boost (spent extra time, slightly better)
  if (isLongMove) {
    best *= 1.15; // 15% boost to best moves
    excellent *= 1.10; // 10% boost to excellent moves
  }
  
  // Select move quality based on cumulative probabilities
  if (rand < best) return 'best';
  if (rand < best + excellent) return 'excellent';
  if (rand < best + excellent + good) return 'good';
  if (rand < best + excellent + good + okay) return 'okay';
  if (rand < best + excellent + good + okay + inaccuracy) return 'inaccuracy';
  if (rand < best + excellent + good + okay + inaccuracy + mistake) return 'mistake';
  return 'blunder';
}

/**
 * Get evaluation error margin based on move quality
 * This simulates how poorly a player evaluates positions
 * @param {string} quality - Move quality category
 * @param {number} elo - Player ELO rating
 * @returns {number} - Error margin in centipawns
 */
function getEvaluationError(quality, elo) {
  // Base error margins for different quality levels (in centipawns)
  const errorByQuality = {
    'best': 20,       // Minimal error - nearly perfect evaluation
    'excellent': 40,  // Small error - sees position well
    'good': 80,       // Moderate error - misses some nuances
    'okay': 150,      // Larger error - misses tactics
    'inaccuracy': 250, // Significant error - poor evaluation
    'mistake': 400,   // Major error - blind to threats
    'blunder': 700    // Massive error - completely misjudges
  };
  
  const baseError = errorByQuality[quality] || 200;
  
  // Scale error by ELO: lower ELO = more error even for "good" moves
  const eloFactor = Math.max(0.5, Math.min(2.0, 1.5 - (elo / 2000)));
  
  return baseError * eloFactor;
}

/**
 * Check if a piece on a square is hanging (undefended or underdefended)
 * @param {string} square - Square in algebraic notation (e.g., 'd1')
 * @returns {boolean} - True if piece is hanging
 */
function isPieceHanging(square) {
  const piece = game.get(square);
  if (!piece) return false;
  
  // Get attackers and defenders
  const attackers = game.moves({ verbose: true, square: null }).filter(m => m.to === square);
  
  // Simple heuristic: if high-value piece has no defenders, it's hanging
  const pieceValues = { 'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9, 'k': 100 };
  const pieceValue = pieceValues[piece.type] || 0;
  
  // For queens and rooks, if there are attackers and piece is not defended by pawns, consider hanging
  if (pieceValue >= 5 && attackers.length > 0) {
    return true; // Simplified: high-value pieces under attack are "hanging"
  }
  
  return false;
}

/**
 * Select a move based on desired quality level using evaluation error simulation
 * This creates more natural-looking mistakes by simulating flawed position evaluation
 * @param {string} quality - 'best', 'excellent', 'good', 'okay', 'inaccuracy', 'mistake', 'blunder'
 * @param {Array} moves - Array of {pvNum, move, score} from MultiPV
 * @returns {string} - Selected move in UCI format (e.g., 'e2e4')
 */
function selectMoveByQuality(quality, moves) {
  if (!moves || moves.length === 0) return null;
  
  const elo = opponent ? opponent.rating : 1200;
  const allLegal = game.moves({verbose: true});
  
  // For best/excellent moves, use minimal error (nearly perfect play)
  if (quality === 'best' || quality === 'excellent') {
    const sorted = moves.slice().sort((a, b) => b.score - a.score);
    const errorMargin = quality === 'best' ? 15 : 35;
    
    // Add small random error
    const perceived = sorted.map(m => ({
      move: m.move,
      score: m.score + (Math.random() - 0.5) * 2 * errorMargin
    }));
    
    perceived.sort((a, b) => b.score - a.score);
    return perceived[0].move;
  }
  
  // For good/okay moves, use moderate error
  if (quality === 'good' || quality === 'okay') {
    const sorted = moves.slice().sort((a, b) => b.score - a.score);
    const errorMargin = quality === 'good' ? 60 : 130;
    
    const perceived = sorted.map(m => ({
      move: m.move,
      score: m.score + (Math.random() - 0.5) * 2 * errorMargin
    }));
    
    perceived.sort((a, b) => b.score - a.score);
    return perceived[0].move;
  }
  
  // For worse moves (inaccuracy, mistake, blunder), use full evaluation error system
  const errorMargin = getEvaluationError(quality, elo);
  
  // Combine MultiPV moves with ALL legal moves for errors
  const allMovesWithScores = [];
  
  // Add MultiPV moves with their scores
  moves.forEach(m => {
    allMovesWithScores.push({
      move: m.move,
      trueScore: m.score,
      source: 'multipv'
    });
  });
  
  // Add other legal moves with estimated scores (worse than worst MultiPV)
  const multiPvMoveSet = new Set(moves.map(m => m.move));
  const worstMultiPvScore = Math.min(...moves.map(m => m.score));
  
  allLegal.forEach(m => {
    const uci = m.from + m.to + (m.promotion || '');
    if (!multiPvMoveSet.has(uci)) {
      // Estimate score for non-MultiPV moves (likely bad)
      let estimatedScore = worstMultiPvScore - 200 - Math.random() * 300;
      
      // BOOST SCORE for capturing hanging pieces (even weak players see free material)
      if (m.captured) {
        const pieceValues = { 'p': 100, 'n': 300, 'b': 300, 'r': 500, 'q': 900 };
        const captureValue = pieceValues[m.captured] || 0;
        
        // Check if it's a recapture (opponent just moved there)
        const lastMove = game.history({ verbose: true }).slice(-1)[0];
        const isRecapture = lastMove && m.to === lastMove.to;
        
        // Check if capturing a hanging piece
        const isHanging = isPieceHanging(m.to);
        
        // Huge boost for hanging high-value pieces (even 400 ELO sees free queen)
        if (captureValue >= 500 && (isHanging || isRecapture)) {
          estimatedScore = worstMultiPvScore + 500; // Make it look VERY good
        } else if (captureValue >= 300) {
          estimatedScore = worstMultiPvScore + 200; // Still looks good
        } else if (m.captured) {
          estimatedScore = worstMultiPvScore - 50; // Small material gain
        }
      }
      
      allMovesWithScores.push({
        move: uci,
        trueScore: estimatedScore,
        source: 'legal'
      });
    }
  });
  
  // Apply evaluation error to create perceived scores
  const perceivedMoves = allMovesWithScores.map(m => ({
    move: m.move,
    trueScore: m.trueScore,
    perceivedScore: m.trueScore + (Math.random() - 0.5) * 2 * errorMargin,
    source: m.source
  }));
  
  // Sort by what the weak player THINKS is best
  perceivedMoves.sort((a, b) => b.perceivedScore - a.perceivedScore);
  
  // Blunders: pick from top 3 perceived moves (might be objectively terrible)
  // Mistakes: pick from top 2 perceived moves
  // Inaccuracies: pick the top perceived move
  let candidatePool;
  if (quality === 'blunder') {
    candidatePool = perceivedMoves.slice(0, Math.min(5, perceivedMoves.length));
  } else if (quality === 'mistake') {
    candidatePool = perceivedMoves.slice(0, Math.min(3, perceivedMoves.length));
  } else { // inaccuracy
    candidatePool = perceivedMoves.slice(0, Math.min(2, perceivedMoves.length));
  }
  
  // Pick randomly from candidate pool
  const selected = candidatePool[Math.floor(Math.random() * candidatePool.length)];
  
  return selected.move;
}


let engineMoveCallback = null;
let multiPvMoves = []; // Store multiple move options from engine
let waitingForMultiPv = false;

/**
 * Apply streak-based ELO adjustments to opponent
 * - After 2 consecutive wins/losses, adjust ELO by 500 per additional game
 * - On streak break, randomize opponent ELO for NEXT game
 * @param {string} outcome - 'win', 'lose', or 'draw'
 */
function applyStreakEloAdjustment(outcome) {
  if (outcome === 'draw') {
    // Draws don't affect streaks
    return;
  }

  if (outcome === 'win') {
    // Player won

    // Check if breaking a loss streak (2+ losses)
    if (lossStreak >= 2) {
      // Breaking loss streak -> next opponent will have randomized ELO
      console.log(`[STREAK] Loss streak broken (was ${lossStreak} losses) with a WIN -> Next opponent will have randomized ELO`);
      lossStreak = 0;
      winStreak = 1; // Start new win streak
      streakBaseElo = null; // Clear streak base
      streakBetAmount = null; // Clear bet amount tracking
      window.__streakBreakRandomize = true; // Flag for next game
      return;
    }

    winStreak++;
    lossStreak = 0;
    
    // Record base ELO when reaching 2 wins
    if (winStreak === 2 && opponent && !opponent.isHuman) {
      streakBaseElo = opponent.rating;
      console.log(`[STREAK] Win streak started at 2 wins -> Recording base ELO: ${streakBaseElo}`);
    }

    console.log(`[STREAK] Win streak: ${winStreak}, Loss streak: ${lossStreak}`);

  } else if (outcome === 'lose') {
    // Player lost

    // Check if breaking a win streak (2+ wins)
    if (winStreak >= 2) {
      // Breaking win streak -> next opponent will have randomized ELO
      console.log(`[STREAK] Win streak broken (was ${winStreak} wins) with a LOSS -> Next opponent will have randomized ELO`);
      winStreak = 0;
      lossStreak = 1; // Start new loss streak
      streakBaseElo = null; // Clear streak base
      streakBetAmount = null; // Clear bet amount tracking
      window.__streakBreakRandomize = true; // Flag for next game
      return;
    }

    lossStreak++;
    winStreak = 0;
    
    // Record base ELO when reaching 2 losses
    if (lossStreak === 2 && opponent && !opponent.isHuman) {
      streakBaseElo = opponent.rating;
      console.log(`[STREAK] Loss streak started at 2 losses -> Recording base ELO: ${streakBaseElo}`);
    }

    console.log(`[STREAK] Win streak: ${winStreak}, Loss streak: ${lossStreak}`);
  }
}

/**
 * Adjust current opponent's ELO based on active streak
 * Called at start of each game
 */
function adjustOpponentEloForStreak() {
  if (!opponent || opponent.isHuman) {
    return; // Don't adjust for human opponents
  }
  
  // Check if we should randomize due to streak break
  if (window.__streakBreakRandomize) {
    const newElo = generateRandomElo();
    opponent.rating = newElo;
    
    // RE-APPLY STEREOTYPE after ELO change
    if (window.OpponentStereotypes && window.OpponentStereotypes.createOpponentWithStereotype) {
      const newOpponent = window.OpponentStereotypes.createOpponentWithStereotype(newElo);
      opponent.name = newOpponent.name;
      opponent.stereotype = newOpponent.stereotype;
      opponent.description = newOpponent.description;
      opponent.avatarSeed = newOpponent.avatarSeed;
      console.log(`[STREAK] Streak break randomization -> "${opponent.name}" at ${newElo} ELO`);
    } else {
      console.log(`[STREAK] Streak break randomization -> Opponent ELO set to ${newElo}`);
    }
    
    window.__streakBreakRandomize = false;
    streakBaseElo = null; // Clear base ELO
    streakBetAmount = null; // Clear bet amount tracking
    return;
  }
  
  // Apply streak adjustments using the recorded base ELO
  if (winStreak >= 2 && streakBaseElo !== null) {
    // Player on win streak -> make opponent STRONGER (+500 per game, starting from 3rd game)
    const adjustment = (winStreak - 1) * 500; // winStreak=2 -> +500, winStreak=3 -> +1000, 4 -> +1500, etc.
    opponent.rating = streakBaseElo + adjustment;
    
    // RE-APPLY STEREOTYPE after ELO change
    if (window.OpponentStereotypes && window.OpponentStereotypes.createOpponentWithStereotype) {
      const newOpponent = window.OpponentStereotypes.createOpponentWithStereotype(opponent.rating);
      opponent.name = newOpponent.name;
      opponent.stereotype = newOpponent.stereotype;
      opponent.description = newOpponent.description;
      opponent.avatarSeed = newOpponent.avatarSeed;
      console.log(`[STREAK] Win streak ${winStreak} -> "${opponent.name}" at ${opponent.rating} ELO (base ${streakBaseElo} + ${adjustment})`);
    } else {
      console.log(`[STREAK] Win streak ${winStreak} -> Opponent ELO set to ${opponent.rating} (base ${streakBaseElo} + ${adjustment})`);
    }
  } else if (lossStreak >= 2 && streakBaseElo !== null) {
    // Player on loss streak -> make opponent WEAKER (-500 per game, starting from 3rd game)
    const adjustment = -(lossStreak - 1) * 500; // lossStreak=2 -> -500, lossStreak=3 -> -1000, 4 -> -1500, etc.
    opponent.rating = Math.max(100, streakBaseElo + adjustment); // Floor at 100 ELO
    
    // RE-APPLY STEREOTYPE after ELO change
    if (window.OpponentStereotypes && window.OpponentStereotypes.createOpponentWithStereotype) {
      const newOpponent = window.OpponentStereotypes.createOpponentWithStereotype(opponent.rating);
      opponent.name = newOpponent.name;
      opponent.stereotype = newOpponent.stereotype;
      opponent.description = newOpponent.description;
      opponent.avatarSeed = newOpponent.avatarSeed;
      console.log(`[STREAK] Loss streak ${lossStreak} -> "${opponent.name}" at ${opponent.rating} ELO (base ${streakBaseElo} + ${adjustment})`);
    } else {
      console.log(`[STREAK] Loss streak ${lossStreak} -> Opponent ELO set to ${opponent.rating} (base ${streakBaseElo} + ${adjustment})`);
    }
  }
}

/**
 * Reset streak after breaking - called when creating new opponent
 */
function checkStreakBreak(outcome) {
  if (outcome === 'win' && lossStreak >= 2) {
    // Breaking a loss streak with a win -> randomize next opponent
    const newElo = generateRandomElo();
    console.log(`[STREAK] Loss streak broken (was ${lossStreak}) -> Next opponent ELO will be ${newElo}`);
    lossStreak = 0;
    return newElo;
  }

  if (outcome === 'lose' && winStreak >= 2) {
    // Breaking a win streak with a loss -> randomize next opponent
    const newElo = generateRandomElo();
    console.log(`[STREAK] Win streak broken (was ${winStreak}) -> Next opponent ELO will be ${newElo}`);
    winStreak = 0;
    return newElo;
  }
  
  return null; // No streak break
}

function createOpponent(targetElo){
  // IMPORTANT: targetElo comes from casino/gambling/rigging system - DO NOT CHANGE IT
  // We just wrap it with a stereotype personality
  
  // Use the stereotype system if available
  if (window.OpponentStereotypes && window.OpponentStereotypes.createOpponentWithStereotype) {
    const opponent = window.OpponentStereotypes.createOpponentWithStereotype(targetElo);
    console.log(`[BOT] Created stereotype opponent: "${opponent.name}" at ${opponent.rating} ELO`);
    return opponent;
  }
  
  // Fallback to old system if stereotype script not loaded
  const id = pickBotIdUnique();
  const name = `User ${pad6(id)}`;
  console.log(`[BOT] Fallback: Created basic opponent with ELO: ${targetElo}`);
  return { name, rating: targetElo, avatarSeed: String(id) };
}

function showOpponent(o){
  // Hide the opponent box in sidebar - we'll show opponent info in the top header instead
  const oppBox = document.getElementById('opponentBox');
  if (oppBox) {
    oppBox.style.display = 'none';
  }
  
  // Generate unique computer name if it's a bot (no stereotype means it's likely a player)
  let displayOpponentName = o.name;
  if (o.stereotype || !o.username) {
    // For computer opponents, generate a unique name like "Computer 5432"
    const hash = o.avatarSeed ? parseInt(o.avatarSeed) : Math.floor(Math.random() * 9000);
    const num = (hash % 9000) + 1000; // 1000-9999
    displayOpponentName = 'Computer ' + num;
  } else if (o.username) {
    // For human players, generate display name from their username
    displayOpponentName = generateDisplayName(o.username);
  }
  
  // Update the top header with opponent info
  if (o.stereotype) {
    // Show computer name without emoji (cleaner look)
    oppNameEl.textContent = displayOpponentName;
    oppNameEl.title = o.description || ''; // Tooltip with description
  } else {
    oppNameEl.textContent = displayOpponentName;
  }
  
  // HIDE the rating display for opponents
  const oppRatingEl = document.getElementById('oppRatingTop');
  if (oppRatingEl) {
    oppRatingEl.style.display = 'none'; // Hide rating
  }
  
  // Update avatar if needed (keeping the existing avatar logic for the header)
  if (oppAvatar) {
    seedAvatar(oppAvatar, o.avatarSeed);
  }
}

// keep this where it was
betButtons.forEach(btn=>btn.addEventListener('click',()=>{
  betButtons.forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  selectedBetCents = parseInt(btn.dataset.amt,10)*100;
  matchResult.textContent='';
}));

// Callback for when a match is found (used for rematches)
window.onMatchFound = function(data) {
  try {
    console.log('[MATCH_FOUND] ========================================');
    console.log('[MATCH_FOUND] Match found callback triggered!');
    console.log('[MATCH_FOUND] Data received:', JSON.stringify(data, null, 2));
    console.log('[MATCH_FOUND] Bet amount:', data.betAmount);
    console.log('[MATCH_FOUND] Is rematch:', data.isRematch);
    console.log('[MATCH_FOUND] ========================================');
    
    // Only handle rematch cases here - normal matchmaking is handled by findMatch() return
    if (!data.isRematch) {
      console.log('[MATCH_FOUND] Not a rematch - ignoring (handled by findMatch return via matchFoundResolve)');
      return;
    }
    
    console.log('[MATCH_FOUND] This is a REMATCH - starting new game...');
    
    // Set the bet amount from the match data
    selectedBetCents = data.betAmount * 100; // Server sends dollars, we need cents
    console.log('[MATCH_FOUND] Set selectedBetCents to:', selectedBetCents);
    
    // Store the game data globally
    window.multiplayerGameData = data;
    console.log('[MATCH_FOUND] Stored multiplayerGameData:', window.multiplayerGameData);
    
    // Trigger the duel button click to start the game
    // We'll use a flag to skip matchmaking since we already have a match
    window.__skipMatchmaking = true;
    console.log('[MATCH_FOUND] Set __skipMatchmaking flag, clicking duelBtn...');
    
    // Use setTimeout to ensure we're out of the current call stack
    setTimeout(() => {
      console.log('[MATCH_FOUND] Triggering duelBtn click...');
      duelBtn.click();
    }, 100);
    
  } catch (error) {
    console.error('[MATCH_FOUND] ❌ ERROR in onMatchFound:', error);
    console.error('[MATCH_FOUND] Error stack:', error.stack);
  }
};



duelBtn.addEventListener('click', async ()=>{
  try {
    // CRITICAL: If button says "RESIGN", don't handle - onclick handler will deal with it
    if (duelBtn.textContent === 'RESIGN') {
      console.log('[DUEL_BTN] Button says RESIGN - ignoring addEventListener, onclick will handle');
      return;
    }
    
    console.log('[DUEL_BTN] ==========================================');
    console.log('[DUEL_BTN] DUEL button clicked!');
    console.log('[DUEL_BTN] __skipMatchmaking flag:', window.__skipMatchmaking);
    console.log('[DUEL_BTN] selectedBetCents:', selectedBetCents);
    console.log('[DUEL_BTN] loggedIn:', loggedIn);
    console.log('[DUEL_BTN] ==========================================');
    
    // Prevent starting a new game if one is already in progress
    if (matchStarted) {
      statusMsg.textContent = 'Game in progress. Finish current game first.';
      statusMsg.style.color = '#ffa500';
      console.log('[DUEL_BTN] ❌ Game already in progress - matchStarted:', matchStarted);
      return;
    }
    
    // Check if bet amount changed - reset streaks if it did
    if (streakBetAmount !== null && streakBetAmount !== selectedBetCents) {
      console.log(`[STREAK] Bet changed from $${streakBetAmount/100} to $${selectedBetCents/100} -> Resetting streaks`);
      winStreak = 0;
      lossStreak = 0;
      streakBaseElo = null;
      streakBetAmount = null;
    }
    
    // Set/update the current bet amount for streak tracking
    if (streakBetAmount === null) {
      streakBetAmount = selectedBetCents;
      console.log(`[STREAK] Starting streak tracking with bet amount: $${selectedBetCents/100}`);
    }
    
    // Clear last game info when starting new game (unless it's a rematch)
    if (!window.__skipMatchmaking) {
      window.lastGameInfo = null;
    }
    
    if(!loggedIn){ 
      statusMsg.textContent = 'Log in first.';
      statusMsg.style.color = '#ff0000';
      console.log('[DUEL_BTN] ❌ Not logged in');
      return; 
    }
    if(!selectedBetCents){ 
      statusMsg.textContent = 'Select a bet: $1, $5, $10, or $50.';
      statusMsg.style.color = '#ff0000';
      console.log('[DUEL_BTN] ❌ No bet selected');
      return; 
    }
    // Check balance BEFORE starting matchmaking
    if(selectedBetCents > balance){ 
      statusMsg.textContent = 'Insufficient balance.';
      statusMsg.style.color = '#ff0000';
      console.log('[DUEL_BTN] ❌ Insufficient balance');
      return; 
    }
    
    console.log('[DUEL_BTN] ✅ Validation passed, starting game...');
    mmAmount.textContent=(selectedBetCents/100).toFixed(0); 
    mm.style.display='flex';
    
    // Try to connect to multiplayer server and find a match
    console.log('[MATCHMAKING] Looking for opponent for 10 seconds...');
    let isMultiplayerGame = false;
    
    // Check if we should skip matchmaking (rematch case)
    if (window.__skipMatchmaking && window.multiplayerGameData) {
      console.log('[MATCHMAKING] 🔄 Skipping matchmaking - using existing match data (REMATCH)');
      isMultiplayerGame = true;
      window.__skipMatchmaking = false; // Reset flag
    } else {
      // Normal matchmaking flow
      window.multiplayerGameData = null;
      
      if (window.multiplayer) {
        console.log('[MATCHMAKING] Connecting to server...');
        const connected = await multiplayer.connect();
        console.log('[MATCHMAKING] Connected:', connected);
        
        if (connected) {
          console.log('[MATCHMAKING] Starting matchmaking with 10 second timeout...');
          const matchResult = await multiplayer.findMatch(selectedBetCents);
          console.log('[MATCHMAKING] Match result:', matchResult);
          
          if (matchResult.multiplayer) {
            isMultiplayerGame = true;
            window.multiplayerGameData = matchResult.gameData;
            console.log('[MATCHMAKING] ✅ Matched with human opponent!', window.multiplayerGameData);
          } else {
            console.log('[MATCHMAKING] ⏱️ Timeout after 10 seconds - playing vs computer');
          }
        } else {
          console.log('[MATCHMAKING] ❌ Server offline - playing vs computer');
        }
      } else {
        console.log('[MATCHMAKING] ❌ Multiplayer not available - playing vs computer');
      }
    }
    
    console.log('Loading engine...');
    await ensureEngine();
    console.log('Engine loaded:', !engineOffline);

    // Only configure bot engine if this is NOT a multiplayer game
    if (!isMultiplayerGame) {
      // Decide rigging outcome for this match (unless an admin override is applied)
      let riggingDecision = null;

      // apply admin override (if any)
      activeOverride = pullAdminOverride(username);
      hideOppRating = !!activeOverride;

      if (activeOverride) {
        clearActiveRigging(username);
        console.log('[RIGGING] Bypassing stored rigging due to admin override.');
      } else {
        riggingDecision = lockRiggingForMatch(username);
        if (riggingDecision) {
          console.log('[RIGGING] Locked rig decision:', riggingDecision);
        }
      }

      const rigData = checkRiggingForUser(username);

      // Determine skill to apply
      let appliedSkill;
      if (activeOverride) {
        const hasDiff = Number.isInteger(activeOverride.difficulty);
        const oc = activeOverride.outcome;
        if (oc === 'null' || !['win','lose','draw','abort'].includes(oc)) {
          // Only set difficulty
          appliedSkill = hasDiff ? activeOverride.difficulty : 8;
        } else {
          // Outcome-based; prefer admin difficulty if given, else use SKILL_MAP fallback
          appliedSkill = hasDiff ? activeOverride.difficulty : (SKILL_MAP[oc] ?? 8);
        }
        setEngineSkill(Math.max(0, Math.min(20, appliedSkill)));
      } else {
        (function(){
        // CHECK FOR ACTIVE STREAKS FIRST
        let targetElo;
        
        if (winStreak >= 2 && streakBaseElo !== null) {
          // Player on win streak -> opponent gets HARDER (+500 per game after 2nd win)
          const adjustment = (winStreak - 1) * 500;
          targetElo = streakBaseElo + adjustment;
          console.log(`[STREAK PRE-CALC] Win streak ${winStreak} -> Target ELO: ${targetElo} (base ${streakBaseElo} + ${adjustment})`);
        } else if (lossStreak >= 2 && streakBaseElo !== null) {
          // Player on loss streak -> opponent gets EASIER (-500 per game after 2nd loss)
          const adjustment = -(lossStreak - 1) * 500;
          targetElo = Math.max(100, streakBaseElo + adjustment); // Floor at 100 ELO
          console.log(`[STREAK PRE-CALC] Loss streak ${lossStreak} -> Target ELO: ${targetElo} (base ${streakBaseElo} + ${adjustment})`);
        } else {
          // No active streak -> generate random ELO
          targetElo = generateRandomElo();
          console.log('[RANDOM-ELO] Generated random opponent ELO:', targetElo);
        }
        
        // RIGGING OVERRIDE: Check if user should win BEFORE setting engine skill
        if (rigData && rigData.shouldUserWin) {
          console.log('[RIGGING] Overriding system - forcing skill 0, ELO 200');
          setEngineSkill(0);
          window.__lastCompElo = 200;
          addRiggingLog(`System overridden for ${username}: skill 0, ELO 200`);
        } else {
          const engineParams = eloToEngineSkill(targetElo);
          setEngineSkill(engineParams.skill);
          window.__lastCompElo = targetElo;
        }
        
        window.__gamblingActive = false;
        updateEloDisplay(); // Update ELO debug display
      })();
      }
    } else {
      console.log('[MULTIPLAYER] Skipping bot engine configuration for multiplayer game');
    }

    await new Promise(r=>setTimeout(r,1500+Math.random()*1500));
    console.log('Creating opponent...');
    
    // Create opponent based on whether it's multiplayer or bot
    if (isMultiplayerGame && window.multiplayerGameData) {
      // CRITICAL FIX: Get userId from sessionStorage first (avoids tab conflicts!)
      const currentUserId = window.userId || parseInt(sessionStorage.getItem('userId')) || parseInt(localStorage.getItem('userId'));
      
      console.log('[APP.JS COLOR ASSIGNMENT] ========================================');
      console.log('[APP.JS] window.username:', window.username);
      console.log('[APP.JS] sessionStorage.username:', sessionStorage.getItem('username'));
      console.log('[APP.JS] localStorage.username:', localStorage.getItem('username'));
      console.log('[APP.JS] window.userId:', window.userId, typeof window.userId);
      console.log('[APP.JS] sessionStorage.userId:', sessionStorage.getItem('userId'), typeof sessionStorage.getItem('userId'));
      console.log('[APP.JS] localStorage.userId:', localStorage.getItem('userId'), typeof localStorage.getItem('userId'));
      console.log('[APP.JS] currentUserId (computed):', currentUserId, typeof currentUserId);
      console.log('[APP.JS] Game White Player ID:', window.multiplayerGameData.whitePlayerId, typeof window.multiplayerGameData.whitePlayerId);
      console.log('[APP.JS] Game Black Player ID:', window.multiplayerGameData.blackPlayerId, typeof window.multiplayerGameData.blackPlayerId);
      
      // Ensure both IDs are numbers for comparison
      const currentId = parseInt(currentUserId);
      const whiteId = parseInt(window.multiplayerGameData.whitePlayerId);
      const blackId = parseInt(window.multiplayerGameData.blackPlayerId);
      
      console.log('[APP.JS] After parseInt:');
      console.log('[APP.JS]   currentId:', currentId, typeof currentId);
      console.log('[APP.JS]   whiteId:', whiteId, typeof whiteId);
      console.log('[APP.JS]   blackId:', blackId, typeof blackId);
      
      // Determine player color based on player ID assignment
      const isWhitePlayer = (currentId === whiteId);
      humanPlays = isWhitePlayer ? 'w' : 'b';
      
      // Get opponent ID and username
      const opponentId = isWhitePlayer ? blackId : whiteId;
      const opponentUsername = isWhitePlayer ? window.multiplayerGameData.blackUsername : window.multiplayerGameData.whiteUsername;
      
      // Create opponent object with unique display name
      opponent = {
        name: generateDisplayName(opponentUsername),
        username: opponentUsername,
        rating: 1200,
        avatarSeed: String(opponentId),
        isHuman: true
      };
      
      console.log('[APP.JS] ✅ COLOR ASSIGNMENT RESULT:');
      console.log('[APP.JS]    Current User ID:', currentId);
      console.log('[APP.JS]    Current User Color:', humanPlays === 'w' ? 'WHITE' : 'BLACK');
      console.log('[APP.JS]    Opponent ID:', opponentId);
      console.log('[APP.JS]    Opponent Color:', humanPlays === 'w' ? 'BLACK' : 'WHITE');
      console.log('[APP.JS]    Comparison: currentId (', currentId, ') === whiteId (', whiteId, ')? ', currentId === whiteId);
      console.log('[APP.JS] ============================================================');
    } else {
      // Bot opponent
      // Check if this is a rematch with same opponent
      if (window.__rematchOpponent) {
        console.log('[REMATCH] Using same opponent for rematch:', window.__rematchOpponent.name);
        opponent = window.__rematchOpponent;
        opponent.isHuman = false;
        
        // Clear the rematch opponent flag
        window.__rematchOpponent = null;
      } else {
        // New game - create new opponent with pre-calculated streak-adjusted ELO
        opponent = createOpponent(window.__lastCompElo ?? getUserElo(username));
        opponent.isHuman = false;
        
        // Log streak status (ELO already adjusted in pre-calc phase)
        if (winStreak >= 2) {
          console.log(`[STREAK] Opponent created for win streak ${winStreak} at ${opponent.rating} ELO`);
        } else if (lossStreak >= 2) {
          console.log(`[STREAK] Opponent created for loss streak ${lossStreak} at ${opponent.rating} ELO`);
        }
      }
      
      // Random color for bot games
      humanPlays = (Math.random()<0.5) ? 'w' : 'b';
    }
    
    console.log('Opponent created:', opponent);
    showOpponent(opponent);

    stake=selectedBetCents; 
    if(stake>balance){ 
      mm.style.display='none'; 
      statusMsg.textContent = 'Insufficient balance.';
      statusMsg.style.color = '#ff0000';
      return; 
    }
    balance-=stake; 
    updateBalanceUI();

    console.log('Initializing game...');
    if(typeof Chess === 'undefined') {
      throw new Error('Chess.js library not loaded');
    }
    game=new Chess(); 
    console.log('Chess game initialized');
    selected=null; 
    lastMove=null; 
    resetCapturedPieces(); // Reset captured pieces for new game
    if(legalMovesEl) legalMovesEl.textContent=''; 
    premove=null;
    whiteOnBottom=(humanPlays==='w'); 
    console.log('Building board, humanPlays:', humanPlays, 'whiteOnBottom:', whiteOnBottom);
    buildSquares(); 
    console.log('Rendering board...');
    render();
    console.log('Attaching pot badge...');
    attachPotBadgeToBoard();

    // Update player headers and clocks based on player's color
    updatePlayerHeaders();

    // Ensure guest users have a display name
    if (!displayName) {
      displayName = 'Guest ' + Math.floor(1000 + Math.random() * 9000);
      const userNameBottom = document.getElementById('userNameBottom');
      if (userNameBottom) userNameBottom.textContent = displayName;
    }

    // 1+1 clocks - use server times if available (multiplayer), otherwise default to 60s
    if (opponent && opponent.isHuman && window.multiplayerGameData) {
      wMillis = window.multiplayerGameData.whiteTimeMs || 60000;
      bMillis = window.multiplayerGameData.blackTimeMs || 60000;
      console.log('[CLOCK] Initialized from server - White:', wMillis, 'Black:', bMillis);
    } else {
      wMillis = 60000;
      bMillis = 60000;
      console.log('[CLOCK] Initialized locally for bot game');
    }
    active=null; updateClockUI();
    wClockEl.style.display='flex'; bClockEl.style.display='flex'; movesBox.style.display='block'; matchResult.textContent='';

  statusMsg.textContent=`Bullet 1+1 — You’re playing vs ${opponent.name}.`;
  matchStarted = true;
  
  // Start tracking game in database
  const isMultiplayer = opponent && opponent.isHuman;
  const isRematch = window.multiplayerGameData && window.multiplayerGameData.isRematch;
  
  if (isRematch && window.multiplayerGameData.dbGameId) {
    // Rematch: Server already created DB record, just use the dbGameId
    currentGameId = window.multiplayerGameData.dbGameId;
    console.log('[REMATCH] Using existing DB game ID:', currentGameId);
  } else {
    // Normal game or bot: Create new DB record via HTTP API
    await startGameInDatabase(selectedBetCents, isMultiplayer ? "multiplayer" : "bot");
  }
  document.body.classList.add('game-active'); // Add game-active class for CSS
  mm.style.display='none';
  
  // Transform DUEL button into RESIGN button during match
  if (duelBtn) {
    duelBtn.textContent = 'RESIGN';
    duelBtn.classList.add('danger');
    duelBtn.onclick = resign;
  }
  
  active = 'w';
  startClock();
  sGameStart(); // Play game start sound
 const grossPot = stake * 2;
  potCents = netPot(grossPot);          // store net pot globally (used by payouts)
  setPot(potCents); 
  
  // Initialize Lc0 engine if enabled and opponent is bot
  if (useLc0 && opponent && !opponent.isHuman && opponent.rating) {
    console.log(`[LC0] Initializing for opponent ELO ${opponent.rating}...`);
    
    // Initialize game profile engine first (determines game characteristics)
    if (!gameProfileEngine) {
      console.log('[Game Profile] Initializing engine...');
      await initializeGameProfileEngine();
    }
    
    // Create profile for THIS game
    if (gameProfileEngine) {
      currentGameProfile = gameProfileEngine.createGameProfile(opponent.rating);
      
      // Use dynamic error budget system (with fallback to scheduled)
      if (typeof gameProfileEngine.initializeErrorBudget === 'function') {
        gameProfileEngine.initializeErrorBudget(40);
      } else {
        // Fallback to old scheduled system if new method doesn't exist
        console.warn('[Game Profile] Using legacy scheduled error system');
        gameProfileEngine.scheduleAllErrors(40);
      }
    } else {
      console.warn('[Game Profile] Not available, using legacy probability system');
    }
    
    // Initialize opening book (MUST wait for this to load)
    if (!openingBookEngine) {
      console.log('[Opening Book] Loading...');
      const loaded = await initializeOpeningBook();
      if (loaded) {
        console.log('[Opening Book] Ready to use');
      } else {
        console.warn('[Opening Book] Failed to load, will use pure engine');
      }
    }
    
    // Initialize blunder engine (MUST wait for this to load)
    if (!blunderEngine) {
      console.log('[Blunder Engine] Loading...');
      const loaded = await initializeBlunderEngine();
      if (loaded) {
        console.log('[Blunder Engine] Ready to use');
        const stats = blunderEngine.getBlunderStats(opponent.rating);
        if (stats) {
          console.log(`[Blunder Engine] ${opponent.rating} ELO: ~${stats.mistake_rate.total_mistakes_per_game.toFixed(1)} mistakes/game expected`);
        }
      } else {
        console.warn('[Blunder Engine] Failed to load, will play perfectly');
      }
    }
    
    // Initialize middlegame pattern engine (MUST wait for this to load)
    if (!middlegamePatternEngine) {
      console.log('[Middlegame] Loading...');
      const loaded = await initializeMiddlegamePatterns();
      if (loaded) {
        console.log('[Middlegame] Ready to use');
        const stats = middlegamePatternEngine.getCommonMovesStats(opponent.rating);
        if (stats) {
          console.log(`[Middlegame] ${opponent.rating} ELO (${stats.eloRange}): ${stats.totalGames} games, avg ${stats.avgGameLength.toFixed(1)} moves`);
        }
      } else {
        console.warn('[Middlegame] Failed to load, will use pure engine moves');
      }
    }
    
    // Initialize Lc0 (can be async)
    initializeLc0(opponent.rating).then(success => {
      if (success) {
        console.log(`[LC0] Ready to play at ELO ${opponent.rating}`);
      } else {
        console.warn('[LC0] Initialization failed, will use Stockfish fallback');
      }
    }).catch(err => {
      console.error('[LC0] Initialization error:', err);
    });
  }
  
  // Only apply rigging logic for bot games, not multiplayer
  if (!isMultiplayerGame) {
    // CRITICAL: Re-check rigging when game actually starts
    const rigData = checkRiggingForUser(username);
    
    if (username && rigData && rigData.shouldUserWin) {
      console.log('[RIGGING] Game start - forcing weak computer (ELO 200, skill 0)');
      setEngineSkill(0); // Force weakest skill level for rigging
      window.__lastCompElo = 200;
      updateEloDisplay();
      addRiggingLog(`Game started with rigging for ${username}: forced skill 0, ELO 200`);
    } else if (opponent && opponent.rating) {
      // UCI_ELO SYSTEM: Initialize engine for this ELO level
      // UCI_Elo parameter is set per-move in normalEngineReply()
      console.log(`[BOT-INIT] ELO ${opponent.rating} ready - UCI system will handle strength`);
    }

    // Enable rig controller so engine blunders aggressively when the user must win
    let shouldForceRigController = false;
    let rigControllerDifficulty = 0;
    if (activeOverride && activeOverride.outcome === 'win') {
      shouldForceRigController = true;
      rigControllerDifficulty = Number.isInteger(activeOverride.difficulty) ? activeOverride.difficulty : 0;
    } else if (rigData && rigData.shouldUserWin) {
      shouldForceRigController = true;
      rigControllerDifficulty = 0;
    }

    if (shouldForceRigController) {
      const clampedDifficulty = Math.max(0, Math.min(20, rigControllerDifficulty));
      rig = makeRigController({ loserColor: engineSide(), difficulty: clampedDifficulty });
      if (rigData && rigData.shouldUserWin) {
        addRiggingLog(`Rig controller activated for ${username}: forcing engine collapse (difficulty ${clampedDifficulty})`);
      }
    } else {
      rig = null;
    }
  } else {
    console.log('[MULTIPLAYER] Skipping rigging logic for multiplayer game');
    rig = null; // No rigging in multiplayer
  }

  maybeEngineReply();
  } catch (error) {
    console.error('Error starting game:', error);
    console.error('Error stack:', error.stack);
    console.error('Error message:', error.message);
    mm.style.display='none';
    statusMsg.textContent = 'Error starting game: ' + error.message;
    statusMsg.style.color = '#ff0000';
  }
});

function outcomeFromFlags(flagged,prevActive){
  if(!flagged) return null;
  return (prevActive==='w') ? (humanPlays==='w'?'lose':'win') : (humanPlays==='b'?'lose':'win');
}

function showResultBanner(outcome, potCents, payoutCents){
  const toast = document.getElementById('resultToast');
  const toastMessage = document.getElementById('toastMessage');
  const okBtn = document.getElementById('toastOkBtn');
  const rematchBtn = document.getElementById('toastRematchBtn');
  
  // Set the class and message
  toast.className = 'toast ' + (outcome || 'draw');
  toastMessage.textContent = (outcome === 'win' ? 'YOU WON' : 'YOU ' + (outcome === 'lose' ? 'LOST' : 'DREW')) + 
    ` — POT ${fmt(potCents)}  •  Payout ${fmt(payoutCents)}`;
  
  // Show/hide rematch button based on if it was a multiplayer game
  const lastGame = window.lastGameInfo;
  // Safely define isMultiplayer to avoid ReferenceError
  const isMultiplayer = lastGame && lastGame.wasMultiplayer;
  // Always show rematch button, even for computer games
  rematchBtn.style.display = 'inline-block';
  
  console.log('[REMATCH] Show result banner - isMultiplayer:', isMultiplayer, 'lastGame:', lastGame);
  
  // Show the toast (stays visible until user clicks OK or outside)
  toast.style.display = 'block';
  toast.style.transform = 'translate(-50%, -50%) scale(1)';
  
  if (outcome === 'win') { 
    launchConfetti(1600); 
  }
  
  // Function to close the toast
  const closeToast = () => {
    toast.style.display = 'none';
    document.removeEventListener('click', outsideClickHandler);
  };
  
  // Handle OK button click
  okBtn.onclick = (e) => {
    e.stopPropagation();
    closeToast();
  };
  
  // Handle Rematch button click
  rematchBtn.onclick = async (e) => {
    e.stopPropagation();
    
    // Close banner immediately when rematch is clicked
    closeToast();
    
    if (!isMultiplayer || !lastGame) {
      // Computer game - bot needs to decide if it accepts rematch
      console.log('[REMATCH] Computer game - bot considering rematch...');
      const statusMsg = document.getElementById('statusMsg');
      
      // Show "waiting" message
      if (statusMsg) {
        statusMsg.textContent = `${opponent.name} is thinking...`;
        statusMsg.style.color = '#ffa500';
        statusMsg.style.display = 'block';
        statusMsg.style.visibility = 'visible';
      }
      
      // Bot thinks for 1-3 seconds
      const thinkTime = 1000 + Math.random() * 2000;
      await new Promise(resolve => setTimeout(resolve, thinkTime));
      
      // Calculate acceptance probability based on ELO
      // Higher ELO = more confident = more likely to accept
      // Base: 50%, +0.02% per ELO point above 1500
      let acceptProbability = 0.5;
      if (opponent && opponent.rating) {
        if (opponent.rating > 1500) {
          acceptProbability = 0.5 + ((opponent.rating - 1500) / 10000);
        } else if (opponent.rating < 1500) {
          acceptProbability = 0.5 - ((1500 - opponent.rating) / 10000);
        }
        // Clamp between 0.3 and 0.8
        acceptProbability = Math.max(0.3, Math.min(0.8, acceptProbability));
      }
      
      const botAccepts = Math.random() < acceptProbability;
      
      console.log(`[REMATCH] Bot ELO: ${opponent.rating}, Accept probability: ${(acceptProbability * 100).toFixed(1)}%, Decision: ${botAccepts ? 'ACCEPT' : 'DECLINE'}`);
      
      if (botAccepts) {
        // Bot accepts - start new game with same opponent
        if (statusMsg) {
          statusMsg.textContent = `${opponent.name} accepted! Starting rematch...`;
          statusMsg.style.color = '#00ffaf';
        }
        
        // Store current opponent for rematch
        window.__rematchOpponent = opponent;
        
        // Wait a moment then trigger new game
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Click duel button to start new game
        duelBtn.click();
      } else {
        // Bot declines
        if (statusMsg) {
          statusMsg.textContent = `${opponent.name} declined the rematch.`;
          statusMsg.style.color = '#ff8a8a';
        }
      }
      return;
    }
    
    // Multiplayer rematch logic
    // Check if user has sufficient balance
    const betAmountDollars = lastGame.betAmount; // Already in dollars from server
    const betAmountCents = betAmountDollars * 100;
    const statusMsg = document.getElementById('statusMsg');
    
    if (balance < betAmountCents) {
      if (statusMsg) {
        statusMsg.textContent = 'Insufficient balance for rematch.';
        statusMsg.style.color = '#ff0000';
      }
      return;
    }
    
    console.log(`[REMATCH] Requesting rematch with opponent ${lastGame.opponentId} (${lastGame.opponentUsername}) for $${betAmountDollars}`);
    console.log(`[REMATCH] Previous colors - White: ${lastGame.previousWhiteId}, Black: ${lastGame.previousBlackId}`);
    
    // Send rematch request with color info for swapping
    multiplayer.requestRematch(
      lastGame.opponentId, 
      betAmountDollars,
      lastGame.previousWhiteId,
      lastGame.previousBlackId
    );
    
    // Update UI
    if (statusMsg) {
      statusMsg.textContent = 'Rematch request sent...';
      statusMsg.style.color = '#00ffaf';
    }
    closeToast();
  };
  
  // Handle clicks outside the toast
  const outsideClickHandler = (e) => {
    if (!toast.contains(e.target)) {
      closeToast();
    }
  };
  
  // Add click listener after a short delay to prevent immediate close
  setTimeout(() => {
    document.addEventListener('click', outsideClickHandler);
  }, 100);
}

async function endMatch(flagged=false, forceOutcome=null){
  console.log('[ENDMATCH] Called - matchStarted before:', matchStarted);
  stopClock(); const prevActive=active; matchStarted=false;
  console.log('[ENDMATCH] matchStarted set to false');
  document.body.classList.remove('game-active'); // Remove game-active class
  
  // Restore DUEL button when match ends
  if (duelBtn) {
    duelBtn.textContent = 'DUEL';
    duelBtn.classList.remove('danger');
    duelBtn.onclick = null; // Remove resign handler, will use the addEventListener instead
  }
  
  // Clean up multiplayer connection
  if (window.multiplayer) {
    multiplayer.endGame();
  }
  
  let outcome = forceOutcome || outcomeFromFlags(flagged,prevActive);
  if(!outcome){
    if(game.in_checkmate()){ 
      const winner=(game.turn()==='w')?'black':'white'; 
      const humanWon=(humanPlays==='w'&&winner==='white')||(humanPlays==='b'&&winner==='black'); 
      outcome=humanWon?'win':'lose';
      sCheckmate(); // Play checkmate sound
    }
    else if(game.in_draw()){ 
      outcome='draw';
      if(game.in_stalemate()) {
        sStalemate(); // Play stalemate sound
      } else {
        sGameOver(); // Play generic game over for other draws
      }
    }
  } else {
    // Forced outcome - play game over sound
    sGameOver();
  }
  if (outcome === 'win') {
    balance += potCents; // winner takes the net pot
    matchResult.className = 'result win';
    matchResult.textContent = `You won $${(stake/100).toFixed(2)} • Payout $${(potCents/100).toFixed(2)}.`;
    showResultBanner('win', potCents, potCents);
  } else if (outcome === 'lose') {
    matchResult.className = 'result lose';
    matchResult.textContent = `You lost $${(stake/100).toFixed(2)}.`;
    showResultBanner('lose', potCents, 0);
  } else {
    const split = Math.floor(potCents / 2); // exact cents; winnerless split
    balance += split;
    matchResult.className = 'result draw';
    matchResult.textContent = `Draw. Split pot • Your share $${(split/100).toFixed(2)}.`;
    showResultBanner('draw', potCents, split);
  }
 updateBalanceUI();
  
  // Sync balance to server after game ends
  // End game in database (replaces syncBalanceToServer)
  // CRITICAL: await this so database updates BEFORE any other balance fetches
  await endGameInDatabase(outcome);
  
  // Apply streak-based ELO adjustments
  applyStreakEloAdjustment(outcome);
  
  // Update Elo systems
  try{ adjustEloForOutcome(username, outcome); }catch(_){}
  try { recordCasinoResult(username, outcome); } catch(_){}
  
  // Recalculate computer ELO for next game based on updated user ELO
  if (username) {
    try {
      const updatedUserElo = getUserElo(username);
      
      // Use the appropriate ELO system
      if (window.__gamblingActive && GAMBLING_CONFIG.house_edge_on) {
        // Update gambling state first
        if (window.__gamblingState) {
          settleGamblingGame(username, outcome);
        }
        const gamblingState = configureNextGamblingGame(username);
        window.__lastCompElo = gamblingState.E_engine;
        console.log('[gambling-next] Updated computer ELO to:', window.__lastCompElo);
      } else {
        // Use casino system
        const { botElo } = computeCasinoBotEloForGame(username, updatedUserElo);
        window.__lastCompElo = botElo;
        console.log('[casino-next] Updated computer ELO to:', window.__lastCompElo);
      }
    } catch(e) {
      console.error('[elo-update] error:', e);
    }
  }
  
  // Update ELO display after game
  updateEloDisplay();
  
  // Update emotional state tracking
  if (username) {
    try {
      const emotionalState = updateEmotionalState(username, outcome);
      console.log('[emotional] outcome=%s consecutive_losses=%d frustration=%.2f confidence=%.2f mood=%s',
        outcome, emotionalState.consecutiveLosses, emotionalState.frustrationLevel, 
        emotionalState.confidenceLevel, emotionalState.lastGameMood);
      
      // Update rigging progress
      const userWon = (outcome === 'win');
      updateRiggingProgress(username, userWon);
      
      // Detect and show near-miss for psychology
      const wasNearMiss = detectNearMiss(outcome, game);
      if (wasNearMiss) {
        console.log('[psychology] Near-miss detected for better player experience');
        showNearMissMessage(true);
      }
    } catch(e) {
      console.error('[emotional] error:', e);
    }
  }
  
  // Gambling system settlement
  if (window.__gamblingActive && username) {
    try {
      const gamblingState = settleGamblingGame(username, outcome);
      console.log('[gambling-settle] outcome=%s P_hat=%d->%d net_tokens=%d games=%d',
        outcome, window.__gamblingState?.P_hat || 0, gamblingState.P_hat, 
        gamblingState.net_tokens, gamblingState.games_played);
    } catch(e) {
      console.error('[gambling-settle] error:', e);
    }
  }
  window.__gamblingActive = false;
  window.__gamblingState = null;

  clearActiveRigging(username);


  if(activeOverride){ finalizeAdminHistory(username, outcome); activeOverride=null; hideOppRating=false; }
  const ts=new Date().toISOString(); const rec={opponent:opponent?opponent.name:'—',rating:opponent?opponent.rating:'—',bet:stake/100,result:matchResult.textContent,outcome,ts}; saveMatchHistoryExtended(rec);
  setPot(0);
  rig=null;
  hidePlatformFee();
}

/* ===== ELO Debug Display Functions ===== */
function updateEloDisplay() {
  // ELO display is now hidden - this function kept for compatibility
  const debugInfo = document.getElementById('debugInfo');
  if (debugInfo) {
    debugInfo.style.display = 'none';
  }
}

/* ===== Thinking Indicator System ===== */
function showThinkingIndicator(timeMs) {
  const statusMsg = document.getElementById('statusMsg');
  if (!statusMsg || !isEngineTurn()) return;
  
  const opponentName = opponent ? opponent.name : 'Opponent';
  
  // Check if rigging is causing the delay
  const rigData = username ? checkRiggingForUser(username) : null;
  const isRigged = rigData && rigData.shouldUserWin;
  
  let thinkingMessages;
  if (isRigged) {
    // Special messages for rigged delays (3-6 seconds)
    thinkingMessages = [
      `${opponentName} is struggling with this position...`,
      `${opponentName} is having difficulty finding a good move...`,
      `${opponentName} seems confused by the position...`,
      `${opponentName} is taking a long time to decide...`,
      `${opponentName} appears uncertain...`
    ];
  } else {
    // Normal thinking messages
    thinkingMessages = [
      `${opponentName} is thinking...`,
      `${opponentName} is analyzing the position...`,
      `${opponentName} is considering moves...`,
      `${opponentName} is calculating...`
    ];
  }
  
  const message = thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];
  const originalText = statusMsg.textContent;
  
  statusMsg.textContent = message;
  statusMsg.style.color = '#888';
  statusMsg.style.fontStyle = 'italic';
  
  // Add dots animation for longer thinks
  if (timeMs > 2000) {
    let dots = '';
    const dotInterval = setInterval(() => {
      dots += '.';
      if (dots.length > 3) dots = '';
      statusMsg.textContent = message + dots;
    }, 500);
    
    setTimeout(() => {
      clearInterval(dotInterval);
    }, timeMs - 100);
  }
  
  // Reset after thinking time
  setTimeout(() => {
    if (statusMsg.textContent.includes('thinking') || statusMsg.textContent.includes('analyzing')) {
      statusMsg.textContent = originalText;
      statusMsg.style.color = '';
      statusMsg.style.fontStyle = '';
    }
  }, timeMs);
}

function hideThinkingIndicator() {
  const statusMsg = document.getElementById('statusMsg');
  if (!statusMsg) return;
  
  // Only hide if currently showing thinking message
  if (statusMsg.textContent.includes('thinking') || statusMsg.textContent.includes('analyzing')) {
    const turnWord = game.turn() === 'w' ? 'White' : 'Black';
    statusMsg.textContent = `${turnWord} to move`;
    statusMsg.style.color = '';
    statusMsg.style.fontStyle = '';
  }
}

/* ===== Human-like timing (enhanced & slower) ===== */
function computeThinkMs(){ 
  // Check for rigging - if user should win, make computer play at consistent 3-6 seconds per move
  if (username) {
    const rigData = checkRiggingForUser(username);
    if (rigData && rigData.shouldUserWin) {
      const side = game.turn();
      const computerTime = side === 'w' ? wMillis : bMillis;
      
      // Consistent 3-6 second delays for all rigged moves
      let riggedTime = 3000 + Math.random() * 3000; // 3-6 seconds
      
      // If computer has very little time left (under 10 seconds), reduce delay slightly
      // but still maintain at least 2-4 seconds to make it feel natural
      if (computerTime < 10000) {
        riggedTime = 2000 + Math.random() * 2000; // 2-4 seconds in time trouble
        console.log(`[RIGGING] Computer low on time (${Math.round(computerTime/1000)}s left) - using ${Math.round(riggedTime/1000)}s delay`);
      }
      
      // Cap at remaining time minus 1000ms to avoid flagging
      const maxTime = Math.max(2000, computerTime - 1000);
      riggedTime = Math.min(riggedTime, maxTime);
      
      console.log(`[RIGGING] Consistent delay: ${Math.round(riggedTime/1000)}s - Computer time: ${Math.round(computerTime/1000)}s`);
      addRiggingLog(`RIGGED: ${username} - ${Math.round(riggedTime/1000)}s delay (${Math.round(computerTime/1000)}s left)`);
      return riggedTime;
    }
  }
  
  const ply = game.history().length;
  const side = game.turn();
  const position = game.fen();
  
  // Base times - consistent 1-3 second range with more randomness
  let baseTime;
  const randomFactor = 0.5 + Math.random() * 1.0; // 0.5x to 1.5x variation
  if(ply <= 10) baseTime = (1000 + Math.random() * 2000) * randomFactor;      // Opening: 0.5-4.5s
  else if(ply <= 30) baseTime = (1200 + Math.random() * 1800) * randomFactor; // Middlegame: 0.6-4.5s
  else baseTime = (1000 + Math.random() * 2000) * randomFactor;               // Endgame: 0.5-4.5s
  
  // Add occasional "quick moves" and "long thinks"
  const thinkingPattern = Math.random();
  if (thinkingPattern < 0.15) {
    baseTime *= 0.3; // 15% chance of quick move (0.3x speed)
  } else if (thinkingPattern > 0.85) {
    baseTime *= 2.0; // 15% chance of long think (2x speed)
  }
  
  // Get player's current performance for Elo-based delays
  const playerElo = username ? getUserElo(username) : 1200;
  const emotional = username ? loadEmotionalState(username) : null;
  
  // Progressive delays for losing players (moderate adjustments with randomness)
  let eloMultiplier = 1.0;
  const eloRandomness = 0.8 + Math.random() * 0.4; // Random factor for ELO effects
  if (playerElo < 1000) {
    eloMultiplier = 1.4 * eloRandomness; // Randomly slower for struggling players
  } else if (playerElo < 1100) {
    eloMultiplier = 1.2 * eloRandomness; // Randomly slower for below average
  } else if (playerElo < 1200) {
    eloMultiplier = 1.1 * eloRandomness; // Randomly slower for new players
  } else if (playerElo > 1400) {
    eloMultiplier = 0.9 * eloRandomness; // Randomly faster for good players
  }
  
  // Frustration-based delays (moderate increases with randomness)
  let frustrationMultiplier = 1.0;
  const frustrationRandomness = 0.7 + Math.random() * 0.6; // Random frustration effects
  if (emotional) {
    if (emotional.consecutiveLosses >= 6) {
      frustrationMultiplier = 1.5 * frustrationRandomness; // Random delays after 6 losses
    } else if (emotional.consecutiveLosses >= 4) {
      frustrationMultiplier = 1.3 * frustrationRandomness; // Random delays after 4 losses
    } else if (emotional.consecutiveLosses >= 2) {
      frustrationMultiplier = 1.1 * frustrationRandomness; // Random delays after 2 losses
    }
    
    // Additional frustration scaling (reduced and randomized)
    frustrationMultiplier += (emotional.frustrationLevel * 0.3 * frustrationRandomness);
  }
  
  // Apply multipliers
  baseTime *= eloMultiplier * frustrationMultiplier;
  
  // Emotional adjustments based on game state (with random variation)
  const materialDiff = evalForColorCp(game, side);
  const confidenceRandom = 0.8 + Math.random() * 0.4; // Random confidence factor
  
  // Confidence when ahead, anxiety when behind
  if(materialDiff > 200) baseTime *= (0.9 * confidenceRandom);      // Randomly faster when ahead
  else if(materialDiff < -200) baseTime *= (1.3 * confidenceRandom); // Randomly slower when behind
  
  // Position complexity adds moderate thinking time (with randomness)
  const legalMoves = game.moves().length;
  const complexityRandom = 0.7 + Math.random() * 0.6; // Random complexity factor
  if(legalMoves > 30) baseTime *= (1.2 * complexityRandom);         // Random complexity bonus
  else if(legalMoves > 20) baseTime *= (1.1 * complexityRandom);    // Random moderate bonus
  if(game.in_check()) baseTime *= (1.1 * complexityRandom);         // Random check bonus
  
  // Critical position detection (tactics, captures available) - random response
  const captures = game.moves().filter(m => m.includes('x')).length;
  if(captures > 3) baseTime *= (1.1 * (0.8 + Math.random() * 0.4)); // Random tactical thinking
  
  // Add multiple layers of randomness
  const variance1 = 0.6 + Math.random() * 0.8; // First random layer
  const variance2 = 0.8 + Math.random() * 0.4; // Second random layer
  baseTime *= variance1 * variance2;
  
  // Random pause/hesitation (5% chance of extra delay)
  if (Math.random() < 0.05) {
    baseTime *= 1.8; // Occasional "hmm, let me think about this"
  }
  
  // Keep within reasonable range but allow more variation
  return Math.max(500, Math.min(8000, Math.round(baseTime))); // 0.5s to 8s range
}
function capByClock(ms){ 
  // RIGGING OVERRIDE: Don't cap timing when user should win
  if (username) {
    const rigData = checkRiggingForUser(username);
    if (rigData && rigData.shouldUserWin) {
      console.log(`[RIGGING] Bypassing clock cap - allowing ${Math.round(ms)}ms delay`);
      return ms; // Return uncapped rigged timing
    }
  }
  
  const side = game.turn() === 'w' ? 'w' : 'b';
  const remain = side === 'w' ? wMillis : bMillis;
  
  // Add randomness to clock pressure
  const clockRandomness = 0.8 + Math.random() * 0.4;
  
  // Keep thinking times in reasonable range with randomness
  let cap = Math.min(6000, Math.max(800, ms * clockRandomness));  // Random cap between 6s max, 0.8s min
  
  // Respect remaining time with random pressure
  cap = Math.min(cap, Math.max(600, (remain - 1000) * clockRandomness)); 
  
  // In time trouble, think faster but with some randomness
  if(remain < 15000) cap = Math.min(cap, 2500 * clockRandomness);  // Random time pressure
  if(remain < 10000) cap = Math.min(cap, 2000 * clockRandomness);  
  if(remain < 5000) cap = Math.min(cap, 1000 * clockRandomness);   
  
  return Math.round(cap);
}
// If any admin override (including 'null') is active, do not jitter the engine skill.


const openingBook={'':[['e4',4],['d4',3],['c4',2],['Nf3',2]],'e4':[['e5',4],['c5',3],['e6',2],['c6',2]],'d4':[['d5',4],['Nf6',3],['e6',2],['g6',1]],'c4':[['e5',3],['Nf6',3],['c5',2],['e6',2]],'Nf3':[['d5',3],['Nf6',3],['c5',2],['g6',2]],'e4 e5':[['Nf3',4],['Bc4',2],['Nc3',1],['d4',1]],'e4 c5':[['Nf3',4],['c3',2],['d4',2]],'d4 d5':[['c4',4],['Nf3',3],['e3',2]],'d4 Nf6':[['c4',4],['Nf3',3],['g3',2]]};
function weightedRandom(list){const total=list.reduce((s,[,w])=>s+w,0);let r=Math.random()*total;for(const [val,w] of list){if((r-=w)<=0)return val}return list[0][0]}
function getBookMoveSAN(){ const ply=game.history().length; if(ply>6) return null; const sanSeq=game.history().map(m=>m.replace(/\+|#|\!|\?/g,'')).join(' '); const key=sanSeq.trim(); let options=openingBook[key];
  if(!options && ply===1){ const first=sanSeq.split(' ')[0]; const proto={'e4':'e5','d4':'d5','c4':'e5','Nf3':'d5'}; const reply=proto[first]; if(reply) options=[[reply,3]]; }
  return options? weightedRandom(options) : null; }
function playSANIfLegal(san){ const legal=game.moves({verbose:true}); const cand=legal.find(m=>m.san.replace(/\+|#|\!|\?/g,'')===san); if(!cand) return false;
  const moved=game.move({from:cand.from,to:cand.to,promotion:cand.promotion||'q'}); if(!moved) return false;
  clearLegalGlows(); // <<< ensure glow is cleared on book move
  lastMove={from:moved.from,to:moved.to}; applyIncrementForSide(moved.color); switchClock(); render(); if(moved.flags&&(moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove(); if(game.in_check()&&!game.in_checkmate()) sCheck(); if(game.in_checkmate()||game.in_draw()) endMatch(); tryExecutePremove(); return true; }

/* ===== Rigged human-like loss (admin "win") ===== */
const RigPhases={SOFT_SKEW:0,PRESSURE:1,MISTAKE:2,COLLAPSE:3,FINISH:4};

function isRigLose(){ return !!(rig && rig.active); } // bot loses, human wins
function engineSide(){ return (humanPlays==='w')?'b':'w'; }

// cp values
const VAL_CP={p:100,n:320,b:330,r:500,q:900,k:0};

function colorOpp(c){ return c === 'w' ? 'b' : 'w'; }

// Is `sq` attacked by `byColor` in position `ch`?
function isSquareAttackedBy(ch, sq, byColor){
  const fen = ch.fen().split(' ');
  fen[1] = byColor;                       // set side-to-move to the attacker
  const g = new Chess(fen.join(' '));
  return g.moves({ verbose:true }).some(m => m.color === byColor && m.to === sq);
}
function materialCp(board){
  let w=0,b=0;
  for(const row of board){ for(const p of row){ if(!p) continue; const v=VAL_CP[p.type]||0; if(p.color==='w') w+=v; else b+=v; } }
  return w-b; // + = white better
}
function evalWhiteMinusBlackCp(ch){ return materialCp(ch.board()); }
function evalForColorCp(ch, color){ const wmb=evalWhiteMinusBlackCp(ch); return (color==='w')? wmb : -wmb; }
function developedMinorCount(ch, color){
  const homeRank = (color==='w') ? '1' : '8';
  let n = 0;
  for(const sq of ch.SQUARES){
    const p = ch.get(sq);
    if(!p || p.color!==color) continue;
    if(p.type==='n' || p.type==='b'){
      if(!sq.endsWith(homeRank)) n++;
    }
  }
  return n;
}
function isEarlyPly(ply, limit=12){ return ply < limit; }
function isEnemyHalfSquare(sq, color){
  const rank = parseInt(sq[1],10);
  return (color==='w') ? (rank >= 5) : (rank <= 4);
}
function countAttackers(ch, sq, byColor){
  const fen = ch.fen().split(' ');
  fen[1] = byColor;
  const g = new Chess(fen.join(' '));
  let c = 0;
  for(const m of g.moves({verbose:true})){
    if(m.color===byColor && m.to===sq) c++;
  }
  return c;
}
function wouldTradeQueens(orig, tmp){
  const countQ = (board)=>board.flat().filter(p=>p&&p.type==='q').length;
  return countQ(tmp.board()) < countQ(orig.board());
}
function pieceMoveCountSoFar(ch, pieceCode){
  const hist = ch.history(); // SAN so far
  const map = { wq:'Q', wk:'K', wb:'B', wn:'N', wr:'R', bq:'Q', bk:'K', bb:'B', bn:'N', br:'R' };
  const tag = map[pieceCode] || '';
  if(!tag) return 0;
  return hist.filter(san => san.startsWith(tag)).length;
}

function detectFlagsAfterMove(origGame, move, tmp){
  const f = {};

  // simplify (trades / big material captured)
  if (move.captured) {
    const v = VAL_CP[move.captured] || 0;
    f.simplify = v >= 300;
  } else {
    const countQ = (board)=>board.flat().filter(p=>p&&p.type==='q').length;
    const beforeQ = countQ(origGame.board());
    const afterQ  = countQ(tmp.board());
    f.simplify = (afterQ < beforeQ);
  }

  // core tactical flags
  f.mateNow = tmp.in_checkmate();
  f.check   = tmp.in_check() && !f.mateNow;
  f.capturedValue = move.captured ? (VAL_CP[move.captured] || 0) : 0;
  f.capturedQueen = (move.captured === 'q');

  // unsafe trade (recapture on destination)
  const movedPiece = tmp.get(move.to);
  if (movedPiece) {
    const opp = tmp.turn();
    const movedVal = VAL_CP[movedPiece.type] || 0;
    const oppCanCaptureBack = isSquareAttackedBy(tmp, move.to, opp);
    const tradeDelta = oppCanCaptureBack ? (f.capturedValue - movedVal) : 0;
    f.unsafeTrade = (oppCanCaptureBack && tradeDelta < -60);
    f.tradeDelta  = tradeDelta;
  } else {
    f.unsafeTrade = false;
    f.tradeDelta  = 0;
  }

  // queen protection (kept)
  const ourColor = colorOpp(tmp.turn()); // side that just moved
  let ourQueenSq = null;
  for (const [sq, p] of origGame.SQUARES.map(s => [s, origGame.get(s)])) {
    if (p && p.type === 'q' && p.color === ourColor) { ourQueenSq = sq; break; }
  }
  if (ourQueenSq) {
    const oppBefore = colorOpp(ourColor);
    const wasAttacked = isSquareAttackedBy(origGame, ourQueenSq, oppBefore);
    const stillAttacked = isSquareAttackedBy(tmp, ourQueenSq, tmp.turn());
    f.protectsQueen = (wasAttacked && !stillAttacked);
  } else {
    f.protectsQueen = false;
  }

  // --- NEW humanization flags ---
  const ply = origGame.history().length + 1;
  const side = ourColor;
  const dev = developedMinorCount(origGame, side);

  // Early queen adventure
  const movedWasQueen = (origGame.get(move.from)?.type === 'q');
  if (movedWasQueen && isEarlyPly(ply, 12)) {
    const deep = isEnemyHalfSquare(move.to, side);
    const attackers = countAttackers(tmp, move.to, tmp.turn());
    f.earlyQueenAdvance = deep && dev < 2;
    f.riskyQueenRaid    = deep && attackers >= 2;
  } else {
    f.earlyQueenAdvance = false;
    f.riskyQueenRaid    = false;
  }

  // Early voluntary king walk
  const movedWasKing = (origGame.get(move.from)?.type === 'k');
  if (movedWasKing && isEarlyPly(ply, 12)) {
    const cameFromCheck = origGame.in_check();
    f.voluntaryKingWalkEarly = !cameFromCheck && !move.captured;
  } else {
    f.voluntaryKingWalkEarly = false;
  }

  // Premature simplify (e.g., queen trade) while underdeveloped
  f.prematureSimplify = false;
  if (isEarlyPly(ply, 12) && dev < 2) {
    if (wouldTradeQueens(origGame, tmp) || f.simplify) {
      f.prematureSimplify = true;
    }
  }

  // Same piece too many times early
  f.repeatMoverInOpening = false;
  if (isEarlyPly(ply, 12)) {
    const p = origGame.get(move.from);
    if (p && p.type !== 'p') {
      const code = p.color + p.type;
      const count = pieceMoveCountSoFar(origGame, code) + 1;
      f.repeatMoverInOpening = (count >= 3) && (dev < 2);
    }
  }

  return f;
}

function getCandidatesByStatic(maxN=8){
  const side = game.turn();
  const legal = game.moves({ verbose:true });
  if (!legal.length) return [];

  const scored = [];
  const ply = game.history().length;

  // scale penalties by difficulty & stake
  const s = Math.max(0, Math.min(20, currentSkill|0));
  const diffScale = 1.0 + (20 - s) * 0.04;     // lower skill → stronger penalties
  const stakeScale = (stake >= 2000) ? 0.75 : 1.0; // high stake → a bit safer
  const PEN = (base)=> Math.round(base * diffScale * stakeScale);

  for (const m of legal){
    const tmp = new Chess(game.fen());
    tmp.move({ from:m.from, to:m.to, promotion:m.promotion || 'q' });

    let baseCp = evalForColorCp(tmp, side);
    const flags = detectFlagsAfterMove(game, m, tmp);

    let bonus = 0;

    // keep existing incentives
    if (flags.mateNow) bonus += 10000;
    if (flags.capturedQueen) bonus += 600;
    if (m.captured){
      const movedVal = VAL_CP[(game.get(m.from)?.type) || ''] || 0;
      const capVal   = flags.capturedValue;
      bonus += Math.max(0, capVal - Math.floor(movedVal/2));
    }
    if (flags.check) bonus += 40;
    if (flags.protectsQueen) bonus += 120;
    if (flags.unsafeTrade) bonus -= Math.max(80, -flags.tradeDelta);

    // NEW: humanization penalties (targets your observed non-human moves)
    if (flags.earlyQueenAdvance)      bonus -= PEN(90);
    if (flags.riskyQueenRaid)         bonus -= PEN(70);
    if (flags.voluntaryKingWalkEarly) bonus -= PEN(140);
    if (flags.prematureSimplify)      bonus -= PEN(60);
    if (flags.repeatMoverInOpening)   bonus -= PEN(45);

    // gentle nudge to develop in opening
    if (isEarlyPly(ply, 10)) {
      const movingType = (game.get(m.from)?.type);
      if (movingType==='n' || movingType==='b') bonus += 12;
      if (movingType==='p' && (m.to.endsWith('4') || m.to.endsWith('5'))) bonus += 4;
    }

    const totalCp = baseCp + bonus;

    scored.push({
      uci: m.from + m.to + (m.promotion || ''),
      cp: totalCp,
      rawCp: baseCp,
      san: m.san,
      flags,
      from: m.from, to: m.to, promotion: m.promotion
    });
  }

  scored.sort((a,b)=> b.cp - a.cp);
  return scored.slice(0, Math.max(3, Math.min(maxN, scored.length)));
}

/* ===== Humanize normal (non-rigged) play ===== */
function randn(){
  let u=0, v=0;
  while(u===0) u=Math.random();
  while(v===0) v=Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}
function softmaxPick(values, temperature=1.0){
  const t = Math.max(0.05, temperature);
  const exps = values.map(v => Math.exp(v / t));
  const sum  = exps.reduce((a,b)=>a+b,0);
  let r = Math.random() * sum;
  for(let i=0;i<exps.length;i++){ r -= exps[i]; if(r<=0) return i; }
  return values.length-1;
}
function humanizeParams(skill){
  const s = Math.max(0, Math.min(20, skill|0));
  // only sometimes use the humanized path; much rarer at higher skill
  const humanSwitchProb = Math.max(0.03, 0.35 - (s * 0.02));
  // colder softmax → favors top moves
  const temp            = Math.max(0.08, 0.95 - (s * 0.04));
  // mistakes are tiny & rare
  const mistakeProb     = Math.max(0.003, 0.08 - (s * 0.004));
  // cap how “bad” a mistake can be
  const maxDropCp       = Math.max(30, Math.min(90, 60 + Math.max(0, (8 - s)*4)));
  // lower eval noise
  const evalNoiseSigma  = Math.max(4, Math.round(6 + (20 - s)*0.8));
  return { humanSwitchProb, temp, mistakeProb, maxDropCp, evalNoiseSigma };
}


function humanLikeEngineMove(){
  if(!matchStarted || !isEngineTurn() || engineBusy) return;
  
  // Get emotional state for behavioral patterns
  const emotional = username ? loadEmotionalState(username) : null;
  const params = humanizeParams(currentSkill);

  let cands = getCandidatesByStatic(8);
  if(!cands.length){ endMatch(); return; }

  // Add a bit of evaluation noise to feel human
  const noisy = cands.map(c => ({
    ...c,
    score: c.cp + randn()*params.evalNoiseSigma
  }));

  // Behavioral patterns based on emotional state (with randomness)
  let timeMultiplier = 1.0;
  let mistakeMultiplier = 1.0;
  
  if (emotional) {
    const emotionalRandomness = 0.7 + Math.random() * 0.6; // Random emotional effects
    
    // Frustrated players think a bit longer (not faster) - with randomness
    if (emotional.frustrationLevel > 0.7) {
      timeMultiplier *= (1.1 * emotionalRandomness); // Randomly slower when frustrated
      mistakeMultiplier *= 1.5; // More mistakes when frustrated
    }
    
    // Confident players play at random speeds
    if (emotional.confidenceLevel > 0.8) {
      timeMultiplier *= (1.0 * emotionalRandomness); // Random speed when confident
    }
    
    // Recent losers think randomly longer sometimes
    if (emotional.consecutiveLosses >= 2 && Math.random() < 0.3) {
      timeMultiplier *= (1.2 * emotionalRandomness); // Random analysis increase
    }
  }

  // Prefer immediate checkmate (human with money won't miss mate-in-1)
const mates = noisy.filter(n => n.flags && n.flags.mateNow);
if (mates.length) {
  // pick the best by cp among mates (usually first already)
  mates.sort((a,b) => b.cp - a.cp);
  const chosenMate = mates[0];
  let ms = capByClock(computeThinkMs() * timeMultiplier); // Apply emotional timing
  
  // Show thinking indicator even for mate (humans double-check)
  if (ms > 800) {
    showThinkingIndicator(ms);
  }

  engineBusy = true;
  setTimeout(()=>{
    hideThinkingIndicator();
    if(!matchStarted || !isEngineTurn()) { engineBusy=false; return; }
    const m = {from: chosenMate.from, to: chosenMate.to, promotion: chosenMate.promotion || 'q'};
    const moved = game.move(m);
    engineBusy=false;
    if(!moved) return;
    clearLegalGlows();
    lastMove={from:moved.from,to:moved.to};
    applyIncrementForSide(moved.color);
    switchClock(); render();
    if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
    if(game.in_check()&&!game.in_checkmate()) sCheck();
    if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
    tryExecutePremove();
  }, ms);
  return; // <<< critical: skip the rest (no mistakes when mate is on the board)
}


  // Softmax over noisy scores (higher score → more likely)
  const idxSoft = softmaxPick(noisy.map(n=>n.score), params.temp);
  let chosen = noisy[idxSoft];

  // Enhanced mistake system with emotional influence
try {
  const best = noisy[0];
  const second = noisy[1] ?? best;
  const leadCp = best.cp - second.cp;

  let effProb = params.mistakeProb * mistakeMultiplier;
  const piecesLeft = game.board().flat().filter(Boolean).length;
  if (leadCp >= 60)   effProb *= 0.2;   // clearly best line → almost no mistakes
  if (piecesLeft <= 12) effProb *= 0.35; // endgame clean-up
  if (stake >= 2000)  effProb *= 0.5;   // bigger bet → safer

  // Emotional mistake patterns
  if (emotional) {
    if (emotional.frustrationLevel > 0.6) effProb *= 1.8; // More mistakes when frustrated
    if (emotional.consecutiveLosses >= 3) effProb *= 1.4; // Tilted players make more mistakes
    if (emotional.consecutiveWins >= 3) effProb *= 0.6;   // Confident players make fewer mistakes
  }

  if (Math.random() < effProb && Array.isArray(noisy) && noisy.length) {
    const candidates = noisy.filter(n => {
      const drop = best.cp - n.cp;
      return Number.isFinite(drop) && drop >= 8 && drop <= params.maxDropCp;
    });
    const safe = candidates.filter(n => {
      const drop = best.cp - n.cp;
      return !(n && n.flags && n.flags.simplify && drop > 50);
    });
    const pool = safe.length ? safe : candidates;
    if (pool.length) {
      const k = Math.min(2, pool.length);
      chosen = pool[Math.floor(Math.random() * k)];
    }
  }
} catch (_) { /* keep flow robust */ }


  // Enhanced human-like time with emotional patterns
  let ms = capByClock(computeThinkMs() * timeMultiplier);
  
  // Show thinking indicator for longer delays
  if (ms > 1000) {
    showThinkingIndicator(ms);
  }

  engineBusy = true;
  setTimeout(()=>{
    hideThinkingIndicator(); // Hide thinking indicator when move is made
    if(!matchStarted || !isEngineTurn()) { engineBusy=false; return; }
    const m = {from: chosen.from, to: chosen.to, promotion: chosen.promotion || 'q'};
    const moved=game.move(m);
    engineBusy=false;
    if(!moved) return;
    clearLegalGlows();
    lastMove={from:moved.from,to:moved.to};
    applyIncrementForSide(moved.color);
    switchClock(); render();
    if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
    if(game.in_check()&&!game.in_checkmate()) sCheck();
    if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
    tryExecutePremove();
  }, ms);
}

/* ===== Rig timing helpers reused ===== */
function humanThinkDelay({legalCount, evalSpread, timeMs, incMs, phase, difficulty}){
  const base = 200 + Math.random()*200;
  const complexity = Math.min(1200, 40*legalCount + 6*evalSpread);
  const phaseFactor = phase==='opening' ? 0.85 : phase==='endgame' ? 1.15 : 1.0;
  const timePressure = timeMs < 10000 ? 1.6 : timeMs < 30000 ? 1.25 : 1.0;
  const diffFactor = 0.7 + 0.1*(Math.max(0,Math.min(10,difficulty/2)));
  return Math.min(4500, (base + complexity)*phaseFactor*timePressure*diffFactor);
}
function rigTimeAdjust(baseDelayMs, ctrl, clocksMs){
  let mult = 1.0;
  if (ctrl.phase === RigPhases.PRESSURE) mult = 1.12;
  if (ctrl.phase === RigPhases.MISTAKE)  mult = 1.22;
  if (ctrl.phase === RigPhases.COLLAPSE) mult = 1.34;
  if (ctrl.phase === RigPhases.FINISH)   mult = 1.45;
  const remain = clocksMs.self;
  if (remain < 10000) mult *= 1.2 + Math.random()*0.3;
  const jitter = 60 + Math.random()*140;
  return Math.min(5000, baseDelayMs*mult + jitter);
}

// Scale rig severity with difficulty (0 = very weak, 20 = tougher)
function makeRigController({loserColor, difficulty}){
  const d = Math.max(0, Math.min(20, difficulty|0));
  const blunderBudget = Math.max(120, 420 - d*15); // more budget at low difficulty
  const minBetweenDrops = Math.max(3, 10 - Math.floor(d/2));
  return {
    active:true,
    loserColor,
    phase:RigPhases.SOFT_SKEW,
    blunderBudgetCp:blunderBudget,
    mistakeCount:0,
    lastBigDropPly:-99,
    minPlyBetweenDrops:minBetweenDrops,
    difficulty:d
  };
}
function gamePhaseWord(){
  const piecesLeft = game.board().flat().filter(Boolean).length;
  if(piecesLeft>=24) return 'opening';
  if(piecesLeft<=10) return 'endgame';
  return 'middlegame';
}
function updateRigPhase(ctrl){
  const ply = game.history().length;
  const loserEval = evalForColorCp(game, ctrl.loserColor);
  const piecesLeft = game.board().flat().filter(Boolean).length;
  if (ctrl.phase === RigPhases.SOFT_SKEW && ply >= 10) ctrl.phase = RigPhases.PRESSURE;
  if (ctrl.phase === RigPhases.PRESSURE && (ply >= 18 || loserEval < -60)) ctrl.phase = RigPhases.MISTAKE;
  if (ctrl.phase === RigPhases.MISTAKE && (ctrl.mistakeCount >= 2 || loserEval < -180)) ctrl.phase = RigPhases.COLLAPSE;
  if (ctrl.phase === RigPhases.COLLAPSE && (loserEval < -600 || piecesLeft <= 8)) ctrl.phase = RigPhases.FINISH;
}

// Helper to scale drop ranges by difficulty
function dropScale(ctrl){
  // difficulty 0 → ~5.5x; difficulty 20 → ~1x
  return 1 + (20-ctrl.difficulty)/4;
}

function rigPickCandidate(cands, ctrl){
  const best=cands[0];
  const scale = dropScale(ctrl);
  const dropWithin=(min,max)=>cands.find(c=> (best.cp - c.cp) >= min && (best.cp - c.cp) <= max);
  const ply=game.history().length;

  if (ctrl.phase === RigPhases.SOFT_SKEW) return dropWithin(10*scale,35*scale) || best;
  if (ctrl.phase === RigPhases.PRESSURE)  return dropWithin(25*scale,60*scale) || dropWithin(10*scale,35*scale) || best;
  if (ctrl.phase === RigPhases.MISTAKE){
    if (ply - ctrl.lastBigDropPly >= ctrl.minPlyBetweenDrops && ctrl.blunderBudgetCp >= 80){
      const m=dropWithin(70*scale,120*scale);
      if(m){ ctrl.mistakeCount++; ctrl.lastBigDropPly=ply; ctrl.blunderBudgetCp -= Math.min(ctrl.blunderBudgetCp,(best.cp - m.cp)); return m; }
    }
    return dropWithin(25*scale,60*scale) || best;
  }
  if (ctrl.phase === RigPhases.COLLAPSE){
    const tradeWorse=cands.find(c=> c.flags?.simplify && (best.cp - c.cp) >= 40*scale && (best.cp - c.cp) <= 120*scale);
    return tradeWorse || dropWithin(40*scale,90*scale) || best;
  }
  if (ctrl.phase === RigPhases.FINISH){
    return dropWithin(20*scale,70*scale) || best;
  }
  return best;
}
function avoidDrawHeuristics(fen, chosenUci){ return chosenUci; } // placeholder

function maybeFinish(ctrl){
  if (ctrl.phase < RigPhases.FINISH) return null;
  const evalCp = evalForColorCp(game, ctrl.loserColor);
  const remainMs = (ctrl.loserColor==='w'? wMillis : bMillis);
  const legalCount = game.moves({verbose:true}).length;
  if (evalCp < -700 && remainMs < 40000 && legalCount > 0){
    const r=Math.random();
    if (r < 0.15) return {type:'bluff'};
    if (r < 0.75) return {type:'resign'};
    return null;
  }
  return null;
}

function riggedEngineMove(){
  if(!matchStarted || !isEngineTurn() || engineBusy) return;
  const sideToMove = game.turn();
  const loserTurn = (isRigLose() && sideToMove === rig.loserColor);
  if(!loserTurn){
    normalEngineReply();
    return;
  }

  updateRigPhase(rig);

  // With very low difficulty, sometimes choose a random legal move to simulate human error
  if (rig.difficulty <= 4 && Math.random() < 0.25){
    const legal=game.moves({verbose:true});
    if(legal.length){
      const m = legal[Math.floor(Math.random()*legal.length)];
      engineBusy=true;
      
      // Use consistent 3-6 second delays for rigged random moves
      let delay = 3000 + Math.random() * 3000;
      const remainMs = sideToMove==='w' ? wMillis : bMillis;
      if (remainMs < 10000) {
        delay = 2000 + Math.random() * 2000;
      }
      delay = Math.min(delay, Math.max(2000, remainMs - 1000));
      console.log(`[RIGGING] Random move delay: ${Math.round(delay/1000)}s`);
      
      // Show thinking indicator
      if (delay > 1000) {
        showThinkingIndicator(delay);
      }
      
      setTimeout(()=>{
        hideThinkingIndicator();
        if(!matchStarted || !isEngineTurn()) { engineBusy=false; return; }
        const moved=game.move({from:m.from,to:m.to,promotion:m.promotion||'q'});
        engineBusy=false;
        if(!moved) return;
        clearLegalGlows(); // <<< ensure glow is cleared in random-mistake branch
        lastMove={from:moved.from,to:moved.to};
        applyIncrementForSide(moved.color);
        switchClock(); render();
        if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
        if(game.in_check()&&!game.in_checkmate()) sCheck();
        if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
        tryExecutePremove();
      }, delay);
      return;
    }
  }

  const cands=getCandidatesByStatic(6);
  if(!cands.length){ endMatch(); return; }

  const evalSpread = Math.max(0, cands[0].cp - (cands[1]?.cp ?? cands[0].cp));
  const legalCount = cands.length;
  const remainMs = sideToMove==='w' ? wMillis : bMillis;

  // Use consistent 3-6 second delays for rigged games
  let delay;
  if (username) {
    const rigData = checkRiggingForUser(username);
    if (rigData && rigData.shouldUserWin) {
      // Consistent 3-6 second delays
      delay = 3000 + Math.random() * 3000;
      // If low on time, reduce to 2-4 seconds
      if (remainMs < 10000) {
        delay = 2000 + Math.random() * 2000;
      }
      // Cap at remaining time minus 1000ms
      delay = Math.min(delay, Math.max(2000, remainMs - 1000));
      console.log(`[RIGGING] Rig controller delay: ${Math.round(delay/1000)}s`);
    } else {
      // Use normal rig timing for admin overrides
      const baseDelay = humanThinkDelay({
        legalCount, evalSpread, timeMs: remainMs, incMs: 1000, phase: gamePhaseWord(), difficulty: rig.difficulty
      });
      delay = rigTimeAdjust(baseDelay, rig, {self: remainMs});
    }
  } else {
    // Fallback to normal rig timing
    const baseDelay = humanThinkDelay({
      legalCount, evalSpread, timeMs: remainMs, incMs: 1000, phase: gamePhaseWord(), difficulty: rig.difficulty
    });
    delay = rigTimeAdjust(baseDelay, rig, {self: remainMs});
  }

  const fin = maybeFinish(rig);
  if(fin?.type==='resign'){
    engineBusy=true;
    setTimeout(()=>{ engineBusy=false; endMatch(false,'win'); }, Math.max(200, delay));
    return;
  }

  let chosen = rigPickCandidate(cands, rig);

  if(rig.phase===RigPhases.FINISH && remainMs<1200){
    engineBusy=true; // stall to flag naturally
    return;
  }

  // Show thinking indicator for rigged moves
  if (delay > 1000) {
    showThinkingIndicator(delay);
  }

  engineBusy=true;
  setTimeout(()=>{
    hideThinkingIndicator();
    if(!matchStarted || !isEngineTurn()) { engineBusy=false; return; }
    const m = {from: chosen.uci.slice(0,2), to: chosen.uci.slice(2,4), promotion: chosen.uci[4]||'q'};
    const moved=game.move(m);
    engineBusy=false;
    if(!moved) return;
    clearLegalGlows(); // <<< ensure glow cleared in rig standard branch
    lastMove={from:moved.from,to:moved.to};
    applyIncrementForSide(moved.color);
    switchClock(); render();
    if(moved.flags && (moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove();
    if(game.in_check()&&!game.in_checkmate()) sCheck();
    if(game.in_checkmate()||game.in_draw()){ endMatch(); return; }
    tryExecutePremove();
  }, delay);
}

function isEngineTurn(){ return matchStarted && game.turn()!==humanPlays; }

function offlineBotMove(){
  const legal=game.moves({verbose:true}); if(!legal.length){ endMatch(); return; }
  const m=legal[Math.floor(Math.random()*legal.length)];
  const moved=game.move({from:m.from,to:m.to,promotion:m.promotion||'q'});
  if(moved){
    trackCapturedPiece(moved); // Track captured pieces
    clearLegalGlows(); // <<< ensure glow cleared in offline bot move
    lastMove={from:moved.from,to:moved.to};
    applyIncrementForSide(moved.color);
    switchClock(); render(); 
    updateCapturedPiecesDisplay(); // Update display
    if(moved.flags&&(moved.flags.includes('c')||moved.flags.includes('e'))) sCapture(); else sMove(); if(game.in_check()&&!game.in_checkmate()) sCheck(); if(game.in_checkmate()||game.in_draw()) endMatch(); else tryExecutePremove();
  }
}

/* === Unified engine reply supporting both Stockfish and Lc0 === */
async function getEngineMove(skillLevel) {
  // If using Lc0, get move from Lc0 engine
  if (useLc0 && lc0Ready) {
    try {
      const moveData = await getLc0Move(skillLevel);
      if (moveData) {
        return moveData;
      }
      // Fall through to Stockfish if Lc0 fails
      console.warn('[ENGINE] Lc0 failed, falling back to Stockfish');
    } catch (error) {
      console.error('[ENGINE] Lc0 error, falling back to Stockfish:', error);
    }
  }
  
  // Use Stockfish (existing implementation)
  return null; // Stockfish uses callback-based system
}

/* === Normal engine reply (supports both Lc0 and Stockfish) === */
async function normalEngineReply(){
  // CRITICAL: Don't use engine when rig controller is active AND it's the loser's turn
  if (isRigLose()) {
    const sideToMove = game.turn();
    const loserTurn = (sideToMove === rig.loserColor);
    if (loserTurn) {
      console.log('[RIGGING] Skipping engine - rig controller handles moves for loser');
      return;
    }
  }
  
  // Calculate thinking delay based on opponent ELO and stereotype
  let ms = 0;
  
  if (opponent && opponent.rating) {
    // Get base thinking time for this ELO
    ms = getThinkingTimeForElo(opponent.rating);
    
    // Apply stereotype think time multiplier if available
    if (opponent.stereotype && opponent.stereotype.thinkTimeMultiplier) {
      ms = Math.round(ms * opponent.stereotype.thinkTimeMultiplier);
      console.log(`[ENGINE] Think time: ${ms}ms (multiplier: ${opponent.stereotype.thinkTimeMultiplier}x)`);
    }
  }
  
  // Show thinking indicator for longer delays
  if (ms > 1000) {
    showThinkingIndicator(ms);
  }

  // Try Lc0 first if enabled
  if (useLc0 && opponent && opponent.rating) {
    try {
      console.log(`[LC0] Requesting move for ELO ${opponent.rating}...`);
      
      // Wait for the thinking delay
      await new Promise(resolve => setTimeout(resolve, ms));
      hideThinkingIndicator();
      
      if (!matchStarted || !isEngineTurn()) {
        console.log('[LC0] Match ended or not engine turn, aborting');
        return;
      }
      
      // Get move from Lc0 with the opponent's calculated ELO
      const moveData = await getLc0Move(opponent.rating);
      
      if (moveData) {
        console.log(`[LC0] Got move: ${moveData.from}${moveData.to} for ELO ${opponent.rating}`);
        executeEngineMove(moveData.from, moveData.to, moveData.promotion);
        return;
      }
      
      console.warn('[LC0] No move returned, falling back to Stockfish');
    } catch (error) {
      console.error('[LC0] Error, falling back to Stockfish:', error);
      hideThinkingIndicator();
    }
  }

  // Fallback to Stockfish if Lc0 disabled/failed or no opponent rating
  if (engineOffline) {
    setTimeout(()=>{ 
      hideThinkingIndicator();
      if(matchStarted && isEngineTurn()) offlineBotMove(); 
    }, ms);
    return;
  }

  engineBusy = true;
  
  // Stockfish UCI_ELO BASED DIFFICULTY
  setTimeout(() => {
    hideThinkingIndicator();
    
    if (!matchStarted || !isEngineTurn()) {
      engineBusy = false;
      return;
    }
    
    let searchDepth = 10;
    let uciElo = null;
    // DISABLED: MultiPV for pure play
    // let multipv = 8;
    
    if (opponent && opponent.rating) {
      searchDepth = getSearchDepthForElo(opponent.rating);
      uciElo = getUciEloForRating(opponent.rating);
      
      // DISABLED: MultiPV move selection for pure play
      // multiPvMoves = [];
      // waitingForMultiPv = true;
      // sendToEngine(`setoption name MultiPV value ${multipv}`);
      
      if (uciElo) {
        sendToEngine('setoption name UCI_LimitStrength value true');
        sendToEngine(`setoption name UCI_Elo value ${uciElo}`);
        console.log(`[STOCKFISH] ELO ${opponent.rating} -> UCI_Elo: ${uciElo}, depth: ${searchDepth}`);
      } else {
        sendToEngine('setoption name UCI_LimitStrength value false');
        console.log(`[STOCKFISH] ELO ${opponent.rating} -> depth only: ${searchDepth}`);
      }
    }
    
    sendToEngine('position fen ' + game.fen());
    sendToEngine(`go depth ${searchDepth}`);
  }, ms);
}


function maybeEngineReply(){
  console.log('[maybeEngineReply] Called - matchStarted:', matchStarted, 'engineBusy:', engineBusy, 'isEngineTurn():', isEngineTurn(), 'game.turn():', game.turn(), 'humanPlays:', humanPlays);
  
  if(!matchStarted || engineBusy || !isEngineTurn()) return;
  if(game.game_over()) return;

  // Skip engine for human opponents - wait for socket events
  if (opponent && opponent.isHuman) {
    console.log('[ENGINE] Human opponent - waiting for their move via socket');
    return;
  }

  // Check rigging state
  const rigActive = isRigLose();
  
  if(rigActive){
    console.log('[ENGINE] Rig controller active - using riggedEngineMove()');
    riggedEngineMove();
    return;
  }
  
  const engineName = useLc0 ? 'Leela Chess Zero' : 'Stockfish';
  console.log(`[ENGINE] Normal play - using ${engineName}`);
  normalEngineReply();
}

/* ===== History & persistence ===== */
async function saveMatchHistoryExtended(rec){
  try{ const key='history:'+username; const arr=JSON.parse(localStorage.getItem(key)||'[]'); arr.unshift(rec); localStorage.setItem(key, JSON.stringify(arr.slice(0,50))); }catch(_){}
  try{ const res=await fetch((window.CHESS_API||'http://localhost:3000')+'/match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,result:rec.result,outcome:rec.outcome,opponent:rec.opponent,rating:rec.rating,bet:rec.bet,ts:rec.ts})}); const data=await res.json(); if(data&&typeof data.balance==='number'){ balance=data.balance; updateBalanceUI(); } }catch(_){}
  renderMatchHistory();
}
async function renderMatchHistory(){
  const box=document.getElementById('matchHistory'); if(!username){ box.textContent=''; return; }
  try{
    const res=await fetch(`${window.CHESS_API||'http://localhost:3000'}/history/${username}`);
    if(res.ok){
      const history=await res.json();
      // ⛔ REPLACE this:
      // if(Array.isArrayArray(history)&&history.length){
      // ✅ WITH this:
      if (Array.isArray(history) && history.length){
        box.innerHTML=history.slice(0,10).map(m=>`<div>vs <b>${m.opponent||'Player'}</b> — $${m.bet||'?'} — ${m.result} <span class="note">(${new Date(m.ts||Date.now()).toLocaleString()})</span></div>`).join('');
        return;
      }
    }
  }catch(_){}
  try{
    const key='history:'+username;
    const arr=JSON.parse(localStorage.getItem(key)||'[]');
    box.innerHTML=arr.slice(0,10).map(m=>`<div>vs <b>${m.opponent}</b> — $${m.bet} — ${m.result} <span class="note">(${new Date(m.ts).toLocaleString()})</span></div>`).join('');
  }catch(_){ box.textContent=''; }
}

/* ===== Draw / Resign / Abort ===== */
const drawBtnEl=document.getElementById('drawBtn'), resignBtnEl=document.getElementById('resignBtn'), abortBtnEl=document.getElementById('abortBtn');
function offerDraw(){
  if(!matchStarted){ return; }
  
  // For multiplayer, send draw offer to opponent
  if (opponent && opponent.isHuman && window.multiplayer) {
    multiplayer.offerDraw();
    statusMsg.textContent='Draw offer sent to opponent...';
    return;
  }
  
  // For bot opponent
  const accept = game.history().length>40 || Math.random()<0.35;
  if(accept){ statusMsg.textContent='Draw agreed.'; endMatch(false,'draw'); }
  else { statusMsg.textContent='Draw declined.'; }
}
function resign(){
  if(!matchStarted){ return; }
  
  // For multiplayer, notify opponent and wait for server response
  if (opponent && opponent.isHuman && window.multiplayer) {
    console.log('[RESIGN] Multiplayer resign - sending to server');
    multiplayer.resign();
    // Show status message while waiting for server
    const me = humanPlays==='w'?'White':'Black';
    statusMsg.textContent=`${me} resigning...`;
    // Don't call endMatch - wait for server's game_ended event
    return;
  }
  
  // For computer games, handle locally
  if (!opponent || !opponent.isHuman) {
    window.lastGameInfo = {
      opponentId: null,
      opponentUsername: opponent ? opponent.name : 'Computer',
      betAmount: stake/100,
      wasMultiplayer: false,
      previousWhiteId: null,
      previousBlackId: null
    };
    const me = humanPlays==='w'?'White':'Black';
    const opp = me==='White'?'Black':'White';
    statusMsg.textContent=`${me} resigns. ${opp} wins.`;
    endMatch(false,'lose');
  }
}
function abort(){
  if(!matchStarted){ return; }
  
  // PROFESSIONAL FIX: Abort is not allowed in multiplayer games
  // In multiplayer, players must resign if they want to end the game
  if(isMultiplayerGame){
    console.log('[ABORT] Abort disabled for multiplayer games. Use resign instead.');
    statusMsg.textContent='❌ Abort not available in multiplayer. Use Resign to forfeit.';
    return;
  }
  
  // Abort only works for bot games
  const plies = game.history().length;
  if(plies===0){
    stopClock(); matchStarted=false; balance+=stake; updateBalanceUI();
    matchResult.className='result draw'; matchResult.textContent='Game aborted. Bet returned.';
    const ts=new Date().toISOString(); const rec={opponent:opponent?opponent.name:'—',rating:opponent?opponent.rating:'—',bet:stake/100,result:'Game aborted. Bet returned.',outcome:'abort',ts}; saveMatchHistoryExtended(rec);
    setPot(0);
  }else{
    statusMsg.textContent='Abort after first move: you forfeit your stake.';
    endMatch(false,'lose');
  }
  hidePlatformFee();
}
if (drawBtnEl) drawBtnEl.addEventListener('click', offerDraw);
if (resignBtnEl) resignBtnEl.addEventListener('click', resign);
if (abortBtnEl) abortBtnEl.addEventListener('click', abort);

/* ===== Confetti (win only) ===== */
function launchConfetti(duration=1500){
  const cvs=document.getElementById('confetti'); const ctx=cvs.getContext('2d'); cvs.width=innerWidth; cvs.height=innerHeight; cvs.style.display='block';
  const N=140, parts=[];
  for(let i=0;i<N;i++){
    parts.push({x:Math.random()*cvs.width,y:-20-Math.random()*cvs.height*0.5,r:4+Math.random()*6,c:`hsl(${Math.random()*360} 90% 60%)`,vx:-1+Math.random()*2,vy:2+Math.random()*3,rot:Math.random()*Math.PI,vr:(-0.2+Math.random()*0.4)});
  }
  const t0=performance.now();
  (function draw(t){
    const dt=(t-(draw._last||t))/16; draw._last=t;
    ctx.clearRect(0,0,cvs.width,cvs.height);
    for(const p of parts){
      p.vy+=0.05*dt; p.x+=p.vx*dt; p.y+=p.vy*dt; p.rot+=p.vr*dt;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle=p.c; ctx.fillRect(-p.r,-p.r,p.r*2,p.r*2); ctx.restore();
    }
    if(t-t0<duration){ requestAnimationFrame(draw); } else { cvs.style.display='none'; }
  })(t0);
}

/* ===== Boot & background ===== */
console.log('[APP.JS] Initializing board...');
buildSquares(); render(); updateBalanceUI(); attachPotBadgeToBoard();
console.log('[APP.JS] Board initialized!');

// Handle orientation changes on mobile
function handleOrientationChange() {
  setTimeout(() => {
    if (window.innerHeight < window.innerWidth && window.innerHeight < 500) {
      // Landscape mode on mobile - adjust board size
      const boardEl = document.getElementById('board');
      if (boardEl) {
        boardEl.style.width = 'min(70vh, 70vw)';
        boardEl.style.height = 'min(70vh, 70vw)';
      }
    } else {
      // Portrait mode or desktop - normal sizing
      const boardEl = document.getElementById('board');
      if (boardEl) {
        boardEl.style.width = '';
        boardEl.style.height = '';
      }
    }
  }, 100);
}

/* ===== GAMBLING SYSTEM DEBUG CONSOLE COMMANDS ===== */
// View gambling stats in console: window.gamblingStats()
window.gamblingStats = function() {
  if (!username) {
    console.log('[gambling] Not logged in');
    return;
  }
  
  const state = loadGamblingState(username);
  const global = loadGlobalRTP();
  const gc = GAMBLING_CONST;
  
  console.group('🎰 GAMBLING SYSTEM STATS');
  console.log('Player:', username);
  console.log('P_hat (Player Elo):', state.P_hat);
  console.log('E_engine (Engine Elo):', state.E_engine);
  console.log('Games Played:', state.games_played);
  console.log('Net Tokens (W-L):', state.net_tokens);
  console.log('Session Start:', new Date(state.session_start).toLocaleString());
  
  // Calculate current tier
  const tier = tieredDelta(state.P_hat, gc.DELTA_BASE_BY_TIER);
  const tierName = state.P_hat < 800 ? 'Weak' : state.P_hat < 1400 ? 'Average' : 'Strong';
  console.log('Tier:', tierName, '(Base Delta:', tier + ')');
  
  // Global RTP
  if (global.outcomes.length > 0) {
    const sum = global.outcomes.reduce((a, b) => a + b, 0);
    const rtp = sum / global.outcomes.length;
    console.log('\nGlobal RTP Stats:');
    console.log('Games Tracked:', global.outcomes.length);
    console.log('Current RTP:', (rtp * 100).toFixed(2) + '%', '(Target: 49%)');
    console.log('Delta Adjustment:', global.delta_adjustment);
    console.log('Last Update:', new Date(global.last_update).toLocaleString());
  }
  
  // Feature flags
  console.log('\nFeature Flags:');
  console.log('House Edge:', GAMBLING_CONFIG.house_edge_on ? '✅ ON' : '❌ OFF');
  console.log('Loss Latency:', GAMBLING_CONFIG.loss_latency_on ? '✅ ON' : '❌ OFF');
  console.log('RTP Controller:', GAMBLING_CONFIG.rtp_controller_on ? '✅ ON' : '❌ OFF');
  console.log('Audit Logging:', GAMBLING_CONFIG.audit_logging ? '✅ ON' : '❌ OFF');
  
  console.groupEnd();
  
  return { state, global, tier: tierName };
};

// View emotional stats: window.emotionalStats()
window.emotionalStats = function() {
  if (!username) {
    console.log('[emotional] Not logged in');
    return;
  }
  
  const emotional = loadEmotionalState(username);
  const casino = loadCasino(username);
  
  console.group('🧠 EMOTIONAL AI STATS');
  console.log('Player:', username);
  console.log('Session Games:', emotional.sessionGames);
  console.log('Consecutive Wins:', emotional.consecutiveWins);
  console.log('Consecutive Losses:', emotional.consecutiveLosses);
  console.log('Frustration Level:', emotional.frustrationLevel.toFixed(2));
  console.log('Confidence Level:', emotional.confidenceLevel.toFixed(2));
  console.log('Last Game Mood:', emotional.lastGameMood);
  
  // Calculate current multiplier
  const multiplier = getEmotionalMultiplier(username);
  console.log('Current Difficulty Multiplier:', multiplier.toFixed(2));
  
  // Progressive jackpot status
  const jackpotReduction = applyProgressiveJackpot(username);
  if (jackpotReduction > 0) {
    console.log('🎉 Progressive Jackpot Active:', jackpotReduction, 'Elo reduction');
  }
  
  // Recent results
  console.log('Recent Results:', casino.results.slice(0, 10).split('').join('-'));
  console.log('Casino Mood:', casino.mood);
  
  console.groupEnd();
  
  return { emotional, casino, multiplier, jackpotReduction };
};

// View audit logs: window.gamblingAudit()
window.gamblingAudit = function(limit = 10) {
  try {
    const raw = localStorage.getItem(GAMBLING_AUDIT_KEY) || '[]';
    const logs = JSON.parse(raw);
    console.table(logs.slice(0, limit));
    return logs.slice(0, limit);
  } catch (e) {
    console.error('[gambling-audit] error:', e);
    return [];
  }
};

// Reset gambling state: window.gamblingReset()
window.gamblingReset = function() {
  if (!username) {
    console.log('[gambling] Not logged in');
    return;
  }
  
  if (confirm('Reset gambling state for ' + username + '?')) {
    localStorage.removeItem(GAMBLING_KEY(username));
    console.log('[gambling] State reset for', username);
    return true;
  }
  return false;
};

// Reset emotional state: window.emotionalReset()
window.emotionalReset = function() {
  if (!username) {
    console.log('[emotional] Not logged in');
    return;
  }
  
  if (confirm('Reset emotional state for ' + username + '?')) {
    localStorage.removeItem(EMOTIONAL_STORAGE_KEY(username));
    console.log('[emotional] State reset for', username);
    return true;
  }
  return false;
};

// Test timing system: window.testTiming()
window.testTiming = function() {
  if (!username) {
    console.log('[timing] Not logged in');
    return;
  }
  
  const playerElo = getUserElo(username);
  const emotional = loadEmotionalState(username);
  
  // Test timing variance by calculating 10 samples
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const baseTime = computeThinkMs();
    const cappedTime = capByClock(baseTime);
    samples.push({ base: baseTime, capped: cappedTime });
  }
  
  console.group('⏱️ TIMING RANDOMNESS TEST');
  console.log('Player:', username);
  console.log('Player Elo:', playerElo);
  console.log('Consecutive Losses:', emotional.consecutiveLosses);
  console.log('Frustration Level:', emotional.frustrationLevel.toFixed(2));
  
  console.log('\n10 Random Timing Samples:');
  samples.forEach((sample, i) => {
    console.log(`Sample ${i+1}: Base=${sample.base}ms, Capped=${sample.capped}ms`);
  });
  
  const avgBase = samples.reduce((sum, s) => sum + s.base, 0) / samples.length;
  const avgCapped = samples.reduce((sum, s) => sum + s.capped, 0) / samples.length;
  const minCapped = Math.min(...samples.map(s => s.capped));
  const maxCapped = Math.max(...samples.map(s => s.capped));
  
  console.log('\nStatistics:');
  console.log('Average Base Time:', Math.round(avgBase) + 'ms');
  console.log('Average Capped Time:', Math.round(avgCapped) + 'ms');
  console.log('Min Capped Time:', minCapped + 'ms');
  console.log('Max Capped Time:', maxCapped + 'ms');
  console.log('Variance Range:', (maxCapped - minCapped) + 'ms');
  
  console.groupEnd();
  
  return { samples, avgBase, avgCapped, minCapped, maxCapped, playerElo, emotional };
};
(function(){ const c=document.getElementById('matrix'); const ctx=c.getContext('2d'); let w,h,columns,drops,fontSize,chars;
  function init(){ w=c.width=window.innerWidth; h=c.height=window.innerHeight; fontSize=Math.max(12,Math.floor(w/90)); columns=Math.floor(w/fontSize); drops=new Array(columns).fill(0).map(()=>Math.floor(Math.random()*-50)); chars='01ABCDEFabcdef'; }
  function draw(){ ctx.fillStyle='rgba(0, 8, 6, 0.15)'; ctx.fillRect(0,0,w,h); ctx.font=fontSize+'px monospace';
    for(let i=0;i<columns;i++){ const ch=chars[Math.floor(Math.random()*chars.length)], g=180+Math.floor(Math.random()*60);
      ctx.fillStyle=`rgba(0, ${g}, 100, ${0.75+Math.random()*0.25})`; const x=i*fontSize,y=drops[i]*fontSize; ctx.fillText(ch,x,y);
      if(y>h && Math.random()>0.975) drops[i]=0; else drops[i]++; } requestAnimationFrame(draw); }
  window.addEventListener('resize',init); init(); draw();
})();

window.addEventListener('beforeunload',()=>{ if(matchStarted){ stopClock(); matchStarted=false; } });

// Center-screen "result" toast helper (not used by endMatch banner)
function showResultToast(result) {
  const toast = document.getElementById('resultToast');
  toast.className = 'toast';
  if (result === 'win') {
    toast.classList.add('win');
    toast.textContent = 'You Won!';
  } else if (result === 'lose') {
    toast.classList.add('lose');
    toast.textContent = 'You Lost!';
  } else {
    toast.textContent = 'Game Over';
  }
  toast.style.display = 'block';
  document.body.classList.add('blur-active');
  setTimeout(() => {
    toast.style.display = 'none';
    document.body.classList.remove('blur-active');
  }, 5000);
}

// Display name will be set after login or generated as guest

/* ===== Feedback System ===== */
const feedbackTextEl = document.getElementById('feedbackText');
const submitFeedbackBtn = document.getElementById('submitFeedbackBtn');
const feedbackMessageEl = document.getElementById('feedbackMessage');

if (submitFeedbackBtn) {
  submitFeedbackBtn.addEventListener('click', async () => {
    const feedback = feedbackTextEl.value.trim();
    
    if (!feedback) {
      feedbackMessageEl.textContent = '⚠️ Please enter your feedback';
      feedbackMessageEl.style.color = '#ff6b6b';
      feedbackMessageEl.style.display = 'block';
      setTimeout(() => {
        feedbackMessageEl.style.display = 'none';
      }, 3000);
      return;
    }
    
    // Disable button while submitting
    submitFeedbackBtn.disabled = true;
    submitFeedbackBtn.textContent = 'Sending...';
    
    try {
      // Send feedback to server
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: displayName || username || 'Guest',
          feedback: feedback,
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent
        })
      });
      
      if (response.ok) {
        feedbackMessageEl.textContent = '✅ Thank you! Feedback submitted successfully.';
        feedbackMessageEl.style.color = 'var(--glow)';
        feedbackMessageEl.style.display = 'block';
        feedbackTextEl.value = ''; // Clear textarea
        
        setTimeout(() => {
          feedbackMessageEl.style.display = 'none';
        }, 5000);
      } else {
        throw new Error('Failed to submit');
      }
    } catch (error) {
      console.error('[FEEDBACK] Error:', error);
      
      // Fallback: save locally if server fails
      const localFeedback = {
        username: displayName || username || 'Guest',
        feedback: feedback,
        timestamp: new Date().toISOString()
      };
      
      // Store in localStorage
      const storedFeedback = JSON.parse(localStorage.getItem('pendingFeedback') || '[]');
      storedFeedback.push(localFeedback);
      localStorage.setItem('pendingFeedback', JSON.stringify(storedFeedback));
      
      feedbackMessageEl.textContent = '✅ Feedback saved locally. Will sync when online.';
      feedbackMessageEl.style.color = 'var(--glow)';
      feedbackMessageEl.style.display = 'block';
      feedbackTextEl.value = '';
      
      setTimeout(() => {
        feedbackMessageEl.style.display = 'none';
      }, 5000);
    } finally {
      // Re-enable button
      submitFeedbackBtn.disabled = false;
      submitFeedbackBtn.textContent = 'Submit Feedback';
    }
  });
}



/* ===== CHESS DATABASE INTEGRATION ===== */
// Global variables for database integration
let userElo = 1500;
let userStats = {};
let currentGameId = null;

// Fetch user stats from database on load
async function fetchUserStats() {
  // Don't fetch if balance update is in progress (prevents race condition)
  if (balanceUpdateInProgress) {
    console.log('[fetchUserStats] ⏸️ Skipping - balance update in progress');
    return;
  }
  
  const authToken = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
  if (!authToken) {
    console.log('[fetchUserStats] ⚠️  No auth token');
    return;
  }
  
  try {
    const response = await fetch(window.location.origin + '/chess/user/stats', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    if (response.ok) {
      const data = await response.json();
      balance = Math.round(data.balance * 100);
      sessionStorage.setItem('balance', data.balance.toFixed(2));
      userElo = data.elo || 1500;
      userStats = { gamesPlayed: data.gamesPlayed || 0, wins: data.wins || 0, losses: data.losses || 0, draws: data.draws || 0 };
      const navBalance = document.getElementById('navBalance');
      if (navBalance) navBalance.textContent = '$' + (balance / 100).toFixed(2);
      console.log('[fetchUserStats] ✅ Balance:', balance / 100, 'ELO:', userElo);
    }
  } catch (error) {
    console.error('[fetchUserStats] Error:', error);
  }
}


// Start game in database
async function startGameInDatabase(betAmount, opponentType) {
  const authToken = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
  if (!authToken) {
    console.log('[startGameInDatabase] ⚠️  No auth token');
    return null;
  }
  
  // Set flag to prevent race condition with fetchUserStats
  balanceUpdateInProgress = true;
  
  try {
    const response = await fetch(window.location.origin + '/chess/game/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        betAmount: betAmount / 100,
        opponentType: opponentType
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      currentGameId = data.gameId;
      balance = Math.round(data.newBalance * 100);
      sessionStorage.setItem('balance', data.newBalance.toFixed(2));
      const navBalance = document.getElementById('navBalance');
      if (navBalance) navBalance.textContent = '$' + data.newBalance.toFixed(2);
      console.log('[startGameInDatabase] ✅ Game started, ID:', currentGameId);
      balanceUpdateInProgress = false; // Clear flag after successful update
      return currentGameId;
    }
  } catch (error) {
    console.error('[startGameInDatabase] Error:', error);
  }
  
  balanceUpdateInProgress = false; // Clear flag even on error
  return null;
}

// Record move to database
async function recordMoveToDatabase(moveNotation, fenAfter) {
  if (!currentGameId) return;
  
  const authToken = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
  if (!authToken) return;
  
  try {
    await fetch(window.location.origin + '/chess/game/move', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        gameId: currentGameId,
        moveNumber: Math.floor(game.history().length / 2) + 1,
        moveNotation: moveNotation,
        fenAfter: fenAfter
      })
    });
  } catch (error) {
    console.error('[recordMoveToDatabase] Error:', error);
  }
}

// End game and update database
async function endGameInDatabase(outcome) {
  if (!currentGameId) {
    console.log('[endGameInDatabase] No gameId, skipping');
    return null;
  }
  
  const authToken = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
  if (!authToken) {
    console.log('[endGameInDatabase] ⚠️  No auth token');
    return null;
  }
  
  // Set flag to prevent race condition with fetchUserStats
  balanceUpdateInProgress = true;
  
  try {
    const response = await fetch(window.location.origin + '/chess/game/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        gameId: currentGameId,
        outcome: outcome,
        finalFen: game.fen()
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      balance = Math.round(data.newBalance * 100);
      sessionStorage.setItem('balance', data.newBalance.toFixed(2));
      userElo = data.newElo;
      const navBalance = document.getElementById('navBalance');
      if (navBalance) navBalance.textContent = '$' + data.newBalance.toFixed(2);
      console.log('[endGameInDatabase] ✅ Game ended. Balance:', data.newBalance, 'ELO:', data.newElo);
      currentGameId = null;
      balanceUpdateInProgress = false; // Clear flag after successful update
      return data;
    }
  } catch (error) {
    console.error('[endGameInDatabase] Error:', error);
  }
  
  balanceUpdateInProgress = false; // Clear flag even on error
  return null;
}

