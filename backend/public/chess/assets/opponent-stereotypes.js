/**
 * OPPONENT STEREOTYPES SYSTEM
 * Maps calculated ELO ratings to distinct opponent personalities
 * WITHOUT changing any existing ELO calculation logic
 */

// Stereotype definitions organized by ELO ranges
const OPPONENT_STEREOTYPES = {
  // 400-800: Complete Beginners
  BEGINNER: {
    eloRange: [400, 800],
    centerElo: 600,
    stereotypes: [
      {
        name: 'The Confused Novice',
        elo: 600,
        description: 'Still learning the rules',
        thinkTimeMultiplier: 1.8
      },
      {
        name: 'The Impulsive Kid',
        elo: 700,
        description: 'Moves without thinking',
        thinkTimeMultiplier: 0.4
      },
      {
        name: 'The Pattern Memorizer',
        elo: 650,
        description: 'Knows a few opening moves',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Checker Player',
        elo: 550,
        description: 'Treats chess like checkers',
        thinkTimeMultiplier: 1.5
      },
      {
        name: 'The Piece Hanger',
        elo: 450,
        description: 'Leaves pieces hanging constantly',
        thinkTimeMultiplier: 0.6
      },
      {
        name: 'The One-Move Thinker',
        elo: 500,
        description: 'Never looks ahead',
        thinkTimeMultiplier: 0.5
      },
      {
        name: 'The Queen Chaser',
        elo: 580,
        description: 'Obsessed with getting the queen',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Pawn Pusher',
        elo: 620,
        description: 'Only knows how to push pawns',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Mouse Fumbler',
        elo: 480,
        description: 'Struggles with the interface',
        thinkTimeMultiplier: 2.0
      },
      {
        name: 'The Scholar\'s Mate Hopeful',
        elo: 520,
        description: 'Tries the same trap every game',
        thinkTimeMultiplier: 0.7
      }
    ]
  },
  
  // 800-1200: Casual Players
  CASUAL: {
    eloRange: [800, 1200],
    centerElo: 1000,
    stereotypes: [
      {
        name: 'The Weekend Warrior',
        elo: 1000,
        description: 'Plays for fun on weekends',
        thinkTimeMultiplier: 1.3
      },
      {
        name: 'The Coffee Shop Player',
        elo: 950,
        description: 'Casual but thoughtful',
        thinkTimeMultiplier: 1.6
      },
      {
        name: 'The Aggressive Attacker',
        elo: 1100,
        description: 'Always on the offensive',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Nervous Defender',
        elo: 900,
        description: 'Plays it safe',
        thinkTimeMultiplier: 1.4
      },
      {
        name: 'The Lunch Break Player',
        elo: 850,
        description: 'Squeezes in games at work',
        thinkTimeMultiplier: 0.6
      },
      {
        name: 'The YouTube Student',
        elo: 1050,
        description: 'Learned from online videos',
        thinkTimeMultiplier: 1.1
      },
      {
        name: 'The Park Regular',
        elo: 980,
        description: 'Plays speed chess in the park',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Overconfident Amateur',
        elo: 1150,
        description: 'Thinks they\'re better than they are',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Material Counter',
        elo: 920,
        description: 'Only cares about piece value',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Streamer Wannabe',
        elo: 1080,
        description: 'Dreams of chess fame',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Comeback Veteran',
        elo: 1120,
        description: 'Returning after years away',
        thinkTimeMultiplier: 1.5
      },
      {
        name: 'The Mobile Gamer',
        elo: 880,
        description: 'Only plays on their phone',
        thinkTimeMultiplier: 0.8
      }
    ]
  },
  
  // 1200-1600: Intermediate Players
  INTERMEDIATE: {
    eloRange: [1200, 1600],
    centerElo: 1400,
    stereotypes: [
      {
        name: 'The Book Opener',
        elo: 1400,
        description: 'Strong in openings',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Tactical Hunter',
        elo: 1500,
        description: 'Looks for combinations',
        thinkTimeMultiplier: 1.1
      },
      {
        name: 'The Positional Grinder',
        elo: 1350,
        description: 'Slow and strategic',
        thinkTimeMultiplier: 1.5
      },
      {
        name: 'The Time Scrambler',
        elo: 1450,
        description: 'Strong but time trouble prone',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Club Champion',
        elo: 1550,
        description: 'Best at their local club',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Puzzle Master',
        elo: 1480,
        description: 'Great at tactics, weak at strategy',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Opening Trapper',
        elo: 1420,
        description: 'Knows all the traps',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Counter-Attacker',
        elo: 1380,
        description: 'Waits for mistakes then strikes',
        thinkTimeMultiplier: 1.3
      },
      {
        name: 'The Blunder Capitalizer',
        elo: 1320,
        description: 'Solid until they find an error',
        thinkTimeMultiplier: 1.1
      },
      {
        name: 'The Preparation Fanatic',
        elo: 1520,
        description: 'Studies every opponent',
        thinkTimeMultiplier: 1.4
      },
      {
        name: 'The Calculation Beast',
        elo: 1460,
        description: 'Calculates deep variations',
        thinkTimeMultiplier: 1.6
      },
      {
        name: 'The Online Grinder',
        elo: 1290,
        description: 'Plays hundreds of games monthly',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Strategic Thinker',
        elo: 1410,
        description: 'Understands plans and structure',
        thinkTimeMultiplier: 1.3
      },
      {
        name: 'The King\'s Indian Fighter',
        elo: 1530,
        description: 'Specialist in sharp positions',
        thinkTimeMultiplier: 1.0
      }
    ]
  },
  
  // 1600-2000: Advanced Players
  ADVANCED: {
    eloRange: [1600, 2000],
    centerElo: 1800,
    stereotypes: [
      {
        name: 'The Theory Master',
        elo: 1800,
        description: 'Deep opening preparation',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Endgame Specialist',
        elo: 1750,
        description: 'Converts small advantages',
        thinkTimeMultiplier: 1.3
      },
      {
        name: 'The Blitz Demon',
        elo: 1850,
        description: 'Fast and sharp',
        thinkTimeMultiplier: 0.5
      },
      {
        name: 'The Solid Defender',
        elo: 1700,
        description: 'Hard to break down',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Tournament Veteran',
        elo: 1920,
        description: 'Years of OTB experience',
        thinkTimeMultiplier: 1.1
      },
      {
        name: 'The Sicilian Expert',
        elo: 1880,
        description: 'Najdorf specialist',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Prophylactic Player',
        elo: 1820,
        description: 'Prevents all threats first',
        thinkTimeMultiplier: 1.4
      },
      {
        name: 'The Attack Artist',
        elo: 1780,
        description: 'Sacrifices for initiative',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Petrosian Student',
        elo: 1650,
        description: 'Defensive genius',
        thinkTimeMultiplier: 1.5
      },
      {
        name: 'The Ambitious Master',
        elo: 1960,
        description: 'Pushing for expert title',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Computer Analyzer',
        elo: 1840,
        description: 'Studies every game with engines',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Rapid Specialist',
        elo: 1720,
        description: 'Thrives in faster time controls',
        thinkTimeMultiplier: 0.6
      },
      {
        name: 'The Pawn Structure Expert',
        elo: 1790,
        description: 'Understands every formation',
        thinkTimeMultiplier: 1.3
      },
      {
        name: 'The Practical Player',
        elo: 1860,
        description: 'Plays the position, not theory',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Chess Coach',
        elo: 1680,
        description: 'Teaches but rarely plays',
        thinkTimeMultiplier: 1.4
      },
      {
        name: 'The Rating Climber',
        elo: 1940,
        description: 'On a hot streak',
        thinkTimeMultiplier: 0.8
      }
    ]
  },
  
  // 2000-2400: Expert Players
  EXPERT: {
    eloRange: [2000, 2400],
    centerElo: 2200,
    stereotypes: [
      {
        name: 'The Tournament Player',
        elo: 2200,
        description: 'Consistent and reliable',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Calculation Machine',
        elo: 2250,
        description: 'Deep tactical vision',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Prophylactic Master',
        elo: 2150,
        description: 'Prevents all threats',
        thinkTimeMultiplier: 1.1
      },
      {
        name: 'The Pressure Cooker',
        elo: 2300,
        description: 'Makes opponents uncomfortable',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The FIDE Master',
        elo: 2280,
        description: 'Officially titled player',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Opening Innovator',
        elo: 2180,
        description: 'Creates new theory',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Grinding Expert',
        elo: 2220,
        description: 'Tortures opponents slowly',
        thinkTimeMultiplier: 1.4
      },
      {
        name: 'The Dynamic Player',
        elo: 2260,
        description: 'Creates imbalances',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Endgame Virtuoso',
        elo: 2320,
        description: 'Wins drawn positions',
        thinkTimeMultiplier: 1.3
      },
      {
        name: 'The Psychological Warrior',
        elo: 2140,
        description: 'Plays the opponent',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Tal Admirer',
        elo: 2190,
        description: 'Sacrifices everywhere',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Carlsen Clone',
        elo: 2340,
        description: 'Universal style',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Classical Master',
        elo: 2160,
        description: 'Plays like Capablanca',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Time Management Pro',
        elo: 2210,
        description: 'Never in time trouble',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Repertoire Specialist',
        elo: 2270,
        description: 'Knows their systems cold',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Chess Professional',
        elo: 2380,
        description: 'Makes a living from chess',
        thinkTimeMultiplier: 1.0
      }
    ]
  },
  
  // 2400+: Master Level
  MASTER: {
    eloRange: [2400, 3000],
    centerElo: 2600,
    stereotypes: [
      {
        name: 'The Titled Player',
        elo: 2600,
        description: 'Near-perfect play',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Computer-like Bot',
        elo: 2700,
        description: 'Clinical and precise',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Style Specialist',
        elo: 2550,
        description: 'Master of certain positions',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Endgame Virtuoso',
        elo: 2650,
        description: 'Converts any advantage',
        thinkTimeMultiplier: 1.1
      },
      {
        name: 'The International Master',
        elo: 2480,
        description: 'One step from GM',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Grandmaster',
        elo: 2580,
        description: 'Among the elite',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Super GM',
        elo: 2750,
        description: 'World championship contender',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Opening Theoretician',
        elo: 2520,
        description: 'Knows theory to move 30',
        thinkTimeMultiplier: 1.0
      },
      {
        name: 'The Blitz World Champion',
        elo: 2680,
        description: 'Untouchable in speed chess',
        thinkTimeMultiplier: 0.5
      },
      {
        name: 'The Universal Player',
        elo: 2620,
        description: 'No weaknesses',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The Positional Genius',
        elo: 2560,
        description: 'Crushes with technique',
        thinkTimeMultiplier: 1.2
      },
      {
        name: 'The Tactical Monster',
        elo: 2640,
        description: 'Sees everything',
        thinkTimeMultiplier: 0.8
      },
      {
        name: 'The Chess Legend',
        elo: 2800,
        description: 'Hall of fame player',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Preparation King',
        elo: 2500,
        description: 'Hours of prep for every game',
        thinkTimeMultiplier: 1.1
      },
      {
        name: 'The Titled Tuesday Winner',
        elo: 2720,
        description: 'Online tournament specialist',
        thinkTimeMultiplier: 0.6
      },
      {
        name: 'The Chess Olympiad Player',
        elo: 2540,
        description: 'National team member',
        thinkTimeMultiplier: 0.9
      },
      {
        name: 'The World Champion Material',
        elo: 2850,
        description: 'Top of the chess world',
        thinkTimeMultiplier: 0.7
      },
      {
        name: 'The Engine Defeater',
        elo: 2900,
        description: 'Plays like a machine',
        thinkTimeMultiplier: 0.6
      }
    ]
  }
};

