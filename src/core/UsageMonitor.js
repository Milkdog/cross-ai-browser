/**
 * UsageMonitor - Polls Anthropic's OAuth usage API for the terminal usage bars.
 *
 * Owns everything between "a terminal exists" and "here is a usage payload":
 * Keychain token reading (passive — never refreshes/writes), polling with
 * jitter + 429 backoff, response parsing (session/weekly windows, extra-usage
 * overage, prepaid balance), and last-known-good caching so the bars never
 * blank on a transient failure.
 *
 * Decoupled from Electron entirely: the host (ViewManager) supplies
 * `onUsage(payload)` for broadcasting and `hasConsumers()` to pause polling
 * when no terminals are open.
 */

const { execFile } = require('child_process');

// The /api/oauth/* endpoints aggressively 429 clients that don't identify as
// Claude Code (community-documented; non-CLI user agents get persistent 429s,
// while claude-code/* is safe at ~3-minute polling). Same spirit as the web
// views stripping "Electron" — we're acting on the user's own credentials.
const OAUTH_API_USER_AGENT = 'claude-code/2.1.0';

const OAUTH_HEADERS = (accessToken) => ({
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': OAUTH_API_USER_AGENT,
  'Authorization': `Bearer ${accessToken}`,
  'anthropic-beta': 'oauth-2025-04-20'
});

class UsageMonitor {
  /**
   * @param {Object} options
   * @param {Function} options.onUsage - Called with each usage payload to broadcast
   * @param {Function} options.hasConsumers - Returns true while anything wants usage data
   */
  constructor({ onUsage, hasConsumers }) {
    this.onUsage = onUsage;
    this.hasConsumers = hasConsumers || (() => true);

    // 3-minute interval — community-documented as safe when the request
    // identifies as Claude Code (OAUTH_API_USER_AGENT). The limit is per
    // access token (shared with the real CLI), so jitter + 429 backoff stay
    // as a second line of defense.
    this.usageCache = {
      data: null,
      lastFetch: 0,
      fetchInterval: 180000,
      pendingFetch: null,
      backoffUntil: 0,
      consecutive429s: 0,
      lastError: null
    };
    this.pollTimer = null;
    // Cached org UUID for the prepaid-credits balance endpoint (never changes
    // for a given login, so fetch once).
    this.orgUuid = null;
  }

  /**
   * Begin polling, or — if already polling — do an immediate fetch so a newly
   * opened terminal gets data right away.
   */
  start() {
    if (this.pollTimer) {
      this._poll();
      return;
    }

    // Self-scheduling loop with ±15% jitter so the app's polls drift out of
    // phase with the Claude Code CLI's own usage polling, reducing 429
    // collisions on the shared rate limit.
    const scheduleNext = () => {
      const base = this.usageCache.fetchInterval;
      const delay = Math.round(base * (0.85 + Math.random() * 0.3));
      this.pollTimer = setTimeout(async () => {
        await this._poll();
        scheduleNext();
      }, delay);
    };

    this._poll();
    scheduleNext();
  }

  /** Stop periodic polling. Cached data survives for the next start(). */
  stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * The payload to send to a usage consumer. Always prefers last-known-good
   * data (annotated with lastError when the latest refresh failed) so the bars
   * never blank on a transient failure; only returns a bare error when no data
   * has ever been fetched; null before the first poll completes.
   */
  getPayload() {
    const c = this.usageCache;
    if (c.data) {
      return c.lastError ? { ...c.data, lastError: c.lastError } : c.data;
    }
    if (c.lastError) {
      return { error: c.lastError };
    }
    return null;
  }

  /** @private */
  async _poll() {
    if (!this.hasConsumers()) return;
    // Respect backoff window — don't clear cache or hit the API while rate
    // limited, but DO re-broadcast the last-known-good data so the bars keep
    // showing values (faded/stale) instead of blanking.
    if (Date.now() < this.usageCache.backoffUntil) {
      this._emit();
      return;
    }
    // Clear cache to force a fresh fetch
    this.usageCache.lastFetch = 0;
    await this._fetchUsageData();
    this._emit();
  }

