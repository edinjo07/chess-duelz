// backend/lib/risk_assessment.js
// Risk scoring and fraud detection service

const moment = require('moment');

class RiskAssessmentService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Calculate comprehensive risk score for a withdrawal
   */
  async assessWithdrawal(withdrawalId, userId) {
    const checks = {
      kyc_status_check: 'pass',
      account_age_check: 'pass',
      velocity_check: 'pass',
      address_check: 'pass',
      linked_accounts_check: 'pass',
      recent_changes_check: 'pass'
    };

    const flags = {
      is_first_withdrawal: false,
      is_new_address: false,
      recent_password_change: false,
      recent_email_change: false,
      rapid_deposit_withdraw: false,
      unusual_amount: false,
      linked_accounts_found: false
    };

    const riskFactors = [];
    let riskScore = 0;

    try {
      // Get user and withdrawal data
      const [user] = await this.query('SELECT * FROM users WHERE id = ?', [userId]);
      const [withdrawal] = await this.query('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
      
      if (!user || !withdrawal) {
        throw new Error('User or withdrawal not found');
      }

      // Get risk rules
      const rules = await this.getRiskRules();

      // 1. KYC Status Check
      const kycCheck = await this.checkKYCStatus(user, withdrawal.amount, rules);
      checks.kyc_status_check = kycCheck.status;
      riskScore += kycCheck.score;
      if (kycCheck.factors.length > 0) riskFactors.push(...kycCheck.factors);

      // 2. Account Age Check
      const ageCheck = await this.checkAccountAge(user, rules);
      checks.account_age_check = ageCheck.status;
      riskScore += ageCheck.score;
      if (ageCheck.factors.length > 0) riskFactors.push(...ageCheck.factors);

      // 3. Velocity Check
      const velocityCheck = await this.checkVelocity(userId, withdrawal.amount, rules);
      checks.velocity_check = velocityCheck.status;
      riskScore += velocityCheck.score;
      flags.rapid_deposit_withdraw = velocityCheck.rapidInOut;
      flags.is_first_withdrawal = velocityCheck.isFirstWithdrawal;
      if (velocityCheck.factors.length > 0) riskFactors.push(...velocityCheck.factors);

      // 4. Address Check
      const addressCheck = await this.checkAddress(userId, withdrawal.wallet_address, withdrawal.network);
      checks.address_check = addressCheck.status;
      riskScore += addressCheck.score;
      flags.is_new_address = addressCheck.isNewAddress;
      if (addressCheck.factors.length > 0) riskFactors.push(...addressCheck.factors);

      // 5. Linked Accounts Check
      const linkedCheck = await this.checkLinkedAccounts(userId);
      checks.linked_accounts_check = linkedCheck.status;
      riskScore += linkedCheck.score;
      flags.linked_accounts_found = linkedCheck.found;
      if (linkedCheck.factors.length > 0) riskFactors.push(...linkedCheck.factors);

      // 6. Recent Changes Check
      const changesCheck = await this.checkRecentChanges(userId, rules);
      checks.recent_changes_check = changesCheck.status;
      riskScore += changesCheck.score;
      flags.recent_password_change = changesCheck.passwordChange;
      flags.recent_email_change = changesCheck.emailChange;
      if (changesCheck.factors.length > 0) riskFactors.push(...changesCheck.factors);

      // 7. Amount Check
      const amountCheck = await this.checkAmount(userId, withdrawal.amount, rules);
      riskScore += amountCheck.score;
      flags.unusual_amount = amountCheck.unusual;
      if (amountCheck.factors.length > 0) riskFactors.push(...amountCheck.factors);

      // Determine risk level and recommendation
      const riskLevel = this.getRiskLevel(riskScore);
      const recommendation = this.getRecommendation(riskScore, checks, rules);

      // Save assessment
      await this.saveAssessment(
        withdrawalId,
        userId,
        riskScore,
        riskLevel,
        recommendation,
        checks,
        flags,
        riskFactors
      );

      return {
        riskScore,
        riskLevel,
        recommendation,
        checks,
        flags,
        riskFactors
      };

    } catch (error) {
      console.error('Risk assessment error:', error);
      // Default to manual review on error
      return {
        riskScore: 75,
        riskLevel: 'high',
        recommendation: 'manual_review',
        checks,
        flags,
        riskFactors: [{ type: 'system_error', message: error.message, weight: 75 }]
      };
    }
  }

  /**
   * Check KYC status and limits
   */
  async checkKYCStatus(user, amount, rules) {
    let score = 0;
    let status = 'pass';
    const factors = [];

    const kycStatus = user.kyc_status || 'none';
    const kycTier = user.kyc_tier || 0;

    // Determine tier limits
    let dailyLimit, maxDeposit;
    switch (kycTier) {
      case 0:
        dailyLimit = parseFloat(rules.kyc_tier0_daily_withdraw || 50);
        maxDeposit = parseFloat(rules.kyc_tier0_max_deposit || 100);
        break;
      case 1:
        dailyLimit = parseFloat(rules.kyc_tier1_daily_withdraw || 500);
        maxDeposit = parseFloat(rules.kyc_tier1_max_deposit || 1000);
        break;
      case 2:
        dailyLimit = parseFloat(rules.kyc_tier2_daily_withdraw || 0);
        maxDeposit = parseFloat(rules.kyc_tier2_max_deposit || 0);
        break;
      default:
        dailyLimit = 0;
        maxDeposit = 0;
    }

    // Check if amount exceeds tier limit
    if (dailyLimit > 0 && amount > dailyLimit) {
      score += 30;
      status = 'fail';
      factors.push({
        type: 'kyc_limit_exceeded',
        message: `Amount $${amount} exceeds tier ${kycTier} daily limit of $${dailyLimit}`,
        weight: 30
      });
    }

    // Low tier withdrawal gets warning
    if (kycTier === 0 && amount > 10) {
      score += 10;
      if (status === 'pass') status = 'warning';
      factors.push({
        type: 'unverified_user',
        message: 'User has not completed KYC verification',
        weight: 10
      });
    }

    return { score, status, factors };
  }

  /**
   * Check account age
   */
  async checkAccountAge(user, rules) {
    let score = 0;
    let status = 'pass';
    const factors = [];

    const minAgeDays = parseInt(rules.min_account_age_days || 1);
    const accountAge = moment().diff(moment(user.created_at), 'days');

    if (accountAge < minAgeDays) {
      score += 25;
      status = 'fail';
      factors.push({
        type: 'account_too_new',
        message: `Account is ${accountAge} days old, minimum required is ${minAgeDays} days`,
        weight: 25
      });
    } else if (accountAge < 7) {
      score += 5;
      if (status === 'pass') status = 'warning';
      factors.push({
        type: 'new_account',
        message: `Account is only ${accountAge} days old`,
        weight: 5
      });
    }

    return { score, status, factors };
  }

  /**
   * Check velocity and deposit/withdrawal patterns
   */
  async checkVelocity(userId, amount, rules) {
    let score = 0;
    let status = 'pass';
    const factors = [];
    let rapidInOut = false;
    let isFirstWithdrawal = false;

    // Get withdrawal history
    const withdrawalHistory = await this.query(
      'SELECT COUNT(*) as count FROM withdrawals WHERE user_id = ? AND status = "sent"',
      [userId]
    );
    isFirstWithdrawal = withdrawalHistory[0].count === 0;

    if (isFirstWithdrawal) {
      score += 5;
      factors.push({
        type: 'first_withdrawal',
        message: 'This is the user\'s first withdrawal',
        weight: 5
      });
    }

    // Check recent deposit timing
    const recentDeposit = await this.query(
      `SELECT MAX(created_at) as last_deposit 
       FROM deposits 
       WHERE user_id = ? AND status = 'finished'`,
      [userId]
    );

    if (recentDeposit[0] && recentDeposit[0].last_deposit) {
      const minutesSinceDeposit = moment().diff(moment(recentDeposit[0].last_deposit), 'minutes');
      const rapidThreshold = parseInt(rules.rapid_inout_threshold_minutes || 30);

      if (minutesSinceDeposit < rapidThreshold) {
        score += 35;
        status = 'fail';
        rapidInOut = true;
        factors.push({
          type: 'rapid_in_out',
          message: `Withdrawal attempt ${minutesSinceDeposit} minutes after deposit (threshold: ${rapidThreshold}m)`,
          weight: 35
        });
      }
    }

    // Check daily withdrawal count
    const todayWithdrawals = await this.query(
      `SELECT COUNT(*) as count 
       FROM withdrawals 
       WHERE user_id = ? 
       AND DATE(created_at) = CURDATE()
       AND status != 'rejected'`,
      [userId]
    );

    const maxPerDay = parseInt(rules.max_withdrawals_per_day || 5);
    if (todayWithdrawals[0].count >= maxPerDay) {
      score += 20;
      status = 'fail';
      factors.push({
        type: 'excessive_withdrawals',
        message: `User has ${todayWithdrawals[0].count} withdrawal requests today (max: ${maxPerDay})`,
        weight: 20
      });
    }

    // Check deposit/withdrawal ratio
    const totals = await this.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) as total_deposits,
        COALESCE(SUM(CASE WHEN type = 'withdrawal' THEN ABS(amount) ELSE 0 END), 0) as total_withdrawals
       FROM ledger_entries
       WHERE user_id = ?`,
      [userId]
    );

    const totalDeposits = parseFloat(totals[0].total_deposits);
    const totalWithdrawals = parseFloat(totals[0].total_withdrawals);

    if (totalDeposits > 0) {
      const ratio = totalWithdrawals / totalDeposits;
      const maxRatio = parseFloat(rules.max_deposit_withdraw_ratio || 0.95);

      if (ratio > maxRatio) {
        score += 25;
        status = 'fail';
        factors.push({
          type: 'high_withdrawal_ratio',
          message: `Withdrawal/deposit ratio is ${(ratio * 100).toFixed(1)}% (max: ${(maxRatio * 100).toFixed(0)}%)`,
          weight: 25
        });
      }
    }

    return { score, status, factors, rapidInOut, isFirstWithdrawal };
  }

  /**
   * Check wallet address
   */
  async checkAddress(userId, address, network) {
    let score = 0;
    let status = 'pass';
    const factors = [];
    let isNewAddress = false;

    // Check if address was used before by this user
    const previousUse = await this.query(
      'SELECT COUNT(*) as count FROM withdrawals WHERE user_id = ? AND wallet_address = ?',
      [userId, address]
    );

    isNewAddress = previousUse[0].count === 0;
    if (isNewAddress) {
      score += 10;
      factors.push({
        type: 'new_address',
        message: 'User is withdrawing to a new address',
        weight: 10
      });
    }

    // Check blacklist
    const blacklisted = await this.query(
      'SELECT * FROM wallet_blacklist WHERE wallet_address = ? AND network = ? AND is_active = TRUE',
      [address, network]
    );

    if (blacklisted.length > 0) {
      score += 50;
      status = 'fail';
      factors.push({
        type: 'blacklisted_address',
        message: `Address is blacklisted: ${blacklisted[0].reason}`,
        weight: 50
      });
    }

    // Check if address is used by other users (potential multi-accounting)
    const otherUsers = await this.query(
      'SELECT COUNT(DISTINCT user_id) as count FROM withdrawals WHERE wallet_address = ? AND user_id != ?',
      [address, userId]
    );

    if (otherUsers[0].count > 0) {
      score += 30;
      status = 'fail';
      factors.push({
        type: 'shared_address',
        message: `This address is used by ${otherUsers[0].count} other user(s)`,
        weight: 30
      });
    }

    return { score, status, factors, isNewAddress };
  }

  /**
   * Check for linked accounts
   */
  async checkLinkedAccounts(userId) {
    let score = 0;
    let status = 'pass';
    const factors = [];
    let found = false;

    const linkedAccounts = await this.query(
      'SELECT COUNT(*) as count, MAX(confidence_score) as max_confidence FROM linked_accounts WHERE user_id = ?',
      [userId]
    );

    if (linkedAccounts[0].count > 0) {
      found = true;
      const confidence = parseFloat(linkedAccounts[0].max_confidence);
      
      if (confidence >= 0.8) {
        score += 25;
        status = 'fail';
      } else if (confidence >= 0.5) {
        score += 15;
        status = 'warning';
      } else {
        score += 5;
      }

      factors.push({
        type: 'linked_accounts',
        message: `User has ${linkedAccounts[0].count} potential linked account(s)`,
        weight: score
      });
    }

    return { score, status, factors, found };
  }

  /**
   * Check recent security changes
   */
  async checkRecentChanges(userId, rules) {
    let score = 0;
    let status = 'pass';
    const factors = [];
    let passwordChange = false;
    let emailChange = false;

    const passwordCooldown = parseInt(rules.cooldown_password_change_hours || 24);
    const emailCooldown = parseInt(rules.cooldown_email_change_hours || 48);

    // Check password changes (would need password_changed_at field in users table)
    const user = await this.query('SELECT password_changed_at, email_changed_at FROM users WHERE id = ?', [userId]);
    
    if (user[0] && user[0].password_changed_at) {
      const hoursSinceChange = moment().diff(moment(user[0].password_changed_at), 'hours');
      if (hoursSinceChange < passwordCooldown) {
        score += 20;
        status = 'fail';
        passwordChange = true;
        factors.push({
          type: 'recent_password_change',
          message: `Password changed ${hoursSinceChange}h ago (cooldown: ${passwordCooldown}h)`,
          weight: 20
        });
      }
    }

    if (user[0] && user[0].email_changed_at) {
      const hoursSinceChange = moment().diff(moment(user[0].email_changed_at), 'hours');
      if (hoursSinceChange < emailCooldown) {
        score += 25;
        status = 'fail';
        emailChange = true;
        factors.push({
          type: 'recent_email_change',
          message: `Email changed ${hoursSinceChange}h ago (cooldown: ${emailCooldown}h)`,
          weight: 25
        });
      }
    }

    return { score, status, factors, passwordChange, emailChange };
  }

  /**
   * Check amount reasonableness
   */
  async checkAmount(userId, amount, rules) {
    let score = 0;
    const factors = [];
    let unusual = false;

    const largeThreshold = parseFloat(rules.large_transaction_threshold || 1000);

    if (amount >= largeThreshold) {
      score += 15;
      unusual = true;
      factors.push({
        type: 'large_amount',
        message: `Amount $${amount} exceeds large transaction threshold of $${largeThreshold}`,
        weight: 15
      });
    }

    // Check against user's average
    const avgWithdrawal = await this.query(
      `SELECT AVG(amount) as avg_amount 
       FROM withdrawals 
       WHERE user_id = ? AND status = 'sent'`,
      [userId]
    );

    if (avgWithdrawal[0].avg_amount && amount > avgWithdrawal[0].avg_amount * 3) {
      score += 10;
      unusual = true;
      factors.push({
        type: 'unusual_amount',
        message: `Amount is 3x higher than user's average withdrawal of $${avgWithdrawal[0].avg_amount.toFixed(2)}`,
        weight: 10
      });
    }

    return { score, factors, unusual };
  }

  /**
   * Determine risk level from score
   */
  getRiskLevel(score) {
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    return 'low';
  }

  /**
   * Get recommendation based on risk
   */
  getRecommendation(score, checks, rules) {
    // Critical failures
    if (checks.kyc_status_check === 'fail' ||
        checks.account_age_check === 'fail' ||
        checks.address_check === 'fail' ||
        checks.recent_changes_check === 'fail') {
      return 'reject';
    }

    // High risk requires review
    if (score >= 50) {
      return 'manual_review';
    }

    // Medium risk - hold for review if manual review is enabled
    if (score >= 25) {
      const manualReviewEnabled = rules.manual_review_enabled === 'true';
      return manualReviewEnabled ? 'manual_review' : 'hold';
    }

    // Low risk - check auto-approve threshold
    const autoApproveThreshold = parseFloat(rules.auto_approve_threshold || 100);
    // Note: Would need withdrawal amount here - for now return manual_review for safety
    return 'manual_review';
  }

  /**
   * Save assessment to database
   */
  async saveAssessment(withdrawalId, userId, riskScore, riskLevel, recommendation, checks, flags, riskFactors) {
    await this.query(
      `INSERT INTO withdrawal_risk_assessments 
       (withdrawal_id, user_id, risk_score, risk_level, recommendation,
        kyc_status_check, account_age_check, velocity_check, address_check, 
        linked_accounts_check, recent_changes_check, risk_factors,
        is_first_withdrawal, is_new_address, recent_password_change, recent_email_change,
        rapid_deposit_withdraw, unusual_amount, linked_accounts_found)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        risk_score = VALUES(risk_score),
        risk_level = VALUES(risk_level),
        recommendation = VALUES(recommendation),
        risk_factors = VALUES(risk_factors),
        reassessed_at = NOW(),
        assessment_version = assessment_version + 1`,
      [
        withdrawalId, userId, riskScore, riskLevel, recommendation,
        checks.kyc_status_check, checks.account_age_check, checks.velocity_check,
        checks.address_check, checks.linked_accounts_check, checks.recent_changes_check,
        JSON.stringify(riskFactors),
        flags.is_first_withdrawal, flags.is_new_address, flags.recent_password_change,
        flags.recent_email_change, flags.rapid_deposit_withdraw, flags.unusual_amount,
        flags.linked_accounts_found
      ]
    );
  }

  /**
   * Get risk rules from database
   */
  async getRiskRules() {
    const rules = await this.query('SELECT rule_key, rule_value FROM risk_rules WHERE is_enabled = TRUE');
    const rulesObj = {};
    rules.forEach(rule => {
      rulesObj[rule.rule_key] = rule.rule_value;
    });
    return rulesObj;
  }

  /**
   * Update user risk profile
   */
  async updateUserRiskProfile(userId) {
    // Calculate overall user risk score based on history
    const totals = await this.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN entry_type = 'deposit' THEN amount ELSE 0 END), 0) as total_deposits,
        COALESCE(SUM(CASE WHEN entry_type = 'withdrawal' THEN ABS(amount) ELSE 0 END), 0) as total_withdrawals,
        COUNT(CASE WHEN entry_type = 'deposit' THEN 1 END) as deposit_count,
        COUNT(CASE WHEN entry_type = 'withdrawal' THEN 1 END) as withdrawal_count,
        MIN(CASE WHEN entry_type = 'deposit' THEN created_at END) as first_deposit,
        MAX(CASE WHEN entry_type = 'deposit' THEN created_at END) as last_deposit,
        MIN(CASE WHEN entry_type = 'withdrawal' THEN created_at END) as first_withdrawal,
        MAX(CASE WHEN entry_type = 'withdrawal' THEN created_at END) as last_withdrawal
       FROM ledger_entries
       WHERE user_id = ?`,
      [userId]
    );

    const data = totals[0];
    const depositWithdrawRatio = data.total_deposits > 0 ? data.total_withdrawals / data.total_deposits : 0;

    // Count linked accounts
    const linkedCount = await this.query(
      'SELECT COUNT(*) as count FROM linked_accounts WHERE user_id = ?',
      [userId]
    );

    // Calculate risk score
    let riskScore = 0;
    if (depositWithdrawRatio > 0.95) riskScore += 30;
    if (linkedCount[0].count > 0) riskScore += 20;

    const riskLevel = this.getRiskLevel(riskScore);

    await this.query(
      `INSERT INTO user_risk_profiles 
       (user_id, risk_score, risk_level, total_deposits, total_withdrawals, 
        deposit_count, withdrawal_count, deposit_withdraw_ratio, 
        first_deposit_at, last_deposit_at, first_withdrawal_at, last_withdrawal_at,
        linked_account_flags, last_calculated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
        risk_score = VALUES(risk_score),
        risk_level = VALUES(risk_level),
        total_deposits = VALUES(total_deposits),
        total_withdrawals = VALUES(total_withdrawals),
        deposit_count = VALUES(deposit_count),
        withdrawal_count = VALUES(withdrawal_count),
        deposit_withdraw_ratio = VALUES(deposit_withdraw_ratio),
        first_deposit_at = VALUES(first_deposit_at),
        last_deposit_at = VALUES(last_deposit_at),
        first_withdrawal_at = VALUES(first_withdrawal_at),
        last_withdrawal_at = VALUES(last_withdrawal_at),
        linked_account_flags = VALUES(linked_account_flags),
        last_calculated_at = NOW()`,
      [
        userId, riskScore, riskLevel, data.total_deposits, data.total_withdrawals,
        data.deposit_count, data.withdrawal_count, depositWithdrawRatio,
        data.first_deposit, data.last_deposit, data.first_withdrawal, data.last_withdrawal,
        linkedCount[0].count
      ]
    );
  }

  /**
   * Promisified query helper
   */
  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });
  }
}

module.exports = RiskAssessmentService;
