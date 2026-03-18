/**
 * Blunder Engine
 * Injects realistic human mistakes based on ELO-specific error rates
 */

class BlunderEngine {
    constructor() {
        this.blunderPatterns = null;
        this.loaded = false;
    }

    async loadBlunderPatterns() {
        try {
            console.log('[Blunder Engine] Loading from /blunder-patterns.json...');
            const response = await fetch('/blunder-patterns.json');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            this.blunderPatterns = await response.json();
            this.loaded = true;
            console.log('[Blunder Engine] Loaded successfully, ELO ranges:', Object.keys(this.blunderPatterns));
            return true;
        } catch (error) {
            console.error('[Blunder Engine] Failed to load:', error);
            return false;
        }
    }

    getEloRange(elo) {
        if (elo < 800) return '800-1200';
        if (elo < 1200) return '800-1200';
        if (elo < 1600) return '1200-1600';
        if (elo < 2000) return '1600-2000';
        if (elo < 2400) return '2000-2400';
        return '2400+';
    }

    /**
     * Determine if current move should be a blunder
     * @param {number} elo - Player ELO rating
     * @param {number} moveNumber - Current move number in game
     * @returns {boolean} - Whether to inject a blunder
     */
    shouldBlunder(elo, moveNumber) {
        if (!this.loaded || !this.blunderPatterns) {
            return false;
        }

        const eloRange = this.getEloRange(elo);
        const patterns = this.blunderPatterns[eloRange];
        
        if (!patterns || !patterns.error_injection_config) {
            return false;
        }

        // Base blunder probability - adjusted by ELO
        let baseProb = patterns.error_injection_config.blunder_probability;
        
        // Scale blunder rate based on skill level
        if (elo < 800) {
            baseProb *= 1.4; // 40% increase for beginners (21% base)
        } else if (elo >= 2400) {
            baseProb *= 0.4; // 60% reduction for elite players (6% base)
        } else if (elo >= 2000) {
            baseProb *= 0.5; // 50% reduction for advanced players (7.5% base)
        } else if (elo >= 1600) {
            baseProb *= 0.7; // 30% reduction for intermediate players (10.5% base)
        } else if (elo >= 1200) {
            baseProb *= 0.85; // 15% reduction for improving players (12.75% base)
        }
        // else: 800-1200 keeps 15% base
        
        // Slightly increase blunder rate in opening (moves 1-10) and endgame (moves 30+)
        let adjustedProb = baseProb;
        if (moveNumber <= 10) {
            adjustedProb *= 1.2; // 20% more mistakes in opening
        } else if (moveNumber >= 30) {
            adjustedProb *= 1.3; // 30% more mistakes in complex endgames
        }

        const shouldBlunder = Math.random() < adjustedProb;
        
        if (shouldBlunder) {
            console.log(`[Blunder Engine] Move ${moveNumber}: Injecting blunder for ${eloRange} ELO (probability: ${(adjustedProb * 100).toFixed(1)}%)`);
        }
        
        return shouldBlunder;
    }

    /**
     * Get a blunder move from available legal moves
     * Instead of best move, return 2nd or 3rd best move
     * @param {Object} game - Chess.js game instance
     * @param {Object} bestMove - The engine's best move {from, to, promotion}
     * @param {number} elo - Player ELO rating
     * @returns {Object|null} - Alternative (worse) move, or null if no alternatives
     */
    async getBlunderMove(game, bestMove, elo) {
        if (!this.loaded || !this.blunderPatterns) {
            return null;
        }

        const eloRange = this.getEloRange(elo);
        const legalMoves = game.moves({ verbose: true });
        
        if (legalMoves.length <= 1) {
            // Only one legal move, can't blunder
            return null;
        }

        // Filter out the best move
        const alternatives = legalMoves.filter(move => 
            !(move.from === bestMove.from && move.to === bestMove.to)
        );

        if (alternatives.length === 0) {
            return null;
        }

        // For lower ELOs, sometimes pick random moves (more chaotic)
        // For higher ELOs, pick moves that look reasonable but are inferior
        let blunderMove;
        
        if (elo < 800) {
            // Beginner ELO: 80% chance of random move, 20% chance of semi-reasonable
            if (Math.random() < 0.8) {
                // Pick a completely random move (beginners make wild mistakes)
                blunderMove = alternatives[Math.floor(Math.random() * alternatives.length)];
                console.log(`[Blunder Engine] ${eloRange}: Beginner random blunder ${blunderMove.san}`);
            } else {
                // Pick from first few alternatives
                const semiReasonable = alternatives.slice(0, Math.min(8, alternatives.length));
                blunderMove = semiReasonable[Math.floor(Math.random() * semiReasonable.length)];
                console.log(`[Blunder Engine] ${eloRange}: Beginner semi-reasonable blunder ${blunderMove.san}`);
            }
        } else if (elo < 1200) {
            // Low ELO: 60% chance of random move, 40% chance of 2nd best
            if (Math.random() < 0.6) {
                // Pick a random move
                blunderMove = alternatives[Math.floor(Math.random() * alternatives.length)];
                console.log(`[Blunder Engine] ${eloRange}: Random blunder ${blunderMove.san}`);
            } else {
                // Pick from first few alternatives (semi-reasonable moves)
                const semiReasonable = alternatives.slice(0, Math.min(5, alternatives.length));
                blunderMove = semiReasonable[Math.floor(Math.random() * semiReasonable.length)];
                console.log(`[Blunder Engine] ${eloRange}: Semi-reasonable blunder ${blunderMove.san}`);
            }
        } else if (elo < 1600) {
            // Mid ELO: Pick from top 3-7 alternatives (looks plausible but wrong)
            const plausible = alternatives.slice(0, Math.min(7, alternatives.length));
            blunderMove = plausible[Math.floor(Math.random() * plausible.length)];
            console.log(`[Blunder Engine] ${eloRange}: Plausible blunder ${blunderMove.san}`);
        } else if (elo < 2000) {
            // Mid-high ELO (1600-2000): Pick from top 3-7 alternatives (looks plausible but wrong)
            const plausible = alternatives.slice(0, Math.min(7, alternatives.length));
            blunderMove = plausible[Math.floor(Math.random() * plausible.length)];
            console.log(`[Blunder Engine] ${eloRange}: Plausible alternative ${blunderMove.san}`);
        } else if (elo < 2400) {
            // Advanced ELO (2000-2400): Pick from top 2-4 alternatives (subtle mistakes)
            const subtle = alternatives.slice(0, Math.min(4, alternatives.length));
            blunderMove = subtle[Math.floor(Math.random() * subtle.length)];
            console.log(`[Blunder Engine] ${eloRange}: Subtle alternative ${blunderMove.san}`);
        } else {
            // Elite ELO (2400+): DISABLE tactical blunders entirely
            // These players make positional inaccuracies, not tactical blunders
            console.log(`[Blunder Engine] ${eloRange}: Skipping tactical blunder for elite ELO (2400+)`);
            return null;
        }

        return {
            from: blunderMove.from,
            to: blunderMove.to,
            promotion: blunderMove.promotion
        };
    }

    /**
     * Get blunder statistics for an ELO range
     */
    getBlunderStats(elo) {
        if (!this.loaded || !this.blunderPatterns) {
            return null;
        }

        const eloRange = this.getEloRange(elo);
        return this.blunderPatterns[eloRange];
    }
}

// Export for browser
if (typeof window !== 'undefined') {
    window.BlunderEngine = BlunderEngine;
}
