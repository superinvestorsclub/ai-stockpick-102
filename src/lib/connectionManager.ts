/**
 * Database Connection Manager
 * Handles connection health, retry logic, and fallback strategies
 */

import { supabase } from './supabase';

export interface ConnectionHealth {
  isConnected: boolean;
  lastCheck: Date | null;
  retryCount: number;
  error: string | null;
  latency: number | null;
}

export interface HealthMetrics {
  total_connections: number;
  active_connections: number;
  database_size_mb: number;
  status: 'healthy' | 'warning' | 'error';
}

class ConnectionManager {
  private static instance: ConnectionManager;
  private health: ConnectionHealth = {
    isConnected: false,
    lastCheck: null,
    retryCount: 0,
    error: null,
    latency: null
  };
  
  private readonly MAX_RETRIES = 5;
  private readonly RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]; // Exponential backoff
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private listeners: Set<(health: ConnectionHealth) => void> = new Set();

  private constructor() {
    this.startHealthMonitoring();
  }

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  /**
   * Test database connectivity with latency measurement
   */
  async testConnection(): Promise<boolean> {
    const startTime = Date.now();
    
    try {
      console.log('Testing database connection...');
      
      // Use health check function if available, otherwise simple query
      let error = null;
      try {
        const { error: healthError } = await supabase.rpc('check_database_health');
        error = healthError;
      } catch (rpcError) {
        console.warn('Health check function not available, using simple query');
        // Fallback to simple query
        const { error: queryError } = await supabase
          .from('portfolio_constituents')
          .select('id')
          .limit(1);
        error = queryError;
      }
      
      const latency = Date.now() - startTime;
      
      if (error) {
        this.updateHealth({
          isConnected: false,
          lastCheck: new Date(),
          retryCount: this.health.retryCount + 1,
          error: error.message,
          latency: null
        });
        return false;
      }
      
      this.updateHealth({
        isConnected: true,
        lastCheck: new Date(),
        retryCount: 0,
        error: null,
        latency
      });
      
      console.log(`Database connection successful (${latency}ms)`);
      return true;
    } catch (error) {
      const latency = Date.now() - startTime;
      console.error('Database connection test failed:', error);
      
      this.updateHealth({
        isConnected: false,
        lastCheck: new Date(),
        retryCount: this.health.retryCount + 1,
        error: error instanceof Error ? error.message : 'Connection failed',
        latency
      });
      
      return false;
    }
  }

  /**
   * Retry connection with exponential backoff
   */
  async retryConnection(): Promise<boolean> {
    if (this.health.retryCount >= this.MAX_RETRIES) {
      console.log('Max retries reached, giving up');
      return false;
    }

    const delay = this.RETRY_DELAYS[Math.min(this.health.retryCount, this.RETRY_DELAYS.length - 1)];
    console.log(`Retrying connection in ${delay}ms (attempt ${this.health.retryCount + 1}/${this.MAX_RETRIES})`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return this.testConnection();
  }

  /**
   * Get detailed health metrics from database
   */
  async getHealthMetrics(): Promise<HealthMetrics | null> {
    try {
      const { data, error } = await supabase.rpc('monitor_connection_health');
      
      if (error) {
        console.warn('Could not get health metrics:', error);
        return null;
      }
      
      if (!data || data.length === 0) {
        return null;
      }
      
      // Parse metrics from function result
      const metrics: HealthMetrics = {
        total_connections: 0,
        active_connections: 0,
        database_size_mb: 0,
        status: 'healthy'
      };
      
      data.forEach((metric: any) => {
        switch (metric.metric_name) {
          case 'total_connections':
            metrics.total_connections = metric.metric_value;
            break;
          case 'active_connections':
            metrics.active_connections = metric.metric_value;
            break;
          case 'database_size_mb':
            metrics.database_size_mb = metric.metric_value;
            break;
        }
        
        if (metric.status === 'warning' || metric.status === 'error') {
          metrics.status = metric.status;
        }
      });
      
      return metrics;
    } catch (error) {
      console.error('Error getting health metrics:', error);
      return null;
    }
  }

  /**
   * Execute query with retry logic and timeout
   */
  async executeWithRetry<T>(
    queryFn: () => Promise<{ data: T | null; error: any }>,
    maxRetries: number = 3
  ): Promise<{ data: T | null; error: any }> {
    let lastError: any = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Test connection before query
        if (!this.health.isConnected) {
          const connected = await this.testConnection();
          if (!connected && attempt < maxRetries) {
            await this.retryConnection();
            continue;
          }
        }
        
        const result = await queryFn();
        
        if (result.error) {
          lastError = result.error;
          
          // Check if it's a connection-related error
          if (this.isConnectionError(result.error) && attempt < maxRetries) {
            console.log(`Query failed with connection error, retrying... (${attempt + 1}/${maxRetries})`);
            await this.retryConnection();
            continue;
          }
        }
        
        return result;
      } catch (error) {
        lastError = error;
        console.error(`Query attempt ${attempt + 1} failed:`, error);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAYS[attempt] || 1000));
        }
      }
    }
    
    return { data: null, error: lastError };
  }

  /**
   * Check if error is connection-related
   */
  private isConnectionError(error: any): boolean {
    if (!error) return false;
    
    const errorMessage = error.message?.toLowerCase() || '';
    const connectionKeywords = [
      'connection',
      'network',
      'timeout',
      'unreachable',
      'refused',
      'reset',
      'disconnected'
    ];
    
    return connectionKeywords.some(keyword => errorMessage.includes(keyword));
  }

  /**
   * Update health status and notify listeners
   */
  private updateHealth(newHealth: ConnectionHealth): void {
    this.health = { ...newHealth };
    
    // Notify all listeners
    this.listeners.forEach(listener => {
      try {
        listener(this.health);
      } catch (error) {
        console.error('Error in health listener:', error);
      }
    });
  }

  /**
   * Subscribe to health status changes
   */
  onHealthChange(callback: (health: ConnectionHealth) => void): () => void {
    this.listeners.add(callback);
    
    // Immediately call with current health
    callback(this.health);
    
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Start periodic health monitoring
   */
  private startHealthMonitoring(): void {
    // Initial health check
    this.testConnection();
    
    // Periodic health checks
    this.healthCheckTimer = setInterval(() => {
      this.testConnection();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Get current health status
   */
  getHealth(): ConnectionHealth {
    return { ...this.health };
  }

  /**
   * Force immediate health check
   */
  async forceHealthCheck(): Promise<ConnectionHealth> {
    await this.testConnection();
    return this.getHealth();
  }

  /**
   * Reset connection state
   */
  reset(): void {
    this.health = {
      isConnected: false,
      lastCheck: null,
      retryCount: 0,
      error: null,
      latency: null
    };
    
    this.updateHealth(this.health);
  }
}

export const connectionManager = ConnectionManager.getInstance();