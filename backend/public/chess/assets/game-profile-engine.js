/**
 * Game Profile Engine
 * Creates a unique profile for each game based on ELO
 * Determines: blunder count, mistake count, inaccuracy count, opening style, middlegame style
 * Uses realistic distributions so some games are clean, others are messy
 */

class GameProfileEngine {
    constructor() {
        this.profile = null;
        this.currentMove = 0;
        this.scheduledBlunders = [];
        this.scheduledMistakes = [];
        this.scheduledInaccuracies = [];
    }

    /**
     * Interpolate between two ELO ranges to get exact statistics for any ELO
     * @param {number} elo - Exact ELO rating
     * @param {Object} ranges - Data for different ELO ranges
     * @returns {Object} - Interpolated statistics
     */
    interpolateEloStats(elo, ranges) {
        // Define range boundaries and their data
        const rangeBounds = [
            { min: 0, max: 800, key: '800-1200', weight: 1.5 }, // Use 800-1200 but amplified for lower
            { min: 800, max: 1200, key: '800-1200', weight: 1.0 },
            { min: 1200, max: 1600, key: '1200-1600', weight: 1.0 },
            { min: 1600, max: 2000, key: '1600-2000', weight: 1.0 },
            { min: 2000, max: 2400, key: '2000-2400', weight: 1.0 },
            { min: 2400, max: 3200, key: '2400+', weight: 1.0 }
        ];

        // Find which range we're in
        let lowerRange, upperRange, ratio;
        
        if (elo < 800) {
            // Below our data - extrapolate from 800-1200 range
            return { key: '800-1200', data: ranges['800-1200'], multiplier: 1.5 };
        } else if (elo >= 2400) {
            // Above 2400 - use 2400+ data
            return { key: '2400+', data: ranges['2400+'], multiplier: 1.0 };
        }

        // Find the two ranges to interpolate between
        for (let i = 0; i < rangeBounds.length - 1; i++) {
            if (elo >= rangeBounds[i].min && elo < rangeBounds[i + 1].min) {
                lowerRange = rangeBounds[i];
                upperRange = rangeBounds[i + 1];
                ratio = (elo - lowerRange.min) / (upperRange.min - lowerRange.min);
                break;
            }
        }

        if (!lowerRange || !upperRange) {
            // Fallback
            return { key: '1200-1600', data: ranges['1200-1600'], multiplier: 1.0 };
        }

        return {
            key: `${lowerRange.key}-${upperRange.key}`,
            lowerData: ranges[lowerRange.key],
            upperData: ranges[upperRange.key],
            ratio: ratio,
            isInterpolated: true
        };
    }

    /**
     * Generate weighted random number of blunders for this game
     * Distribution varies by ELO - some games clean, others messy
     */
    generateBlunderCount(elo) {
        // Define distributions: [0 blunders, 1, 2, 3, 4, 5+] probabilities
        let distribution;
        
        if (elo < 600) {
            // Beginner: rarely clean games, often 4-8 blunders
            distribution = [0.05, 0.10, 0.15, 0.20, 0.25, 0.25]; // avg ~3.5
        } else if (elo < 800) {
            distribution = [0.08, 0.12, 0.18, 0.22, 0.22, 0.18]; // avg ~3.0
        } else if (elo < 1000) {
            distribution = [0.10, 0.15, 0.20, 0.25, 0.20, 0.10]; // avg ~2.6
        } else if (elo < 1200) {
            distribution = [0.15, 0.20, 0.25, 0.20, 0.15, 0.05]; // avg ~2.1
        } else if (elo < 1400) {
            distribution = [0.20, 0.25, 0.25, 0.18, 0.10, 0.02]; // avg ~1.7
        } else if (elo < 1600) {
            distribution = [0.25, 0.30, 0.25, 0.12, 0.06, 0.02]; // avg ~1.4
        } else if (elo < 1800) {
            distribution = [0.30, 0.32, 0.22, 0.10, 0.05, 0.01]; // avg ~1.2
        } else if (elo < 2000) {
            distribution = [0.35, 0.35, 0.18, 0.08, 0.03, 0.01]; // avg ~1.0
        } else if (elo < 2200) {
            distribution = [0.40, 0.35, 0.15, 0.07, 0.02, 0.01]; // avg ~0.9
        } else if (elo < 2400) {
            distribution = [0.45, 0.35, 0.12, 0.05, 0.02, 0.01]; // avg ~0.8
        } else {
            // Grandmaster: mostly clean games, rare blunders
            distribution = [0.60, 0.25, 0.10, 0.03, 0.01, 0.01]; // avg ~0.6
        }

        // Weighted random selection
        const rand = Math.random();
        let cumulative = 0;
        for (let i = 0; i < distribution.length; i++) {
            cumulative += distribution[i];
            if (rand < cumulative) {
                return i === 5 ? Math.floor(Math.random() * 3) + 5 : i; // 5+ means 5-7
            }
        }
        return 2; // Fallback
    }

