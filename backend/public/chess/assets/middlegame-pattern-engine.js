/**
 * Middlegame Pattern Engine
 * Uses real game patterns from 30K+ games to make computer play more human-like
 * Active during moves 11-30 (after opening book, before endgame)
 */

class MiddlegamePatternEngine {
    constructor() {
        this.patterns = null;
        this.loaded = false;
    }

    async loadPatterns() {
        try {
            console.log('[Middlegame] Loading from /game-patterns.json...');
            const response = await fetch('/game-patterns.json');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            this.patterns = await response.json();
            this.loaded = true;
            console.log('[Middlegame] Loaded successfully, ELO ranges:', Object.keys(this.patterns));
            return true;
        } catch (error) {
            console.error('[Middlegame] Failed to load patterns:', error);
            this.loaded = false;
            return false;
        }
    }

    /**
     * Get ELO range for given rating
     */
    getEloRange(elo) {
        if (elo < 1200) return '800-1200';
        if (elo < 1600) return '1200-1600';
        if (elo < 2000) return '1600-2000';
        if (elo < 2400) return '2000-2400';
        return '2400+';
    }

    /**
     * Check if we should use a common human move pattern
     * Returns move object if pattern should be used, null otherwise
     */
    shouldUsePattern(game, elo, moveCount) {
        if (!this.loaded || !this.patterns) {
            return null;
        }

        // Only active in middlegame (moves 11-30)
        if (moveCount < 11 || moveCount > 30) {
            return null;
        }

        const eloRange = this.getEloRange(elo);
        const patternData = this.patterns[eloRange];
        
        if (!patternData || !patternData.middlegame) {
            return null;
        }

        // Get legal moves
        const legalMoves = game.moves({ verbose: true });
        if (legalMoves.length === 0) {
            return null;
        }

        // Get common human moves from database
        const commonMoves = patternData.middlegame.common_moves || [];
        
        // Find matching moves between legal moves and common patterns
        const matchingMoves = [];
        for (const move of legalMoves) {
            const san = move.san;
            const pattern = commonMoves.find(cm => cm.move === san);
            if (pattern) {
                matchingMoves.push({
                    move: move,
                    frequency: pattern.frequency,
                    count: pattern.count
                });
            }
        }

        if (matchingMoves.length === 0) {
            return null;
        }

        // Calculate probability based on ELO
        // Lower ELO = more likely to follow common human patterns
        // Higher ELO = more engine-like thinking
        let patternProbability;
        if (elo < 1200) {
            patternProbability = 0.30; // 30% chance for low ELO
        } else if (elo < 1600) {
            patternProbability = 0.25; // 25% chance
        } else if (elo < 2000) {
            patternProbability = 0.20; // 20% chance
        } else {
            patternProbability = 0.15; // 15% chance for high ELO
        }

        // Random check if we should use pattern
        if (Math.random() > patternProbability) {
            return null;
        }

        // Weight moves by frequency (higher frequency = more likely)
        const totalFrequency = matchingMoves.reduce((sum, m) => sum + m.frequency, 0);
        let random = Math.random() * totalFrequency;
        
        for (const matching of matchingMoves) {
            random -= matching.frequency;
            if (random <= 0) {
                console.log(`[Middlegame] Move ${Math.floor(moveCount / 2) + 1}: Using human pattern "${matching.move.san}" (${(matching.frequency * 100).toFixed(1)}% frequency, ${matching.count} occurrences in ${eloRange} ELO games)`);
                return matching.move;
            }
        }

        // Fallback to first move
        const selected = matchingMoves[0];
        console.log(`[Middlegame] Move ${Math.floor(moveCount / 2) + 1}: Using human pattern "${selected.move.san}" (${(selected.frequency * 100).toFixed(1)}% frequency, ${selected.count} occurrences in ${eloRange} ELO games)`);
        return selected.move;
    }

    /**
     * Get a pattern move directly without probability check
     * Used by game profile system when pattern is scheduled
     */
    getPatternMove(game, elo, moveNumber) {
        if (!this.loaded || !this.patterns) {
            return null;
        }

        // Only use patterns in middlegame (moves 11-30)
        if (moveNumber < 11 || moveNumber > 30) {
            return null;
        }

        const currentPosition = game.history({ verbose: false }).join(' ');
        const eloRange = this.getEloRange(elo);
        const patternData = this.patterns[eloRange];
        
        if (!patternData || !patternData.common_moves) {
            return null;
        }

        // Find matching positions
        const matchingMoves = [];
        for (const [position, data] of Object.entries(patternData.common_moves)) {
            if (currentPosition.endsWith(position)) {
                for (const [move, count] of Object.entries(data.moves)) {
                    const moveObj = game.move(move);
                    if (moveObj) {
                        matchingMoves.push({
                            move: { from: moveObj.from, to: moveObj.to, promotion: moveObj.promotion },
                            count: count,
                            frequency: count / data.total
                        });
                        game.undo();
                    }
                }
                break;
            }
        }

        if (matchingMoves.length === 0) {
            return null;
        }

        // Weighted random selection
        const totalFrequency = matchingMoves.reduce((sum, m) => sum + m.frequency, 0);
        let random = Math.random() * totalFrequency;
        
        for (const matching of matchingMoves) {
            random -= matching.frequency;
            if (random <= 0) {
                console.log(`[Middlegame] Move ${moveNumber}: Using scheduled pattern "${matching.move.from}${matching.move.to}" (${(matching.frequency * 100).toFixed(1)}% frequency)`);
                return matching.move;
            }
        }

        // Fallback
        return matchingMoves[0].move;
    }

    /**
     * Analyze piece activity to see if play is human-like
     * This can be used for logging/debugging
     */
    analyzePieceActivity(game, elo) {
        if (!this.loaded || !this.patterns) {
            return null;
        }

        const eloRange = this.getEloRange(elo);
        const patternData = this.patterns[eloRange];
        
        if (!patternData || !patternData.middlegame) {
            return null;
        }

        const activity = patternData.middlegame.piece_activity;
        return {
            mostActive: Object.keys(activity).sort((a, b) => activity[b] - activity[a]),
            activity: activity
        };
    }

    /**
     * Get statistics about common moves for logging
     */
    getCommonMovesStats(elo) {
        if (!this.loaded || !this.patterns) {
            return null;
        }

        const eloRange = this.getEloRange(elo);
        const patternData = this.patterns[eloRange];
        
        if (!patternData) {
            return null;
        }

        return {
            eloRange: eloRange,
            avgGameLength: patternData.statistics.avg_game_length,
            totalGames: patternData.statistics.games,
            topMoves: patternData.middlegame.common_moves.slice(0, 10).map(m => ({
                move: m.move,
                frequency: (m.frequency * 100).toFixed(1) + '%'
            }))
        };
    }
}

// Export class to window
window.MiddlegamePatternEngine = MiddlegamePatternEngine;
