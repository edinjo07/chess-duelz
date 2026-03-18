/**
 * Opening Book Engine
 * Uses real game data from Lichess database to make human-like opening moves
 */

class OpeningBookEngine {
    constructor() {
        this.openingBook = null;
        this.loaded = false;
    }

    async loadOpeningBook() {
        try {
            console.log('[Opening Book] Loading from /opening-book.json...');
            const response = await fetch('/opening-book.json');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            this.openingBook = await response.json();
            this.loaded = true;
            console.log('[Opening Book] Loaded successfully, ELO ranges:', Object.keys(this.openingBook));
            return true;
        } catch (error) {
            console.error('[Opening Book] Failed to load:', error);
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
     * Get move from opening book based on current position
     * @param {Array} moveHistory - Array of moves in algebraic notation
     * @param {number} elo - Player ELO rating
     * @returns {string|null} - Move in algebraic notation or null if not in book
     */
    getBookMove(moveHistory, elo) {
        console.log('[Opening Book] getBookMove called:', { moveHistory, elo, loaded: this.loaded });
        
        if (!this.loaded || !this.openingBook) {
            console.log('[Opening Book] Not loaded or no book data');
            return null;
        }

        const moveNumber = moveHistory.length + 1;
        
        // Only use opening book for first 10 moves
        if (moveNumber > 10) {
            console.log('[Opening Book] Beyond move 10, not using book');
            return null;
        }

        const eloRange = this.getEloRange(elo);
        const rangeData = this.openingBook[eloRange];

        if (!rangeData) {
            console.log(`[Opening Book] No data for ELO range: ${eloRange}`);
            return null;
        }

        const moveKey = `move_${moveNumber}`;
        const positions = rangeData[moveKey];

        if (!positions || positions.length === 0) {
            console.log(`[Opening Book] No positions for ${moveKey}`);
            return null;
        }

        // Build current position string
        const currentPosition = moveHistory.join(' ');
        console.log('[Opening Book] Current position:', currentPosition);

        // Find matching positions in the book
        const matches = positions.filter(pos => 
            pos.position.startsWith(currentPosition)
        );

        console.log(`[Opening Book] Found ${matches.length} matching positions`);

        if (matches.length === 0) {
            return null;
        }

        // Weight by frequency for realistic variation
        const move = this.weightedRandomSelect(matches);
        
        // Extract just the next move
        const nextMove = move.position
            .substring(currentPosition.length)
            .trim()
            .split(' ')[0];

        console.log(`[Opening Book] Move ${moveNumber} for ${eloRange} ELO: ${nextMove} (${(move.frequency * 100).toFixed(1)}%)`);
        
        return nextMove;
    }

    /**
     * Select move weighted by frequency
     */
    weightedRandomSelect(matches) {
        const totalFreq = matches.reduce((sum, m) => sum + m.frequency, 0);
        let random = Math.random() * totalFreq;
        
        for (const match of matches) {
            random -= match.frequency;
            if (random <= 0) {
                return match;
            }
        }
        
        return matches[0];
    }

    /**
     * Convert algebraic notation to UCI format
     */
    algebraicToUCI(game, algebraicMove) {
        // Handle castling
        if (algebraicMove === 'O-O') {
            return game.turn() === 'w' ? 'e1g1' : 'e8g8';
        }
        if (algebraicMove === 'O-O-O') {
            return game.turn() === 'w' ? 'e1c1' : 'e8c8';
        }

        // Try the move
        const move = game.move(algebraicMove, { sloppy: true });
        if (move) {
            const uci = move.from + move.to + (move.promotion || '');
            game.undo(); // Undo the test move
            return uci;
        }

        return null;
    }

    /**
     * Get best move using opening book or fall back to engine
     */
    async getBestMove(game, elo, engineFallback) {
        const history = game.history();
        
        // Try opening book first
        const bookMove = this.getBookMove(history, elo);
        
        if (bookMove) {
            // Convert to UCI format
            const uci = this.algebraicToUCI(game, bookMove);
            if (uci) {
                console.log(`[Opening Book] Using book move: ${bookMove} (${uci})`);
                return { from: uci.substring(0, 2), to: uci.substring(2, 4) };
            }
        }

        // Fall back to chess engine
        console.log('[Opening Book] No book move, using engine');
        return await engineFallback();
    }
}

// Export for browser
if (typeof window !== 'undefined') {
    window.OpeningBookEngine = OpeningBookEngine;
}