    /**
     * Generate mistake count (less severe than blunders)
     */
    generateMistakeCount(elo) {
        if (elo < 800) {
            return Math.floor(Math.random() * 4) + 3; // 3-6 mistakes
        } else if (elo < 1200) {
            return Math.floor(Math.random() * 3) + 2; // 2-4 mistakes
        } else if (elo < 1600) {
            return Math.floor(Math.random() * 3) + 1; // 1-3 mistakes
        } else if (elo < 2000) {
            return Math.floor(Math.random() * 2) + 1; // 1-2 mistakes
        } else if (elo < 2400) {
            return Math.random() < 0.6 ? 1 : 0; // 0-1 mistake
        } else {
            return Math.random() < 0.3 ? 1 : 0; // Rarely make mistakes
        }
    }

    /**
     * Generate inaccuracy count (minor suboptimal moves)
     */
    generateInaccuracyCount(elo) {
        if (elo < 800) {
            return Math.floor(Math.random() * 6) + 5; // 5-10 inaccuracies
        } else if (elo < 1200) {
            return Math.floor(Math.random() * 4) + 4; // 4-7 inaccuracies
        } else if (elo < 1600) {
            return Math.floor(Math.random() * 3) + 3; // 3-5 inaccuracies
        } else if (elo < 2000) {
            return Math.floor(Math.random() * 3) + 2; // 2-4 inaccuracies
        } else if (elo < 2400) {
            return Math.floor(Math.random() * 2) + 1; // 1-2 inaccuracies
        } else {
            return Math.random() < 0.7 ? Math.floor(Math.random() * 2) + 1 : 0; // 0-2 inaccuracies
        }
    }

    /**
     * Determine opening book depth (how many moves to follow theory)
     */
    generateOpeningDepth(elo) {
        if (elo < 800) {
            return Math.random() < 0.7 ? Math.floor(Math.random() * 3) + 1 : 0; // Often 0-3 moves
        } else if (elo < 1200) {
            return Math.floor(Math.random() * 4) + 2; // 2-5 moves
        } else if (elo < 1600) {
            return Math.floor(Math.random() * 5) + 3; // 3-7 moves
        } else if (elo < 2000) {
            return Math.floor(Math.random() * 6) + 4; // 4-9 moves
        } else if (elo < 2400) {
            return Math.floor(Math.random() * 8) + 5; // 5-12 moves
        } else {
            return Math.floor(Math.random() * 10) + 6; // 6-15 moves (deep theory)
        }
    }

    /**
     * Determine middlegame pattern usage percentage
     */
    generateMiddlegamePatternRate(elo) {
        if (elo < 800) {
            return 0.15 + Math.random() * 0.15; // 15-30% patterns
        } else if (elo < 1200) {
            return 0.20 + Math.random() * 0.15; // 20-35% patterns
        } else if (elo < 1600) {
            return 0.25 + Math.random() * 0.15; // 25-40% patterns
        } else if (elo < 2000) {
            return 0.20 + Math.random() * 0.15; // 20-35% patterns
        } else if (elo < 2400) {
            return 0.15 + Math.random() * 0.10; // 15-25% patterns
        } else {
            return 0.10 + Math.random() * 0.10; // 10-20% patterns (mostly original play)
        }
    }

    /**
     * Create a complete game profile
     */
    createGameProfile(elo) {
        const blunderCount = this.generateBlunderCount(elo);
        const mistakeCount = this.generateMistakeCount(elo);
        const inaccuracyCount = this.generateInaccuracyCount(elo);
        const openingDepth = this.generateOpeningDepth(elo);
        const middlegamePatternRate = this.generateMiddlegamePatternRate(elo);

        this.profile = {
            elo: elo,
            blunderCount: blunderCount,
            mistakeCount: mistakeCount,
            inaccuracyCount: inaccuracyCount,
            openingDepth: openingDepth,
            middlegamePatternRate: middlegamePatternRate,
            totalErrors: blunderCount + mistakeCount + inaccuracyCount,
            createdAt: Date.now()
        };

        this.currentMove = 0;
        this.scheduledBlunders = [];
        this.scheduledMistakes = [];
        this.scheduledInaccuracies = [];

        console.log(`[Game Profile] Created profile for ${elo} ELO:`);
        console.log(`  - Blunders: ${blunderCount}`);
        console.log(`  - Mistakes: ${mistakeCount}`);
        console.log(`  - Inaccuracies: ${inaccuracyCount}`);
        console.log(`  - Opening depth: ${openingDepth} moves`);
        console.log(`  - Middlegame pattern rate: ${(middlegamePatternRate * 100).toFixed(1)}%`);
        console.log(`  - Total errors: ${this.profile.totalErrors}`);

        return this.profile;
    }