  /** @private */
  _emit() {
    const payload = this.getPayload();
    if (payload && this.onUsage) {
      this.onUsage(payload);
    }
  }

  /**
   * Fetch usage data from the Anthropic API (deduplicated, cached, backoff-aware).
   * @private
   */
  async _fetchUsageData() {
    // Respect rate-limit backoff from any prior 429
    if (Date.now() < this.usageCache.backoffUntil) {
      return this.usageCache.data;
    }

    if (this.usageCache.data && Date.now() - this.usageCache.lastFetch < this.usageCache.fetchInterval) {
      return this.usageCache.data;
    }

    if (this.usageCache.pendingFetch) {
      return this.usageCache.pendingFetch;
    }

    this.usageCache.pendingFetch = (async () => {
      try {
        const { accessToken, expiresAt } = await this._getClaudeOAuthToken();

        // Passive token-expiry handling (no Keychain writes): if the cached
        // credential is already expired, skip the request — it would only 401.
        // Claude Code refreshes the Keychain credential on its next activity,
        // and a later poll picks up the new token automatically. We keep showing
        // last-known-good data as stale in the meantime.
        if (expiresAt && Date.now() >= expiresAt - 30000) {
          this.usageCache.lastError = 'OAuth token expired — Claude Code will refresh it shortly';
          this.usageCache.pendingFetch = null;
          return null;
        }

        const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
          method: 'GET',
          headers: OAUTH_HEADERS(accessToken)
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          if (response.status === 429) {
            // Honor retry-after header; else exponential backoff (5 → 10 → 15 min
            // cap) with ±15% jitter so retries don't stay phase-locked with the
            // CLI. We don't blank the bars during backoff (see getPayload), so a
            // long backoff is harmless — last-known-good keeps showing.
            const retryAfterHeader = response.headers.get('retry-after');
            const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
            this.usageCache.consecutive429s = (this.usageCache.consecutive429s || 0) + 1;
            const baseSec = Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? retryAfterSec
              : Math.min(900, 300 * Math.pow(2, this.usageCache.consecutive429s - 1));
            const backoffSec = Math.round(baseSec * (0.85 + Math.random() * 0.3));
            this.usageCache.backoffUntil = Date.now() + backoffSec * 1000;
            console.warn(`[usage] 429 rate limit — backing off ${backoffSec}s`);
            this.usageCache.lastError = `Rate limited by API — retrying in ~${Math.ceil(backoffSec / 60)}m`;
            this.usageCache.pendingFetch = null;
            return null;
          }
          if (response.status === 401 || response.status === 403) {
            // Token rejected — likely just rotated by the CLI. Don't back off; the
            // next poll re-reads the Keychain and should pick up the new token.
            this.usageCache.lastError = 'OAuth token rejected — Claude Code will refresh it shortly';
            this.usageCache.pendingFetch = null;
            return null;
          }
          this.usageCache.lastError = `API ${response.status} ${response.statusText}: ${body.slice(0, 200)}`;
          this.usageCache.pendingFetch = null;
          return null;
        }

        // Successful response — reset 429 counter
        this.usageCache.consecutive429s = 0;
        this.usageCache.backoffUntil = 0;

        const apiData = await response.json();
        if (!apiData?.five_hour && !apiData?.seven_day) {
          console.warn('[usage] response missing five_hour/seven_day — shape may have changed. Keys:', Object.keys(apiData || {}));
        }
        const parsed = this._parseUsageData(apiData);

        // The /usage endpoint only reports the overage spend cap + amount used,
        // not the user's actual prepaid credit balance (what they think of as
        // "remaining budget"). Fetch that from the prepaid-credits endpoint when
        // extra usage is enabled. Failures here degrade gracefully — the chip
        // still shows, just without the balance.
        if (parsed.extra?.enabled) {
          const balance = await this._fetchPrepaidBalance(accessToken);
          if (balance) parsed.extra.balance = balance;
        }

        const fetchedAt = Date.now();
        const result = { ...parsed, fetchedAt };
        this.usageCache.data = result;
        this.usageCache.lastFetch = fetchedAt;
        this.usageCache.lastError = null;
        this.usageCache.pendingFetch = null;
        return result;
      } catch (error) {
        console.error('[usage] fetch failed:', error.message);
        this.usageCache.lastError = error.message;
        this.usageCache.pendingFetch = null;
        return null;
      }
    })();

