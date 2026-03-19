/* ===== MULTIPLAYER SYSTEM ===== */
// Seamlessly switches between human opponents and computer AI

class MultiplayerManager {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.currentGameId = null;
    this.isMultiplayer = false;
    this.opponentId = null;
    this.matchmakingTimeout = null;
    this.MATCHMAKING_TIMEOUT_MS = 10000; // 10 seconds to find a match
  }

  // Initialize socket connection
  async connect() {
    if (this.connected) {
      console.log('[MULTIPLAYER] Already connected');
      return true;
    }

    try {
      // Get username from multiple possible sources
      let currentUsername = window.username || localStorage.getItem('username');
      
      // If we still don't have it, try to get it from the input field or email
      if (!currentUsername || typeof currentUsername !== 'string') {
        const usernameInput = document.getElementById('username');
        const emailInput = document.getElementById('email');
        currentUsername = usernameInput?.value || emailInput?.value || '';
      }
      
      console.log('[MULTIPLAYER] Username for connection:', currentUsername);
      
      if (!currentUsername || typeof currentUsername !== 'string') {
        console.log('[MULTIPLAYER] No valid username found, cannot connect');
        return false;
      }

      // Use CHESS_API (Railway backend) — window.location.origin would point to
      // Vercel (static host) which does not run Socket.IO
      const serverUrl = window.CHESS_API || window.location.origin;
      
      console.log(`[MULTIPLAYER] Creating socket.io connection to ${serverUrl}`);
      
      // Connect to socket.io server with username authentication
      this.socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
        timeout: 10000,
        auth: {
          username: currentUsername
        }
      });

      return new Promise((resolve, reject) => {
        let resolved = false;
        
        const safeResolve = (value) => {
          if (!resolved) {
            resolved = true;
            resolve(value);
          }
        };
        
        this.socket.on('connect', () => {
          console.log('[MULTIPLAYER] ✅ Connected to server successfully!');
          
          // Authenticate and wait for confirmation
          this.socket.emit('join_user_room', (response) => {
            if (response && response.success) {
              console.log('[MULTIPLAYER] ✅ Authenticated successfully!');
              this.connected = true;
              safeResolve(true);
            } else {
              console.error('[MULTIPLAYER] ❌ Authentication failed:', response?.error);
              this.connected = false;
              safeResolve(false);
            }
          });
        });

        this.socket.on('connect_error', (error) => {
          console.error('[MULTIPLAYER] ❌ Connection error:', error.message);
          this.connected = false;
          safeResolve(false); // Don't reject - just fall back to bot
        });

        this.socket.on('disconnect', () => {
          console.log('[MULTIPLAYER] Disconnected from server');
          this.connected = false;
        });

        // Set up event listeners
        this.setupEventListeners();

        // Timeout after 8 seconds if not authenticated (allows for cold starts)
        setTimeout(() => {
          if (!resolved) {
            console.log('[MULTIPLAYER] ⏱️ Connection/auth timeout after 8 seconds - using bot mode');
            this.connected = false;
            safeResolve(false);
          }
        }, 8000);
      });
    } catch (error) {
      console.error('[MULTIPLAYER] Exception during connect:', error);
      return false;
    }
  }

  setupEventListeners() {
    // Match found
    this.socket.on('match_found', (data) => {
      console.log('[MULTIPLAYER] ========== MATCH FOUND EVENT ==========');
      console.log('[MULTIPLAYER] Raw data received from server:', JSON.stringify(data, null, 2));
      console.log('[MULTIPLAYER] Game ID:', data.id);
      console.log('[MULTIPLAYER] White Player ID:', data.whitePlayerId, typeof data.whitePlayerId);
      console.log('[MULTIPLAYER] Black Player ID:', data.blackPlayerId, typeof data.blackPlayerId);
      
      clearTimeout(this.matchmakingTimeout);
      this.isMultiplayer = true;
      this.currentGameId = data.id; // Fixed: use data.id instead of data.gameId
      
      // Get current user ID (CRITICAL: Check sessionStorage first, then window, then localStorage)
      const currentUserId = window.userId || parseInt(sessionStorage.getItem('userId')) || parseInt(localStorage.getItem('userId'));
      console.log('[MULTIPLAYER] ===== CLIENT SIDE IDENTITY CHECK =====');
      console.log('[MULTIPLAYER] window.username:', window.username);
      console.log('[MULTIPLAYER] sessionStorage.username:', sessionStorage.getItem('username'));
      console.log('[MULTIPLAYER] localStorage.username:', localStorage.getItem('username'));
      console.log('[MULTIPLAYER] window.userId:', window.userId, typeof window.userId);
      console.log('[MULTIPLAYER] sessionStorage.userId:', sessionStorage.getItem('userId'), typeof sessionStorage.getItem('userId'));
      console.log('[MULTIPLAYER] localStorage.userId:', localStorage.getItem('userId'), typeof localStorage.getItem('userId'));
      console.log('[MULTIPLAYER] Final currentUserId:', currentUserId, typeof currentUserId);
      console.log('[MULTIPLAYER] ======================================');
      
      this.opponentId = data.whitePlayerId === currentUserId ? data.blackPlayerId : data.whitePlayerId;
      
      console.log('[MULTIPLAYER] Calculated Opponent ID:', this.opponentId);
      console.log('[MULTIPLAYER] ==========================================');
      
      // Join the game room
      this.socket.emit('join_game', { gameId: data.id }); // Fixed: use data.id
      console.log('[MULTIPLAYER] Joined game room:', data.id);
      
      // Notify the main game that match is ready
      console.log('[MULTIPLAYER] Checking for window.onMatchFound callback...');
      console.log('[MULTIPLAYER] window.onMatchFound exists:', typeof window.onMatchFound);
      
      // Call the app.js callback (handles both normal and rematch cases)
      if (window.onMatchFound) {
        console.log('[MULTIPLAYER] ✅ Calling window.onMatchFound with data:', data);
        window.onMatchFound(data);
      } else {
        console.warn('[MULTIPLAYER] ⚠️ window.onMatchFound is not defined!');
      }
      
      // Also call the findMatch resolve callback if it exists (for normal matchmaking)
      if (this.matchFoundResolve) {
        console.log('[MULTIPLAYER] ✅ Calling matchFoundResolve for findMatch promise');
        this.matchFoundResolve(data);
        this.matchFoundResolve = null; // Clear after use
      }
    });

    // Matchmaking joined (in queue)
    this.socket.on('matchmaking_joined', (data) => {
      console.log('[MULTIPLAYER] Waiting in queue...', data);
    });

    // Matchmaking timeout - fall back to bot
    this.socket.on('matchmaking_timeout', () => {
      console.log('[MULTIPLAYER] No match found, playing vs bot');
      
      // Resolve the pending findMatch promise before canceling
      if (this.matchmakingResolve) {
        this.matchmakingResolve({ multiplayer: false });
        this.matchmakingResolve = null;
      }
      
      this.cancelMatchmaking();
      if (window.onMatchmakingTimeout) {
        window.onMatchmakingTimeout();
      }
    });

    // Opponent move received
    this.socket.on('move_made', (data) => {
      if (data.playerId !== username && window.onOpponentMove) {
        window.onOpponentMove(data);
      }
    });

    // Clock update from server
    this.socket.on('clock_update', (data) => {
      console.log('[MULTIPLAYER] Clock update:', data);
      if (window.onClockUpdate) {
        window.onClockUpdate(data);
      }
    });

    // Game ended
    this.socket.on('game_ended', (data) => {
      console.log('[MULTIPLAYER] Game ended:', data);
      if (window.onGameEnded) {
        window.onGameEnded(data);
      }
    });

    // Draw offered
    this.socket.on('draw_offered', (data) => {
      if (window.onDrawOffered) {
        window.onDrawOffered(data);
      }
    });

    // Draw declined
    this.socket.on('draw_declined', () => {
      statusMsg.textContent = 'Draw declined.';
    });

    // Rematch request received
    this.socket.on('rematch_request', (data) => {
      console.log('[MULTIPLAYER] Rematch request received:', data);
      if (window.onRematchRequest) {
        window.onRematchRequest(data);
      }
    });

    // Rematch sent confirmation
    this.socket.on('rematch_sent', (data) => {
      console.log('[MULTIPLAYER] Rematch request sent:', data);
      const statusMsg = document.getElementById('status-msg');
      if (statusMsg) {
        statusMsg.textContent = `Rematch request sent to ${data.opponentUsername}...`;
      }
    });

    // Rematch declined
    this.socket.on('rematch_declined', (data) => {
      console.log('[MULTIPLAYER] Rematch declined:', data.reason);
      const statusMsg = document.getElementById('status-msg');
      if (statusMsg) {
        statusMsg.textContent = `Rematch declined: ${data.reason}`;
      }
      if (window.onRematchDeclined) {
        window.onRematchDeclined(data);
      }
    });

    // Opponent connected/disconnected
    this.socket.on('player_connected', (data) => {
      console.log('[MULTIPLAYER] Opponent connected');
    });

    this.socket.on('player_disconnected', (data) => {
      console.log('[MULTIPLAYER] Opponent disconnected');
      if (window.onOpponentDisconnected) {
        window.onOpponentDisconnected(data);
      }
    });

    // Errors
    this.socket.on('error', (data) => {
      console.error('[MULTIPLAYER] ========== SERVER ERROR ==========');
      console.error('[MULTIPLAYER] Error message:', data.message);
      console.error('[MULTIPLAYER] Full error data:', data);
      console.error('[MULTIPLAYER] Current game ID:', this.currentGameId);
      console.error('[MULTIPLAYER] Is multiplayer:', this.isMultiplayer);
      console.error('[MULTIPLAYER] ===================================');
    });

    // Rematch requested by opponent
    this.socket.on('rematch_requested', (data) => {
      console.log('[MULTIPLAYER] 🔄 Rematch request from:', data.requesterUsername);
      console.log('[MULTIPLAYER] Bet amount:', data.betAmount);
      
      // Call the existing UI callback (defined in app.js) to show banner with Accept/Decline buttons
      if (window.onRematchRequest) {
        window.onRematchRequest({
          fromUsername: data.requesterUsername,
          fromPlayerId: data.requesterId,
          betAmount: data.betAmount,
          previousWhiteId: data.previousWhiteId,
          previousBlackId: data.previousBlackId
        });
      }
    });

    // Rematch declined by opponent
    this.socket.on('rematch_declined', (data) => {
      console.log('[MULTIPLAYER] ❌ Opponent declined rematch');
      
      // Call the existing UI callback (defined in app.js) to show decline message
      if (window.onRematchDeclined) {
        window.onRematchDeclined({
          reason: data.reason || 'Opponent declined'
        });
      }
    });
  }

  // Try to find a match, fall back to bot after timeout
  async findMatch(betAmount) {
    if (!this.connected) {
      console.log('[MULTIPLAYER] Not connected, playing vs bot immediately');
      return { multiplayer: false };
    }

    this.isMultiplayer = false;
    console.log('[MULTIPLAYER] Starting 10-second matchmaking countdown...');
    const startTime = Date.now();

    return new Promise((resolve) => {
      // Store resolve callback for both timeout and match found scenarios
      this.matchmakingResolve = resolve;
      
      // Set timeout to fall back to bot
      this.matchmakingTimeout = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[MULTIPLAYER] Matchmaking timeout after ${elapsed}ms (expected 5000ms) - playing vs bot`);
        this.cancelMatchmaking();
        if (this.matchmakingResolve) {
          this.matchmakingResolve({ multiplayer: false });
          this.matchmakingResolve = null;
        }
      }, this.MATCHMAKING_TIMEOUT_MS);

      // Store resolve callback for when match is found
      // Don't overwrite window.onMatchFound - it's set up in app.js to handle both normal and rematch cases
      this.matchFoundResolve = (data) => {
        const elapsed = Date.now() - startTime;
        console.log(`[MULTIPLAYER] Match found after ${elapsed}ms!`);
        clearTimeout(this.matchmakingTimeout);
        resolve({ 
          multiplayer: true, 
          gameData: data 
        });
      };

      // Join matchmaking
      console.log(`[MULTIPLAYER] Emitting join_matchmaking with bet $${betAmount / 100}`);
      this.socket.emit('join_matchmaking', { betAmount: betAmount / 100 }); // Convert cents to dollars
    });
  }

  cancelMatchmaking() {
    if (this.socket && this.connected) {
      this.socket.emit('leave_matchmaking');
    }
    clearTimeout(this.matchmakingTimeout);
    this.isMultiplayer = false;
  }

  // Send a move to opponent
  sendMove(move) {
    if (this.isMultiplayer && this.currentGameId) {
      this.socket.emit('make_move', {
        gameId: this.currentGameId,
        move: {
          from: move.from,
          to: move.to,
          promotion: move.promotion
        }
      });
    }
  }

  // Offer draw
  offerDraw() {
    if (this.isMultiplayer && this.currentGameId) {
      this.socket.emit('offer_draw', {
        gameId: this.currentGameId
      });
    }
  }

  // Respond to draw offer
  respondToDraw(accepted) {
    if (this.isMultiplayer && this.currentGameId) {
      this.socket.emit('respond_draw', {
        gameId: this.currentGameId,
        accepted: accepted
      });
    }
  }

  // Resign game
  resign() {
    console.log('[MULTIPLAYER] resign() called');
    console.log('[MULTIPLAYER] this.isMultiplayer:', this.isMultiplayer);
    console.log('[MULTIPLAYER] this.currentGameId:', this.currentGameId);
    console.log('[MULTIPLAYER] this.connected:', this.connected);
    
    if (this.isMultiplayer && this.currentGameId) {
      console.log('[MULTIPLAYER] ✅ Emitting resign event with gameId:', this.currentGameId);
      this.socket.emit('resign', {
        gameId: this.currentGameId
      });
    } else {
      console.log('[MULTIPLAYER] ❌ Cannot resign - conditions not met');
    }
  }

  // Request rematch
  requestRematch(opponentId, betAmount, previousWhiteId, previousBlackId) {
    if (this.socket && this.connected) {
      console.log(`[MULTIPLAYER] Requesting rematch with ${opponentId} for $${betAmount}`);
      console.log(`[MULTIPLAYER] Previous colors - White: ${previousWhiteId}, Black: ${previousBlackId}`);
      this.socket.emit('request_rematch', {
        opponentId: opponentId,
        betAmount: betAmount,
        previousWhiteId: previousWhiteId,
        previousBlackId: previousBlackId
      });
    }
  }

  // Respond to rematch request
  respondRematch(accepted, requesterId, betAmount, previousWhiteId, previousBlackId) {
    if (this.socket && this.connected) {
      console.log(`[MULTIPLAYER] Responding to rematch: ${accepted}`);
      console.log(`[MULTIPLAYER] Color swap - Previous White: ${previousWhiteId}, Previous Black: ${previousBlackId}`);
      this.socket.emit('respond_rematch', {
        accepted: accepted,
        requesterId: requesterId,
        betAmount: betAmount,
        previousWhiteId: previousWhiteId,
        previousBlackId: previousBlackId
      });
    }
  }

  // End game cleanup
  endGame() {
    if (this.currentGameId) {
      this.socket.emit('leave_game');
      this.currentGameId = null;
    }
    // Don't clear isMultiplayer and opponentId immediately - keep for rematch
    // They will be cleared when a new game starts or user goes back to menu
    // this.isMultiplayer = false;
    // this.opponentId = null;
  }

  // Clear all game state (called when returning to menu or starting new game)
  clearGameState() {
    this.currentGameId = null;
    this.isMultiplayer = false;
    this.opponentId = null;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.connected = false;
    }
  }
}

// Global multiplayer instance - attach to window for global access
window.multiplayer = new MultiplayerManager();
console.log('[MULTIPLAYER] Manager initialized and attached to window');