    /**
     * Schedule which specific moves will have blunders
     * Called after we know approximately how long the game will be
     */
    scheduleBlunders(estimatedGameLength = 40) {
        if (!this.profile) return;

        // Don't schedule blunders in first 8 moves (opening theory phase)
        const minMove = 9;
        const maxMove = estimatedGameLength;

        for (let i = 0; i < this.profile.blunderCount; i++) {
            // Random move number between minMove and maxMove
            const moveNumber = Math.floor(Math.random() * (maxMove - minMove)) + minMove;
            this.scheduledBlunders.push(moveNumber);
        }

        this.scheduledBlunders.sort((a, b) => a - b);
        console.log(`[Game Profile] Scheduled ${this.profile.blunderCount} blunders at moves: ${this.scheduledBlunders.join(', ')}`);
    }

    /**
     * Schedule mistakes and inaccuracies similarly
     */
    scheduleAllErrors(estimatedGameLength = 40) {
        this.scheduleBlunders(estimatedGameLength);

        // Schedule mistakes (can be earlier than blunders)
        for (let i = 0; i < this.profile.mistakeCount; i++) {
            const moveNumber = Math.floor(Math.random() * estimatedGameLength) + 5;
            this.scheduledMistakes.push(moveNumber);
        }
        this.scheduledMistakes.sort((a, b) => a - b);

        // Schedule inaccuracies (throughout the game)
        for (let i = 0; i < this.profile.inaccuracyCount; i++) {
            const moveNumber = Math.floor(Math.random() * estimatedGameLength) + 3;
            this.scheduledInaccuracies.push(moveNumber);
        }
        this.scheduledInaccuracies.sort((a, b) => a - b);

        console.log(`[Game Profile] Scheduled ${this.profile.mistakeCount} mistakes at moves: ${this.scheduledMistakes.join(', ')}`);
        console.log(`[Game Profile] Scheduled ${this.profile.inaccuracyCount} inaccuracies at moves: ${this.scheduledInaccuracies.join(', ')}`);
    }

    /**
     * Check if current move should have an error
     */
    shouldBlunderThisMove(moveNumber) {
        const index = this.scheduledBlunders.indexOf(moveNumber);
        if (index !== -1) {
            // Remove from schedule so we don't blunder twice on same move
            this.scheduledBlunders.splice(index, 1);
            return true;
        }
        return false;
    }

    shouldMistakeThisMove(moveNumber) {
        const index = this.scheduledMistakes.indexOf(moveNumber);
        if (index !== -1) {
            this.scheduledMistakes.splice(index, 1);
            return true;
        }
        return false;
    }