/**
 * Find the best matching stereotype for a given ELO rating
 * @param {number} targetElo - The calculated ELO from casino/gambling system
 * @returns {Object} Stereotype object with name, description, etc.
 */
function findStereotypeForElo(targetElo) {
  // Clamp ELO to valid range
  const clampedElo = Math.max(400, Math.min(3000, targetElo));
  
  // Find the category that contains this ELO
  let bestCategory = null;
  for (const [categoryName, category] of Object.entries(OPPONENT_STEREOTYPES)) {
    const [min, max] = category.eloRange;
    if (clampedElo >= min && clampedElo <= max) {
      bestCategory = category;
      break;
    }
  }
  
  // Fallback to closest category if somehow out of range
  if (!bestCategory) {
    console.warn('[STEREOTYPE] ELO out of defined ranges:', clampedElo);
    // Find closest category by center ELO
    let minDistance = Infinity;
    for (const category of Object.values(OPPONENT_STEREOTYPES)) {
      const distance = Math.abs(category.centerElo - clampedElo);
      if (distance < minDistance) {
        minDistance = distance;
        bestCategory = category;
      }
    }
  }
  
  // Within the category, find the stereotype closest to target ELO
  let bestStereotype = bestCategory.stereotypes[0];
  let minDistance = Math.abs(bestStereotype.elo - clampedElo);
  
  for (const stereotype of bestCategory.stereotypes) {
    const distance = Math.abs(stereotype.elo - clampedElo);
    if (distance < minDistance) {
      minDistance = distance;
      bestStereotype = stereotype;
    }
  }
  
  // Return a copy with the actual target ELO (not the stereotype's base ELO)
  return {
    name: bestStereotype.name,
    description: bestStereotype.description,
    displayElo: clampedElo,  // Use the actual calculated ELO for display
    baseElo: bestStereotype.elo,  // Original stereotype ELO
    thinkTimeMultiplier: bestStereotype.thinkTimeMultiplier,
    category: bestCategory.eloRange
  };
}

