/**
 * Session Management Utilities
 * Handles user session state, location tracking, and authentication flow
 */

export interface LocationState {
  path: string;
  search: string;
  hash: string;
  timestamp: number;
  referrer?: string;
}

export interface SessionState {
  lastLocation: string | null;
  timestamp: number;
  userId?: string;
  locationState?: LocationState;
}

class SessionManager {
  private static instance: SessionManager;
  private readonly STORAGE_KEY = 'passiveWealth_session';
  private readonly LOCATION_KEY = 'passiveWealth_lastLocation';
  private readonly CACHE_KEY = 'passiveWealth_cache';
  private readonly REDIRECT_KEY = 'passiveWealth_pendingRedirect';
  private readonly SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
  private readonly CACHE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

  private constructor() {}

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Store user's current location for session restoration
   * Enhanced to capture complete URL state including search params and hash
   */
  storeLocation(path?: string, search?: string, hash?: string): void {
    try {
      if (typeof window === 'undefined') return;
      
      const currentPath = path || window.location.pathname;
      const currentSearch = search || window.location.search;
      const currentHash = hash || window.location.hash;
      const fullPath = currentPath + currentSearch + currentHash;
      
      // Don't store auth callback or root paths
      if (currentPath === '/auth/callback' || currentPath === '/' || currentPath.startsWith('/auth/')) return;
      
      const locationState: LocationState = {
        path: currentPath,
        search: currentSearch,
        hash: currentHash,
        timestamp: Date.now(),
        referrer: document.referrer
      };
      
      const sessionState: SessionState = {
        lastLocation: fullPath,
        timestamp: Date.now(),
        locationState
      };
      
      localStorage.setItem(this.LOCATION_KEY, JSON.stringify(sessionState));
      console.log('Stored location:', fullPath);
    } catch (error) {
      console.error('Error storing location:', error);
    }
  }

  /**
   * Store pending redirect for post-authentication
   */
  storePendingRedirect(redirectTo: string, state?: Record<string, any>): void {
    try {
      if (typeof window === 'undefined') return;
      
      const pendingRedirect = {
        redirectTo,
        state: state || {},
        timestamp: Date.now(),
        userAgent: navigator.userAgent.substring(0, 50)
      };
      
      localStorage.setItem(this.REDIRECT_KEY, JSON.stringify(pendingRedirect));
      console.log('Stored pending redirect:', redirectTo);
    } catch (error) {
      console.error('Error storing pending redirect:', error);
    }
  }

  /**
   * Get and clear pending redirect
   */
  getPendingRedirect(): { redirectTo: string; state: Record<string, any> } | null {
    try {
      if (typeof window === 'undefined') return null;
      
      const stored = localStorage.getItem(this.REDIRECT_KEY);
      if (!stored) return null;
      
      const pendingRedirect = JSON.parse(stored);
      
      // Check if redirect is expired (5 minutes)
      if (Date.now() - pendingRedirect.timestamp > 5 * 60 * 1000) {
        this.clearPendingRedirect();
        return null;
      }
      
      // Clear after retrieval
      this.clearPendingRedirect();
      
      return {
        redirectTo: pendingRedirect.redirectTo,
        state: pendingRedirect.state || {}
      };
    } catch (error) {
      console.error('Error getting pending redirect:', error);
      return null;
    }
  }

  /**
   * Clear pending redirect
   */
  clearPendingRedirect(): void {
    try {
      if (typeof window === 'undefined') return;
      localStorage.removeItem(this.REDIRECT_KEY);
    } catch (error) {
      console.error('Error clearing pending redirect:', error);
    }
  }
  /**
   * Retrieve stored location for session restoration
   * Enhanced to return complete location state
   */
  getStoredLocation(): LocationState | null {
    try {
      if (typeof window === 'undefined') return null;
      
      const stored = localStorage.getItem(this.LOCATION_KEY);
      if (!stored) return null;
      
      const sessionState: SessionState = JSON.parse(stored);
      
      // Check if session is expired
      if (Date.now() - sessionState.timestamp > this.SESSION_TIMEOUT) {
        this.clearStoredLocation();
        return null;
      }
      
      return sessionState.locationState || {
        path: sessionState.lastLocation || '/momentum',
        search: '',
        hash: '',
        timestamp: sessionState.timestamp
      };
    } catch (error) {
      console.error('Error retrieving stored location:', error);
      return null;
    }
  }

  /**
   * Clear stored location
   */
  clearStoredLocation(): void {
    try {
      if (typeof window === 'undefined') return;
      localStorage.removeItem(this.LOCATION_KEY);
      console.log('Cleared stored location');
    } catch (error) {
      console.error('Error clearing stored location:', error);
    }
  }