    shouldInaccuracyThisMove(moveNumber) {
        const index = this.scheduledInaccuracies.indexOf(moveNumber);
        if (index !== -1) {
            this.scheduledInaccuracies.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Check if we should use opening book for this move
     */
    shouldUseOpeningBook(moveNumber) {
        return this.profile && moveNumber <= this.profile.openingDepth;
    }

    /**
     * Check if we should use middlegame patterns for this move
     */
    shouldUseMiddlegamePattern(moveNumber) {
        if (!this.profile || moveNumber < 11 || moveNumber > 30) {
            return false;
        }
        return Math.random() < this.profile.middlegamePatternRate;
    }

    /**
     * Get current profile
     */
    getProfile() {
        return this.profile;
    }

    /**
     * Reset for new game
     */
    reset() {
        this.profile = null;
        this.currentMove = 0;
        this.scheduledBlunders = [];
        this.scheduledMistakes = [];
        this.scheduledInaccuracies = [];
        // Reset dynamic system tracking
        this.blundersRemaining = 0;
        this.mistakesRemaining = 0;
        this.inaccuraciesRemaining = 0;
        this.usingDynamicSystem = false;
    }

    /**
     * NEW: Initialize error budget system (replaces scheduleAllErrors for dynamic mode)
     * BACKWARDS COMPATIBLE: Old scheduleAllErrors() still works
     */
    initializeErrorBudget(estimatedGameLength = 40) {
        if (!this.profile) {
            console.warn('[Game Profile] No profile created, cannot initialize error budget');
            return;
        }

        // Store error budgets
        this.blundersRemaining = this.profile.blunderCount;
        this.mistakesRemaining = this.profile.mistakeCount;
        this.inaccuraciesRemaining = this.profile.inaccuracyCount;
        this.usingDynamicSystem = true;
        
        console.log(`[Game Profile] Dynamic error system enabled:`);
        console.log(`  - Blunder budget: ${this.blundersRemaining}`);
        console.log(`  - Mistake budget: ${this.mistakesRemaining}`);
        console.log(`  - Inaccuracy budget: ${this.inaccuraciesRemaining}`);
    }

    /**
     * NEW: Dynamic error decision based on position pressure
     * Returns { type, probability, remaining } or { type: 'none' }
     * SAFE: Returns {type: 'none'} if anything fails
     */
    shouldMakeErrorDynamic(moveNumber, pressure) {
        // Safety: fallback to 'none' if system not initialized
        if (!this.profile || !this.usingDynamicSystem) {
            return { type: 'none' };
        }
        
        // Skip opening (moves 1-8)
        if (moveNumber < 9) {
            return { type: 'none' };
        }
        
        // Check if budget exhausted
        if (this.blundersRemaining === 0 && 
            this.mistakesRemaining === 0 && 
            this.inaccuraciesRemaining === 0) {
            return { type: 'none' };
        }
        
        try {
            // Base probabilities (very low per move to avoid flooding)
            let blunderChance = 0.015;   // 1.5% base
            let mistakeChance = 0.04;    // 4% base
            let inaccuracyChance = 0.07; // 7% base
            
            // Modifiers based on pressure (if available)
            if (pressure) {
                // Complexity modifiers
                if (pressure.veryComplex) {
                    blunderChance *= 3.0;
                    mistakeChance *= 2.5;
                    inaccuracyChance *= 1.5;
                } else if (pressure.complex) {
                    blunderChance *= 2.0;
                    mistakeChance *= 1.5;
                    inaccuracyChance *= 1.3;
                }
                
                // Evaluation modifiers (losing = stress)
                if (pressure.losingBadly) {
                    blunderChance *= 2.5;
                    mistakeChance *= 2.0;
                    inaccuracyChance *= 1.5;
                } else if (pressure.losing) {
                    blunderChance *= 1.5;
                    mistakeChance *= 1.3;
                    inaccuracyChance *= 1.2;
                }
                
                // Deteriorating position (panic)
                if (pressure.gettingWorse) {
                    blunderChance *= 1.4;
                    mistakeChance *= 1.2;
                    inaccuracyChance *= 1.1;
                }
            }
            
            // Endgame fatigue (moves 35+)
            if (moveNumber > 35) {
                const fatigue = (moveNumber - 35) / 10;
                blunderChance *= (1 + fatigue * 0.5);
                mistakeChance *= (1 + fatigue * 0.3);
                inaccuracyChance *= (1 + fatigue * 0.2);
            }
            
            // Budget pressure: increase probability if running out of moves
            const gameProgress = moveNumber / 40;
            if (gameProgress > 0.7) {
                const errorsLeft = this.blundersRemaining + this.mistakesRemaining;
                if (errorsLeft > 2) {
                    blunderChance *= 1.5;
                    mistakeChance *= 1.5;
                    inaccuracyChance *= 1.3;
                }
            }
            
            // Cap maximum probabilities (prevent guaranteed errors)
            blunderChance = Math.min(blunderChance, 0.35);    // Max 35%
            mistakeChance = Math.min(mistakeChance, 0.45);    // Max 45%
            inaccuracyChance = Math.min(inaccuracyChance, 0.55); // Max 55%
            
            // Roll dice with priority: blunder > mistake > inaccuracy
            if (this.blundersRemaining > 0 && Math.random() < blunderChance) {
                this.blundersRemaining--;
                return { 
                    type: 'blunder', 
                    probability: blunderChance,
                    remaining: this.blundersRemaining
                };
            }
            
            if (this.mistakesRemaining > 0 && Math.random() < mistakeChance) {
                this.mistakesRemaining--;
                return { 
                    type: 'mistake', 
                    probability: mistakeChance,
                    remaining: this.mistakesRemaining
                };
            }
            
            if (this.inaccuraciesRemaining > 0 && Math.random() < inaccuracyChance) {
                this.inaccuraciesRemaining--;
                return { 
                    type: 'inaccuracy', 
                    probability: inaccuracyChance,
                    remaining: this.inaccuraciesRemaining
                };
            }
            
            return { type: 'none' };
            
        } catch (error) {
            console.error('[Dynamic Error] Calculation failed:', error);
            return { type: 'none' };  // Safe fallback
        }
    }
}

// Export for browser
if (typeof window !== 'undefined') {
    window.GameProfileEngine = GameProfileEngine;
}