/**
 * Get a random stereotype from the same category (for variety)
 * @param {number} targetElo - The calculated ELO
 * @returns {Object} Random stereotype from the appropriate category
 */
function getRandomStereotypeForElo(targetElo) {
  const clampedElo = Math.max(400, Math.min(3000, targetElo));
  
  // Find category
  let category = null;
  for (const cat of Object.values(OPPONENT_STEREOTYPES)) {
    const [min, max] = cat.eloRange;
    if (clampedElo >= min && clampedElo <= max) {
      category = cat;
      break;
    }
  }
  
  if (!category) {
    return findStereotypeForElo(targetElo);
  }
  
  // Pick random stereotype from category
  const randomIndex = Math.floor(Math.random() * category.stereotypes.length);
  const stereotype = category.stereotypes[randomIndex];
  
  return {
    name: stereotype.name,
    description: stereotype.description,
    displayElo: clampedElo,
    baseElo: stereotype.elo,
    thinkTimeMultiplier: stereotype.thinkTimeMultiplier,
    category: category.eloRange
  };
}

/**
 * Create opponent object with stereotype wrapper
 * This replaces the old createOpponent() function
 * @param {number} calculatedElo - ELO from casino/gambling/rigging system
 * @returns {Object} Opponent object with stereotype personality
 */