  /**
   * Store session metadata
   */
  storeSessionMetadata(userId: string, metadata: Record<string, any> = {}): void {
    try {
      if (typeof window === 'undefined') return;
      
      const sessionData = {
        userId,
        metadata: {
          ...metadata,
          lastActivity: Date.now(),
          userAgent: navigator.userAgent.substring(0, 100) // Store partial UA for session validation
        },
        timestamp: Date.now()
      };
      
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(sessionData));
    } catch (error) {
      console.error('Error storing session metadata:', error);
    }
  }

  /**
   * Retrieve session metadata
   */
  getSessionMetadata(): { userId: string; metadata: Record<string, any> } | null {
    try {
      if (typeof window === 'undefined') return null;
      
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (!stored) return null;
      
      const sessionData = JSON.parse(stored);
      
      // Check if session is expired
      if (Date.now() - sessionData.timestamp > this.SESSION_TIMEOUT) {
        this.clearSessionMetadata();
        return null;
      }
      
      return {
        userId: sessionData.userId,
        metadata: sessionData.metadata
      };
    } catch (error) {
      console.error('Error retrieving session metadata:', error);
      return null;
    }
  }

  /**
   * Clear session metadata
   */
  clearSessionMetadata(): void {
    try {
      if (typeof window === 'undefined') return;
      localStorage.removeItem(this.STORAGE_KEY);
    } catch (error) {
      console.error('Error clearing session metadata:', error);
    }
  }

  /**
   * Clear all session data
   */
  clearAll(): void {
    this.clearStoredLocation();
    this.clearSessionMetadata();
    this.clearCachedData();
    this.clearPendingRedirect();
  }

  /**
   * Clear cached data
   */
  clearCachedData(): void {
    try {
      if (typeof window === 'undefined') return;
      localStorage.removeItem(this.CACHE_KEY);
    } catch (error) {
      console.error('Error clearing cached data:', error);
    }
  }

  /**
   * Get cached data
   */
  getCachedData(): Record<string, any> {
    try {
      if (typeof window === 'undefined') return {};
      
      const cached = localStorage.getItem(this.CACHE_KEY);
      if (!cached) return {};
      
      const cacheData = JSON.parse(cached);
      
      // Check if cache is expired
      if (Date.now() - cacheData.timestamp > this.CACHE_TIMEOUT) {
        this.clearCachedData();
        return {};
      }
      
      return cacheData.data || {};
    } catch (error) {
      console.error('Error retrieving cached data:', error);
      return {};
    }
  }

  /**
   * Check if current path should be stored for restoration
   */
  shouldStorePath(path: string): boolean {
    const excludedPaths = [
      '/auth/callback',
      '/',
      '/login',
      '/signup',
      '/auth'
    ];
    
    const excludedPatterns = [
      /^\/auth\//,
      /^\/\?/,  // Query params on root
      /^\/$/    // Exact root
    ];
    
    return !excludedPaths.includes(path) && 
           !excludedPatterns.some(pattern => pattern.test(path));
  }

  /**
   * Get default redirect path after login
   */
  getDefaultRedirectPath(): string {
    return '/momentum';
  }

  /**
   * Determine redirect path after successful authentication
   * Enhanced with better fallback logic and state restoration
   */
  getRedirectPath(): string {
    // First check for pending redirect
    const pendingRedirect = this.getPendingRedirect();
    if (pendingRedirect) {
      console.log('Using pending redirect:', pendingRedirect.redirectTo);
      return pendingRedirect.redirectTo;
    }
    
    // Then check stored location
    const storedLocation = this.getStoredLocation();
    const defaultPath = this.getDefaultRedirectPath();
    
    // Validate stored location
    if (storedLocation && this.shouldStorePath(storedLocation.path)) {
      const fullPath = storedLocation.path + storedLocation.search + storedLocation.hash;
      console.log('Using stored location:', fullPath);
      return fullPath;
    }
    
    console.log('Using default redirect path:', defaultPath);
    return defaultPath;
  }

  /**
   * Enhanced redirect with state preservation
   */
  performRedirect(path?: string): void {
    try {
      const redirectPath = path || this.getRedirectPath();
      console.log('Performing redirect to:', redirectPath);
      
      // Use replace to avoid back button issues
      window.location.replace(redirectPath);
    } catch (error) {
      console.error('Error performing redirect:', error);
      // Fallback to default path
      window.location.replace(this.getDefaultRedirectPath());
    }
  }

  /**
   * Optimize session restoration with cached data
   */
  getOptimizedSessionData(): {
    hasValidSession: boolean;
    cachedData: Record<string, any>;
    lastActivity: number | null;
  } {
    const sessionMetadata = this.getSessionMetadata();
    const cachedData = this.getCachedData();
    
    return {
      hasValidSession: !!sessionMetadata,
      cachedData,
      lastActivity: sessionMetadata?.metadata?.lastActivity || null
    };
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(): void {
    const sessionMetadata = this.getSessionMetadata();
    if (sessionMetadata) {
      this.storeSessionMetadata(sessionMetadata.userId, {
        ...sessionMetadata.metadata,
        lastActivity: Date.now()
      });
    }
  }
}

export const sessionManager = SessionManager.getInstance();