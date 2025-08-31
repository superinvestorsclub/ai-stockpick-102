import { supabase } from './supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

export interface PortfolioConstituent {
  id: number;
  user_id?: string;
  quarter: string;
  stock_name: string;
  stock_code: string;
  company_logo_url: string | null;
  weight: number;
  quarterly_returns: number;
  created_at: string;
  updated_at: string;
}

export interface PortfolioSummary {
  quarter: string;
  total_stocks: number;
  avg_returns: number;
  total_weight: number;
  top_performer: string;
  top_performer_return: number;
}

export interface QuarterSummary {
  quarter: string;
  total_stocks: number;
  avg_returns: number;
  total_weight: number;
}

class PortfolioService {
  private realtimeChannel: RealtimeChannel | null = null;
  private userChannel: RealtimeChannel | null = null;
  private subscribers: Set<(data: PortfolioConstituent[]) => void> = new Set();
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private connectionRetries = 0;
  private maxRetries = 3;
  private retryDelay = 1000;
  private isConnected = false;
  private connectionPromise: Promise<boolean> | null = null;

  /**
   * Test database connectivity with retry logic
   */
  private async testConnection(): Promise<boolean> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    
    this.connectionPromise = this._testConnection();
    const result = await this.connectionPromise;
    this.connectionPromise = null;
    return result;
  }

  private async _testConnection(): Promise<boolean> {
    try {
      console.log('Testing database connection...');
      
      const { error } = await supabase
        .from('portfolio_constituents')
        .select('id')
        .limit(1);
      
      if (error) {
        console.warn('Database connection test failed:', error);
        this.isConnected = false;
        return false;
      }
      
      console.log('Database connection successful');
      this.isConnected = true;
      this.connectionRetries = 0;
      return true;
    } catch (error) {
      console.error('Connection test error:', error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Retry connection with exponential backoff
   */
  private async retryConnection(): Promise<boolean> {
    if (this.connectionRetries >= this.maxRetries) {
      console.log('Max connection retries reached');
      return false;
    }
    
    this.connectionRetries++;
    const delay = Math.pow(2, this.connectionRetries - 1) * this.retryDelay;
    
    console.log(`Retrying database connection in ${delay}ms (attempt ${this.connectionRetries}/${this.maxRetries})`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return this.testConnection();
  }
  /**
   * Get cached data or fetch fresh data
   * Enhanced with connection checking and fallback handling
   */
  private async getCachedOrFetch<T>(
    cacheKey: string,
    fetchFn: () => Promise<T>,
    forceFresh = false,
    fallbackData?: T
  ): Promise<T> {
    // Check connection first
    const connected = await this.testConnection();
    if (!connected) {
      console.warn('Database not connected for cache key:', cacheKey);
      
      // Try to get cached data even if connection failed
      const cached = this.cache.get(cacheKey);
      if (cached) {
        console.log('Using stale cached data due to connection issues:', cacheKey);
        return cached.data;
      }
      
      // Return fallback data if available
      if (fallbackData !== undefined) {
        console.log('Using fallback data for:', cacheKey);
        return fallbackData;
      }
      
      // Attempt retry
      const retryConnected = await this.retryConnection();
      if (!retryConnected) {
        throw new Error('Database connection failed and no fallback data available');
      }
    }
    
    if (!forceFresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
        console.log('Returning cached data for:', cacheKey);
        return cached.data;
      }
    }

    console.log('Fetching fresh data for:', cacheKey);
    
    let data: T;
    try {
      data = await fetchFn();
    } catch (fetchError) {
      console.error('Fetch function failed:', fetchError);
      
      // Try cached data as fallback
      const cached = this.cache.get(cacheKey);
      if (cached) {
        console.log('Using cached data as fallback due to fetch error');
        return cached.data;
      }
      
      // Use fallback data if available
      if (fallbackData !== undefined) {
        console.log('Using fallback data due to fetch error');
        return fallbackData;
      }
      
      throw fetchError;
    }
    
    this.cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  }

  /**
   * Ensure user has portfolio data (copy from default if needed)
   * Enhanced with better error handling and fallback logic
   */
  async ensureUserPortfolioData(userId: string): Promise<void> {
    try {
      console.log('Ensuring user portfolio data for:', userId);
      
      // Check connection first
      const connected = await this.testConnection();
      if (!connected) {
        console.warn('Database not connected, skipping portfolio data setup');
        return;
      }
      
      let error = null;
      try {
        const result = await supabase.rpc('ensure_user_portfolio_data', {
          p_user_id: userId
        });
        error = result.error;
      } catch (rpcError) {
        console.warn('RPC call failed:', rpcError);
        
        // Try alternative approach: check if user has any data
        try {
          const { data: existingData, error: checkError } = await supabase
            .from('portfolio_constituents')
            .select('id')
            .eq('user_id', userId)
            .limit(1);
          
          if (checkError) {
            console.warn('Could not check existing user data:', checkError);
            return;
          }
          
          if (!existingData || existingData.length === 0) {
            console.log('No existing user data found, user will see default data');
          }
        } catch (checkError) {
          console.warn('Alternative data check failed:', checkError);
        }
        
        return;
      }

      if (error) {
        console.error('Error ensuring user portfolio data:', error);
        return;
      }
      console.log('Successfully ensured user portfolio data');
    } catch (error) {
      console.error('Error in ensureUserPortfolioData:', error);
    }
  }

  /**
   * Get all portfolio constituents for a specific quarter
   * Enhanced with better error handling and fallback data
   */
  async getPortfolioByQuarter(quarter: string, userId?: string): Promise<PortfolioConstituent[]> {
    const cacheKey = `portfolio_${quarter}_${userId || 'public'}`;
    
    // Fallback data for when database is unavailable
    const fallbackData: PortfolioConstituent[] = [
      {
        id: 1,
        quarter: quarter,
        stock_name: 'Tata Consultancy Services Ltd.',
        stock_code: 'TCS',
        company_logo_url: 'https://logo.clearbit.com/tcs.com',
        weight: 8.33,
        quarterly_returns: 15.2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user_id: userId
      },
      {
        id: 2,
        quarter: quarter,
        stock_name: 'Reliance Industries Ltd.',
        stock_code: 'RELIANCE',
        company_logo_url: 'https://logo.clearbit.com/ril.com',
        weight: 8.33,
        quarterly_returns: 12.8,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user_id: userId
      },
      {
        id: 3,
        quarter: quarter,
        stock_name: 'HDFC Bank Ltd.',
        stock_code: 'HDFCBANK',
        company_logo_url: 'https://logo.clearbit.com/hdfcbank.com',
        weight: 8.33,
        quarterly_returns: 18.5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user_id: userId
      },
      {
        id: 4,
        quarter: quarter,
        stock_name: 'Infosys Ltd.',
        stock_code: 'INFY',
        company_logo_url: 'https://logo.clearbit.com/infosys.com',
        weight: 8.33,
        quarterly_returns: 14.7,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user_id: userId
      }
    ];
    
    return this.getCachedOrFetch(cacheKey, async () => {
      try {
        console.log('Fetching portfolio data for quarter:', quarter, 'user:', userId);
        
        let query = supabase
          .from('portfolio_constituents')
          .select('*')
          .eq('quarter', quarter)
          .order('weight', { ascending: false });

        // Add user filter if authenticated and connected
        if (userId && this.isConnected) {
          // First ensure user has data
          try {
            await this.ensureUserPortfolioData(userId);
          } catch (ensureError) {
            console.warn('Could not ensure user portfolio data:', ensureError);
          }
          query = query.eq('user_id', userId);
        } else {
          // Get public/default data
          query = query.is('user_id', null);
        }

        let data = null;
        let error = null;
        
        try {
          const result = await query;
          data = result.data;
          error = result.error;
        } catch (queryError) {
          console.warn('Database query failed, using mock data:', queryError);
          throw queryError; // Let getCachedOrFetch handle fallback
        }

        if (error) {
          console.error('Error fetching portfolio by quarter:', error);
          
          // Check if it's a connection issue
          if (error.message.includes('connection') || error.message.includes('network') || error.message.includes('timeout')) {
            const retrySuccess = await this.retryConnection();
            if (retrySuccess) {
              // Retry the query once
              const retryResult = await query;
              if (retryResult.error) {
                throw retryResult.error;
              }
              data = retryResult.data;
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }

        console.log('Successfully fetched portfolio data:', data?.length || 0, 'items');
        return data || [];
      } catch (error) {
        console.error('Error in getPortfolioByQuarter:', error);
        throw error; // Let getCachedOrFetch handle fallback
      }
    }, false, fallbackData);
  }

  /**
   * Get portfolio performance summary for user
   */
  async getPortfolioSummary(userId: string, quarter?: string): Promise<PortfolioSummary[]> {
    const cacheKey = `summary_${userId}_${quarter || 'all'}`;
    
    return this.getCachedOrFetch(cacheKey, async () => {
      try {
        const { data, error } = await supabase.rpc('get_user_portfolio_summary', {
          p_user_id: userId,
          p_quarter: quarter || null
        });

        if (error) {
          console.error('Error fetching portfolio summary:', error);
          throw error;
        }

        return data || [];
      } catch (error) {
        console.error('Error in getPortfolioSummary:', error);
        throw error;
      }
    });
  }

  /**
   * Get the latest quarter's portfolio data with user context
   */
  async getLatestPortfolio(userId?: string): Promise<PortfolioConstituent[]> {
    try {
      console.log('Fetching latest portfolio for user:', userId);
      
      let query = supabase
        .from('portfolio_constituents')
        .select('quarter')
        .order('created_at', { ascending: false })
        .limit(1);

      if (userId) {
        await this.ensureUserPortfolioData(userId);
        query = query.eq('user_id', userId);
      } else {
        query = query.is('user_id', null);
      }
      
      const { data: latestQuarter, error: quarterError } = await query;

      if (quarterError) {
        console.error('Error fetching latest quarter:', quarterError);
        throw quarterError;
      }

      if (!latestQuarter || latestQuarter.length === 0) {
        console.log('No quarters found');
        return [];
      }

      console.log('Latest quarter:', latestQuarter[0].quarter);
      // Then get all constituents for that quarter
      return this.getPortfolioByQuarter(latestQuarter[0].quarter, userId);
    } catch (error) {
      console.error('Error in getLatestPortfolio:', error);
      throw error;
    }
  }

  /**
   * Get all available quarters with summary data
   * Enhanced with fallback data and better error handling
   */
  async getQuartersSummary(userId?: string): Promise<QuarterSummary[]> {
    const cacheKey = `quarters_${userId || 'public'}`;
    
    // Fallback quarters data
    const fallbackQuarters: QuarterSummary[] = [
      { quarter: 'Q4 2024', total_stocks: 12, avg_returns: 15.2, total_weight: 100 },
      { quarter: 'Q3 2024', total_stocks: 12, avg_returns: 12.8, total_weight: 100 },
      { quarter: 'Q2 2024', total_stocks: 12, avg_returns: 18.5, total_weight: 100 },
      { quarter: 'Q1 2024', total_stocks: 12, avg_returns: 14.1, total_weight: 100 }
    ];
    
    return this.getCachedOrFetch(cacheKey, async () => {
      try {
        console.log('Fetching quarters summary for user:', userId);
        
        // Check connection
        const connected = await this.testConnection();
        if (!connected) {
          throw new Error('Database connection not available');
        }
        
        let query = supabase
          .from('portfolio_constituents')
          .select('quarter, weight, quarterly_returns')
          .order('quarter', { ascending: false });

        if (userId) {
          try {
            await this.ensureUserPortfolioData(userId);
          } catch (ensureError) {
            console.warn('Could not ensure user data:', ensureError);
          }
          query = query.eq('user_id', userId);
        } else {
          query = query.is('user_id', null);
        }

        let data = null;
        let error = null;
        
        try {
          const result = await query;
          data = result.data;
          error = result.error;
        } catch (queryError) {
          console.warn('Database query failed:', queryError);
          throw queryError;
        }

        if (error) {
          console.error('Error fetching quarters summary:', error);
          throw error;
        }

        if (!data || data.length === 0) {
          console.log('No portfolio data found');
          return fallbackQuarters;
        }

        // Group by quarter and calculate summaries
        const quarterMap = new Map<string, {
          total_stocks: number;
          total_returns: number;
          total_weight: number;
        }>();

        data?.forEach(item => {
          const existing = quarterMap.get(item.quarter) || {
            total_stocks: 0,
            total_returns: 0,
            total_weight: 0
          };

          quarterMap.set(item.quarter, {
            total_stocks: existing.total_stocks + 1,
            total_returns: existing.total_returns + item.quarterly_returns,
            total_weight: existing.total_weight + item.weight
          });
        });

        const summaries = Array.from(quarterMap.entries()).map(([quarter, summary]) => ({
          quarter,
          total_stocks: summary.total_stocks,
          avg_returns: summary.total_returns / summary.total_stocks,
          total_weight: summary.total_weight
        }));
        
        console.log('Quarters summary:', summaries.length, 'quarters found');
        return summaries;
      } catch (error) {
        console.error('Error in getQuartersSummary:', error);
        throw error;
      }
    }, false, fallbackQuarters);
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): { isConnected: boolean; retryCount: number } {
    return {
      isConnected: this.isConnected,
      retryCount: this.connectionRetries
    };
  }

  /**
   * Force connection test
   */
  async forceConnectionTest(): Promise<boolean> {
    this.connectionPromise = null;
    return this.testConnection();
  }

  /**
   * Clear cache for specific keys or all cache
   */
  clearCache(pattern?: string): void {
    try {
      if (pattern) {
        const keysToDelete = Array.from(this.cache.keys()).filter(key => key.includes(pattern));
        keysToDelete.forEach(key => this.cache.delete(key));
        console.log('Cleared cache for pattern:', pattern, 'Keys:', keysToDelete.length);
      } else {
        this.cache.clear();
        console.log('Cleared all cache');
      }
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }

  /**
   * Add a new portfolio constituent
   */
  async addConstituent(constituent: Omit<PortfolioConstituent, 'id' | 'created_at' | 'updated_at'>): Promise<PortfolioConstituent> {
    try {
      // Clear relevant cache
      this.clearCache(constituent.user_id || 'public');
      
      const { data, error } = await supabase
        .from('portfolio_constituents')
        .insert([constituent])
        .select()
        .single();

      if (error) {
        console.error('Error adding constituent:', error);
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error in addConstituent:', error);
      throw error;
    }
  }

  /**
   * Update an existing portfolio constituent
   */
  async updateConstituent(id: number, updates: Partial<PortfolioConstituent>): Promise<PortfolioConstituent> {
    try {
      // Clear cache for affected user
      if (updates.user_id) {
        this.clearCache(updates.user_id);
      }
      
      const { data, error } = await supabase
        .from('portfolio_constituents')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Error updating constituent:', error);
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error in updateConstituent:', error);
      throw error;
    }
  }

  /**
   * Delete a portfolio constituent
   */
  async deleteConstituent(id: number): Promise<void> {
    try {
      // Get the constituent first to clear appropriate cache
      const { data: constituent } = await supabase
        .from('portfolio_constituents')
        .select('user_id')
        .eq('id', id)
        .single();
      
      if (constituent) {
        this.clearCache(constituent.user_id || 'public');
      }
      
      const { error } = await supabase
        .from('portfolio_constituents')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Error deleting constituent:', error);
        throw error;
      }
    } catch (error) {
      console.error('Error in deleteConstituent:', error);
      throw error;
    }
  }

  /**
   * Bulk insert portfolio constituents for a quarter
   */
  async bulkInsertConstituents(constituents: Omit<PortfolioConstituent, 'id' | 'created_at' | 'updated_at'>[]): Promise<PortfolioConstituent[]> {
    try {
      // Clear cache for all affected users
      const userIds = new Set(constituents.map(c => c.user_id).filter(Boolean));
      userIds.forEach(userId => this.clearCache(userId!));
      
      const { data, error } = await supabase
        .from('portfolio_constituents')
        .insert(constituents)
        .select();

      if (error) {
        console.error('Error bulk inserting constituents:', error);
        throw error;
      }

      return data || [];
    } catch (error) {
      console.error('Error in bulkInsertConstituents:', error);
      throw error;
    }
  }

  /**
   * Subscribe to real-time updates for portfolio constituents
   */
  subscribeToUpdates(
    callback: (data: PortfolioConstituent[]) => void, 
    quarter?: string, 
    userId?: string
  ): () => void {
    console.log('Setting up real-time subscription for quarter:', quarter, 'user:', userId);
    this.subscribers.add(callback);

    // Set up user-specific channel if userId provided
    if (userId && !this.userChannel) {
      console.log('Creating user-specific real-time channel...');
      this.userChannel = supabase
        .channel(`portfolio_user_${userId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'portfolio_constituents',
            filter: `user_id=eq.${userId}`
          },
          async (payload) => {
            console.log('User-specific real-time update received:', payload);
            
            // Clear cache for this user
            this.clearCache(userId);
            
            // Fetch updated data and notify all subscribers
            try {
              let updatedData: PortfolioConstituent[];
              
              if (quarter) {
                updatedData = await this.getPortfolioByQuarter(quarter, userId);
              } else {
                updatedData = await this.getLatestPortfolio(userId);
              }

              console.log('Broadcasting update to', this.subscribers.size, 'subscribers');
              // Notify all subscribers
              this.subscribers.forEach(subscriber => {
                try {
                  subscriber(updatedData);
                } catch (error) {
                  console.error('Error in subscriber callback:', error);
                }
              });
            } catch (error) {
              console.error('Error fetching updated data:', error);
            }
          }
        )
        .subscribe((status) => {
          console.log('User real-time subscription status:', status);
          
          if (status === 'SUBSCRIBED') {
            console.log('Successfully subscribed to user real-time updates');
          } else if (status === 'CHANNEL_ERROR') {
            console.error('User real-time subscription error');
            // Attempt to reconnect
            setTimeout(() => {
              console.log('Attempting to reconnect user real-time subscription...');
              this.userChannel?.unsubscribe();
              this.userChannel = null;
              // Re-subscribe will happen on next call
            }, 5000);
          }
        });
    }

    // Set up general channel for public data
    if (!this.realtimeChannel) {
      console.log('Creating general real-time channel...');
      this.realtimeChannel = supabase
        .channel('portfolio_constituents_changes')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'portfolio_constituents',
            filter: 'user_id=is.null'
          },
          async (payload) => {
            console.log('General real-time update received:', payload);
            
            // Clear public cache
            this.clearCache('public');
            
            // Only notify if no user-specific subscription
            if (!userId) {
              try {
                let updatedData: PortfolioConstituent[];
                
                if (quarter) {
                  updatedData = await this.getPortfolioByQuarter(quarter);
                } else {
                  updatedData = await this.getLatestPortfolio();
                }

                this.subscribers.forEach(subscriber => {
                  try {
                    subscriber(updatedData);
                  } catch (error) {
                    console.error('Error in subscriber callback:', error);
                  }
                });
              } catch (error) {
                console.error('Error fetching updated data:', error);
              }
            }
          }
        )
        .subscribe((status) => {
          console.log('General real-time subscription status:', status);
        });
    }

    // Return unsubscribe function
    return () => {
      console.log('Unsubscribing from real-time updates');
      this.subscribers.delete(callback);
      
      // If no more subscribers, close the channel
      if (this.subscribers.size === 0 && this.realtimeChannel) {
        console.log('Closing real-time channels (no more subscribers)');
        this.realtimeChannel.unsubscribe();
        this.realtimeChannel = null;
        
        if (this.userChannel) {
          this.userChannel.unsubscribe();
          this.userChannel = null;
        }
      }
    };
  }

  async getUserHistoricalPerformance(userId: string): Promise<{
    quarter: string;
    avg_returns: number;
    total_stocks: number;
    period: string;
  }[]> {
    const cacheKey = `historical_${userId}`;
    
    return this.getCachedOrFetch(cacheKey, async () => {
      try {
        const quartersSummary = await this.getQuartersSummary(userId);
        
        // Map quarters to readable periods
        const quarterToPeriod = (quarter: string): string => {
          const [q, year] = quarter.split(' ');
          const quarterMap: { [key: string]: string } = {
            'Q1': 'Jan - Mar',
            'Q2': 'Apr - Jun',
            'Q3': 'Jul - Sep',
            'Q4': 'Oct - Dec'
          };
          return `${quarterMap[q]} ${year}`;
        };

        return quartersSummary.map(summary => ({
          quarter: summary.quarter,
          avg_returns: summary.avg_returns,
          total_stocks: summary.total_stocks,
          period: quarterToPeriod(summary.quarter)
        }));
      } catch (error) {
        console.error('Error in getUserHistoricalPerformance:', error);
        throw error;
      }
    });
  }

  /**
   * Search portfolio constituents by stock code or name
   */
  async searchConstituents(searchTerm: string, quarter?: string, userId?: string): Promise<PortfolioConstituent[]> {
    try {
      let query = supabase
        .from('portfolio_constituents')
        .select('*')
        .or(`stock_code.ilike.%${searchTerm}%,stock_name.ilike.%${searchTerm}%`);

      if (quarter) {
        query = query.eq('quarter', quarter);
      }
      
      if (userId) {
        query = query.eq('user_id', userId);
      } else {
        query = query.is('user_id', null);
      }

      const { data, error } = await query.order('weight', { ascending: false });

      if (error) {
        console.error('Error searching constituents:', error);
        throw error;
      }

      return data || [];
    } catch (error) {
      console.error('Error in searchConstituents:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const portfolioService = new PortfolioService();