function createOpponentWithStereotype(calculatedElo) {
  // Get stereotype for this ELO (with randomization for variety)
  const useRandom = Math.random() < 0.7; // 70% chance for variety
  const stereotype = useRandom ? 
    getRandomStereotypeForElo(calculatedElo) : 
    findStereotypeForElo(calculatedElo);
  
  console.log(`[STEREOTYPE] Mapped ELO ${calculatedElo} → "${stereotype.name}" (${stereotype.displayElo})`);
  
  // Create opponent object that works with existing system
  return {
    name: stereotype.name,
    rating: calculatedElo,  // CRITICAL: Use actual calculated ELO for engine strength
    displayName: `${stereotype.name}`,
    description: stereotype.description,
    avatarSeed: stereotype.name,  // For consistent avatar generation
    
    // Stereotype metadata (can be used for UI/behavior tweaks)
    stereotype: {
      name: stereotype.name,
      baseElo: stereotype.baseElo,
      thinkTimeMultiplier: stereotype.thinkTimeMultiplier,
      category: stereotype.category
    },
    
    isHuman: false
  };
}

/**
 * Get emoji indicator for ELO category
 * @param {number} elo - ELO rating
 * @returns {string} Emoji representing skill level
 */
function getEloEmoji(elo) {
  if (elo < 800) return '🌱';      // Beginner
  if (elo < 1200) return '☕';     // Casual
  if (elo < 1600) return '📚';     // Intermediate
  if (elo < 2000) return '⚔️';     // Advanced
  if (elo < 2400) return '🏆';     // Expert
  return '👑';                      // Master
}

/**
 * Get color theme for opponent based on ELO
 * @param {number} elo - ELO rating
 * @returns {string} CSS color class or color code
 */
function getEloColor(elo) {
  if (elo < 800) return '#8bc34a';   // Green - Beginner
  if (elo < 1200) return '#ff9800';  // Orange - Casual
  if (elo < 1600) return '#2196f3';  // Blue - Intermediate
  if (elo < 2000) return '#9c27b0';  // Purple - Advanced
  if (elo < 2400) return '#f44336';  // Red - Expert
  return '#ffd700';                   // Gold - Master
}

// Export functions for use in main app
if (typeof window !== 'undefined') {
  window.OpponentStereotypes = {
    findStereotypeForElo,
    getRandomStereotypeForElo,
    createOpponentWithStereotype,
    getEloEmoji,
    getEloColor,
    OPPONENT_STEREOTYPES
  };
}