    return this.usageCache.pendingFetch;
  }

  /**
   * Get the OAuth token from the macOS Keychain (read-only — see passive
   * token-handling note in _fetchUsageData).
   * @private
   */
  _getClaudeOAuthToken() {
    return new Promise((resolve, reject) => {
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to get credentials: ${error.message}`));
          return;
        }

        try {
          const rawData = stdout.trim();

          // Handle both hex-encoded and plain text formats
          let content;
          if (/^[0-9a-fA-F]+$/.test(rawData)) {
            const rawBytes = Buffer.from(rawData, 'hex');
            content = rawBytes.slice(1).toString('utf8');
          } else {
            content = rawData;
          }

          // Prefer a structured parse so we can read the expiry alongside the
          // token; fall back to regex for partial/non-JSON blobs.
          let accessToken = null;
          let expiresAt = null;
          try {
            const parsed = JSON.parse(content);
            const oauth = parsed.claudeAiOauth || parsed;
            accessToken = oauth.accessToken || null;
            expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
          } catch (_) {
            // Not valid JSON — fall through to regex extraction below.
          }

          if (!accessToken) {
            const match = content.match(/"claudeAiOauth"\s*:\s*\{\s*"accessToken"\s*:\s*"([^"]+)"/)
              || content.match(/"accessToken"\s*:\s*"([^"]+)"/);
            if (match) accessToken = match[1];
          }
          if (expiresAt == null) {
            const expMatch = content.match(/"expiresAt"\s*:\s*(\d+)/);
            if (expMatch) expiresAt = parseInt(expMatch[1], 10);
          }

          if (!accessToken) {
            reject(new Error('Could not find accessToken in credentials'));
            return;
          }

          resolve({ accessToken, expiresAt });
        } catch (e) {
          reject(new Error(`Failed to parse credentials: ${e.message}`));
        }
      });
    });
  }

  /**
   * Resolve and cache the org UUID (needed for org-scoped endpoints).
   * @private
   */
  async _getOrgUuid(accessToken) {
    if (this.orgUuid) return this.orgUuid;
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
        method: 'GET',
        headers: OAUTH_HEADERS(accessToken)
      });
      if (!res.ok) return null;
      const data = await res.json();
      this.orgUuid = data?.organization?.uuid || null;
      return this.orgUuid;
    } catch (e) {
      console.warn('[usage] profile/org fetch failed:', e.message);
      return null;
    }
  }

  /**
   * Fetch the prepaid credit balance — the user's actual "remaining budget".
   * `amount` is in minor units (cents). Returns null on any failure so the
   * extra-usage chip degrades gracefully.
   * @private
   */
  async _fetchPrepaidBalance(accessToken) {
    try {
      const orgUuid = await this._getOrgUuid(accessToken);
      if (!orgUuid) return null;
      const res = await fetch(`https://api.anthropic.com/api/oauth/organizations/${orgUuid}/prepaid/credits`, {
        method: 'GET',
        headers: OAUTH_HEADERS(accessToken)
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data?.amount !== 'number') return null;
      return {
        amount: data.amount / 100,
        currency: data.currency || 'USD',
        autoReload: data.auto_reload_settings?.enabled === true
      };
    } catch (e) {
      console.warn('[usage] prepaid balance fetch failed:', e.message);
      return null;
    }
  }

  /** @private */
  _parseUsageData(apiData) {
    const session = this._parseWindow(apiData?.five_hour, 5 * 60, 'session');
    const weekly = this._parseWindow(apiData?.seven_day, 7 * 24 * 60, 'weekly');
    const extra = this._parseExtraUsage(apiData);
    return { session, weekly, extra };
  }

  /**
   * Parse one usage window bucket ({ utilization, resets_at }) into the shape
   * the bars render: percent used plus how far through the window we are.
   * @private
   */
  _parseWindow(bucket, windowMinutes, label) {
    try {
      if (bucket) {
        const percentUsed = Math.round(bucket.utilization || 0);
        const resetsAt = this._toEpochMs(bucket.resets_at);
        const timeLeft = this._formatTimeRemaining(bucket.resets_at);
        const timeElapsedPercent = this._calcTimeElapsedPercent(bucket.resets_at, windowMinutes);
        return { percentUsed, timeLeft, timeElapsedPercent, resetsAt, windowMinutes };
      }
    } catch (e) {
      console.error(`Error parsing ${label} data:`, e);
    }
    return { percentUsed: 0, timeLeft: '--', timeElapsedPercent: null, resetsAt: null, windowMinutes };
  }

  /**
   * Parse the extra_usage (overage) bucket. Returns { enabled: false } when the
   * user has not opted into extra usage. Note: monetary fields are in minor
   * units (cents) — matching Claude Code's own formatter — so we convert to
   * major units (dollars) here. This block reports the overage spend CAP and
   * amount used, NOT the prepaid balance (that comes from _fetchPrepaidBalance).
   * @private
   */
  _parseExtraUsage(apiData) {
    try {
      const e = apiData?.extra_usage;
      if (!e || !e.is_enabled) return { enabled: false };

      const monthlyLimit = typeof e.monthly_limit === 'number' ? e.monthly_limit / 100 : null;
      const usedCredits = typeof e.used_credits === 'number' ? e.used_credits / 100 : null;
      const utilization = typeof e.utilization === 'number' ? Math.round(e.utilization) : null;
      let remaining = null;
      if (monthlyLimit != null && usedCredits != null) {
        remaining = Math.max(0, monthlyLimit - usedCredits);
      }

      return {
        enabled: true,
        monthlyLimit,
        usedCredits,
        remaining,
        utilization,
        currency: e.currency || 'USD'
      };
    } catch (err) {
      console.error('Error parsing extra usage data:', err);
      return { enabled: false };
    }
  }

  /** @private */
  _toEpochMs(resetTimeStr) {
    if (!resetTimeStr) return null;
    const ms = new Date(resetTimeStr).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Calculate what percentage of a usage window has elapsed
   * @param {string} resetTimeStr - ISO timestamp when the window resets
   * @param {number} windowMinutes - Total window duration in minutes
   * @returns {number|null} Percentage elapsed (0-100), or null if unknown
   * @private
   */
  _calcTimeElapsedPercent(resetTimeStr, windowMinutes) {
    if (!resetTimeStr) return null;
    try {
      const resetTime = new Date(resetTimeStr);
      const now = new Date();
      const timeLeftMs = resetTime - now;
      if (timeLeftMs <= 0) return 100;
      const windowMs = windowMinutes * 60 * 1000;
      const elapsedMs = windowMs - timeLeftMs;
      return Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100));
    } catch (e) {
      return null;
    }
  }

  /** @private */
  _formatTimeRemaining(resetTimeStr) {
    if (!resetTimeStr) return '--';

    try {
      const resetTime = new Date(resetTimeStr);
      const now = new Date();
      const diffMs = resetTime - now;

      if (diffMs <= 0) return 'now';

      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffDays > 0) {
        const remainingHours = diffHours % 24;
        return remainingHours > 0 ? `${diffDays}d ${remainingHours}h` : `${diffDays}d`;
      }

      if (diffHours > 0) {
        const remainingMins = diffMins % 60;
        return `${diffHours}h ${remainingMins}m`;
      }

      return `${diffMins}m`;
    } catch (e) {
      return '--';
    }
  }
}

module.exports = UsageMonitor;
