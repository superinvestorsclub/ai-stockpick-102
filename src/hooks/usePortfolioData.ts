import { useState, useEffect, useCallback } from 'react';
import { portfolioService, PortfolioConstituent, QuarterSummary, PortfolioSummary } from '../lib/portfolioService';
import { useAuth } from '../contexts/AuthContext';
import { mockPortfolioData, mockQuartersSummary } from '../data/mockPortfolioData';
import { sessionManager } from '../utils/sessionManager';

interface UsePortfolioDataReturn {
  portfolioData: PortfolioConstituent[];
  portfolioSummary: PortfolioSummary[];
  quarters: QuarterSummary[];
  loading: boolean;
  error: string | null;
  selectedQuarter: string | null;
  setSelectedQuarter: (quarter: string) => void;
  refreshData: () => Promise<void>;
  addConstituent: (constituent: Omit<PortfolioConstituent, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  updateConstituent: (id: number, updates: Partial<PortfolioConstituent>) => Promise<void>;
  deleteConstituent: (id: number) => Promise<void>;
  isDataStale: boolean;
  connectionStatus: { isConnected: boolean; retryCount: number };
  retryConnection: () => Promise<void>;
}

export const usePortfolioData = (initialQuarter?: string): UsePortfolioDataReturn => {
  const [portfolioData, setPortfolioData] = useState<PortfolioConstituent[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary[]>([]);
  const [quarters, setQuarters] = useState<QuarterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedQuarter, setSelectedQuarter] = useState<string | null>(initialQuarter || null);
  const [isDataStale, setIsDataStale] = useState(false);
  const [lastFetchTime, setLastFetchTime] = useState<number>(0);
  
  const { user, isInitialized, userProfile, isConnected, connectionError } = useAuth();

  // Data freshness check (5 minutes)
  const DATA_FRESHNESS_THRESHOLD = 2 * 60 * 1000; // Reduced to 2 minutes for better UX

  // Get connection status from service
  const [connectionStatus, setConnectionStatus] = useState({ isConnected: false, retryCount: 0 });

  // Update connection status periodically
  useEffect(() => {
    const updateConnectionStatus = () => {
      const status = portfolioService.getConnectionStatus();
      setConnectionStatus(status);
    };
    
    updateConnectionStatus();
    const interval = setInterval(updateConnectionStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Retry connection function
  const retryConnection = useCallback(async () => {
    try {
      console.log('Retrying database connection...');
      setError(null);
      const connected = await portfolioService.forceConnectionTest();
      
      if (connected) {
        console.log('Connection restored, refreshing data...');
        await refreshData();
      } else {
        setError('Unable to establish database connection. Using cached data.');
      }
    } catch (error) {
      console.error('Error retrying connection:', error);
      setError('Connection retry failed. Please check your internet connection.');
    }
  }, []);

  // Load quarters summary
  const loadQuarters = useCallback(async () => {
    try {
      console.log('Loading quarters for user:', user?.id);
      
      let quartersData: QuarterSummary[];
      try {
        quartersData = await portfolioService.getQuartersSummary(user?.id);
      } catch (serviceError) {
        console.warn('Quarters service failed:', serviceError);
        setError(`Failed to load quarters: ${serviceError instanceof Error ? serviceError.message : 'Unknown error'}`);
        quartersData = mockQuartersSummary;
      }
      
      setQuarters(quartersData);
      
      // Set default quarter if none selected
      if (!selectedQuarter && quartersData.length > 0) {
        setSelectedQuarter(quartersData[0].quarter);
      }
      
      setLastFetchTime(Date.now());
      setIsDataStale(false);
    } catch (err) {
      console.error('Error loading quarters:', err);
      setError(`Error loading quarters: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setQuarters(mockQuartersSummary);
      if (!selectedQuarter) {
        setSelectedQuarter(mockQuartersSummary[0].quarter);
      }
      setIsDataStale(true);
    }
  }, [selectedQuarter, user?.id]);

  // Load portfolio summary
  const loadPortfolioSummary = useCallback(async () => {
    if (!user?.id) return;

    try {
      console.log('Loading portfolio summary for user:', user.id);
      let summaryData: PortfolioSummary[];
      try {
        summaryData = await portfolioService.getPortfolioSummary(user.id, selectedQuarter || undefined);
      } catch (serviceError) {
        console.warn('Portfolio summary service failed:', serviceError);
        // Don't set error for summary as it's not critical
        summaryData = [];
      }
      setPortfolioSummary(summaryData);
    } catch (err) {
      console.error('Error loading portfolio summary:', err);
      setPortfolioSummary([]);
    }
  }, [user?.id, selectedQuarter]);

  // Load portfolio data for selected quarter
  const loadPortfolioData = useCallback(async () => {
    if (!selectedQuarter) return;

    try {
      setLoading(true);
      setError(null);
      console.log('Loading portfolio data for quarter:', selectedQuarter, 'user:', user?.id);
      
      let data: PortfolioConstituent[];
      try {
        data = await portfolioService.getPortfolioByQuarter(selectedQuarter, user?.id);
      } catch (serviceError) {
        console.warn('Portfolio service failed:', serviceError);
        setError(`Failed to load portfolio data: ${serviceError instanceof Error ? serviceError.message : 'Unknown error'}`);
        data = mockPortfolioData.filter(item => item.quarter === selectedQuarter);
        setIsDataStale(true);
      }
      
      console.log('Loaded portfolio data:', data.length, 'items');
      setPortfolioData(data || []);
      
      if (!error) {
        setLastFetchTime(Date.now());
        setIsDataStale(false);
      }
    } catch (err) {
      console.error('Error loading portfolio data:', err);
      setError(`Error loading portfolio data: ${err instanceof Error ? err.message : 'Unknown error'}`);
      const mockData = mockPortfolioData.filter(item => item.quarter === selectedQuarter);
      setPortfolioData(mockData);
      setIsDataStale(true);
    } finally {
      setLoading(false);
    }
  }, [selectedQuarter, user?.id]);

  // Check if data is stale and needs refresh
  const checkDataFreshness = useCallback(() => {
    const now = Date.now();
    const isStale = (now - lastFetchTime) > DATA_FRESHNESS_THRESHOLD;
    setIsDataStale(isStale);
    return isStale;
  }, [lastFetchTime]);

  // Refresh all data
  const refreshData = useCallback(async () => {
    console.log('Refreshing all data...');
    setError(null);
    
    // Clear service cache first
    portfolioService.clearCache(user?.id || 'public');
    
    try {
      // Test connection first
      const connected = await portfolioService.forceConnectionTest();
      if (!connected) {
        setError('Database connection failed. Using cached data.');
        return;
      }
      
      const promises = [loadQuarters(), loadPortfolioData()];
      if (user?.id) {
        promises.push(loadPortfolioSummary());
      }
      
      await Promise.all(promises);
    } catch (error) {
      console.error('Error refreshing data:', error);
      setError(`Refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [loadQuarters, loadPortfolioData, loadPortfolioSummary, user?.id]);

  // Force refresh when user authentication changes
  const forceRefresh = useCallback(async () => {
    if (user && isInitialized) {
      console.log('User authenticated, forcing data refresh...');
      setLoading(true);
      setError(null);
      
      try {
        await refreshData();
      } catch (error) {
        console.error('Force refresh failed:', error);
        setError(`Failed to load user data: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setLoading(false);
      }
    }
  }, [user, isInitialized, refreshData]);

  // CRUD operations
  const addConstituent = useCallback(async (constituent: Omit<PortfolioConstituent, 'id' | 'created_at' | 'updated_at'>) => {
    try {
      // Check connection first
      const connected = await portfolioService.forceConnectionTest();
      if (!connected) {
        throw new Error('Database connection not available');
      }
      
      // Add user_id if authenticated
      const constituentWithUser = {
        ...constituent,
        user_id: user?.id
      };
      
      await portfolioService.addConstituent(constituentWithUser);
      // Data will be updated via real-time subscription
      setIsDataStale(false);
    } catch (err) {
      console.error('Error adding constituent:', err);
      setError(err instanceof Error ? err.message : 'Failed to add constituent');
      throw err;
    }
  }, [user?.id]);

  const updateConstituent = useCallback(async (id: number, updates: Partial<PortfolioConstituent>) => {
    try {
      const connected = await portfolioService.forceConnectionTest();
      if (!connected) {
        throw new Error('Database connection not available');
      }
      
      await portfolioService.updateConstituent(id, updates);
      // Data will be updated via real-time subscription
      setIsDataStale(false);
    } catch (err) {
      console.error('Error updating constituent:', err);
      setError(err instanceof Error ? err.message : 'Failed to update constituent');
      throw err;
    }
  }, []);

  const deleteConstituent = useCallback(async (id: number) => {
    try {
      const connected = await portfolioService.forceConnectionTest();
      if (!connected) {
        throw new Error('Database connection not available');
      }
      
      await portfolioService.deleteConstituent(id);
      // Data will be updated via real-time subscription
      setIsDataStale(false);
    } catch (err) {
      console.error('Error deleting constituent:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete constituent');
      throw err;
    }
  }, []);

  // Handle quarter selection change
  const handleQuarterChange = useCallback((quarter: string) => {
    console.log('Quarter changed to:', quarter);
    setSelectedQuarter(quarter);
    setError(null); // Clear any previous errors
    
    // Store user preference
    if (user?.id) {
      sessionManager.storeSessionMetadata(user.id, {
        lastSelectedQuarter: quarter,
        lastQuarterChange: Date.now()
      });
    }
  }, []);

  // Initial data load when auth is initialized
  useEffect(() => {
    if (isInitialized) {
      console.log('Auth initialized, loading initial data...');
      loadQuarters();
    }
  }, [isInitialized, loadQuarters]);

  // Force refresh when user logs in
  useEffect(() => {
    if (user && isInitialized && portfolioData.length === 0) {
      console.log('User logged in, forcing data refresh...');
      forceRefresh();
    }
  }, [user, isInitialized, portfolioData.length, forceRefresh]);

  // Load portfolio data when quarter changes
  useEffect(() => {
    if (selectedQuarter && isInitialized) {
      Promise.all([
        loadPortfolioData(),
        user?.id ? loadPortfolioSummary() : Promise.resolve()
      ]);
    }
  }, [selectedQuarter, isInitialized, loadPortfolioData, loadPortfolioSummary, user?.id]);

  // Periodic data freshness check
  useEffect(() => {
    const interval = setInterval(() => {
      if (checkDataFreshness() && user) {
        console.log('Data is stale, refreshing...');
        refreshData();
      }
    }, 60000); // Check every minute

    return () => clearInterval(interval);
  }, [checkDataFreshness, refreshData, user]);

  // Set up real-time subscription
  useEffect(() => {
    if (!selectedQuarter) return;

    console.log('Setting up real-time subscription for quarter:', selectedQuarter, 'user:', user?.id);

    let unsubscribe: (() => void) | null = null;
    
    try {
      unsubscribe = portfolioService.subscribeToUpdates(
        (updatedData) => {
          console.log('Received real-time update:', updatedData);
          setPortfolioData(updatedData);
          setError(null);
          setIsDataStale(false);
          setLastFetchTime(Date.now());
        },
        selectedQuarter,
        user?.id
      );
    } catch (subscriptionError) {
      console.warn('Real-time subscription failed:', subscriptionError);
      // Continue without real-time updates
    }

    return () => {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (error) {
          console.warn('Error unsubscribing from real-time updates:', error);
        }
      }
    };
  }, [selectedQuarter, user?.id]);

  // Preload data when user logs in
  useEffect(() => {
    if (user?.id && isInitialized && portfolioData.length === 0) {
      console.log('User logged in, preloading data...');
      
      try {
        // Check for stored quarter preference
        const sessionMetadata = sessionManager.getSessionMetadata();
        const preferredQuarter = sessionMetadata?.metadata?.lastSelectedQuarter;
        
        if (preferredQuarter && !selectedQuarter) {
          console.log('Restoring preferred quarter:', preferredQuarter);
          setSelectedQuarter(preferredQuarter);
        }
        
        // Ensure user has portfolio data
        portfolioService.ensureUserPortfolioData(user.id)
          .then(() => {
            console.log('User portfolio data ensured, refreshing...');
            refreshData();
          })
          .catch(error => {
            console.warn('Error ensuring user portfolio data:', error);
            setError(`Failed to initialize user data: ${error instanceof Error ? error.message : 'Unknown error'}`);
            
            // Load mock data as fallback
            setPortfolioData(mockPortfolioData);
            setQuarters(mockQuartersSummary);
            if (!selectedQuarter) {
              setSelectedQuarter(mockQuartersSummary[0].quarter);
            }
            setIsDataStale(true);
          });
      } catch (error) {
        console.error('Portfolio service initialization failed:', error);
        setError('Portfolio service unavailable. Using demo data.');
        setPortfolioData(mockPortfolioData);
        setQuarters(mockQuartersSummary);
        if (!selectedQuarter) {
          setSelectedQuarter(mockQuartersSummary[0].quarter);
        }
        setIsDataStale(true);
      }
    }
  }, [user?.id, isInitialized, portfolioData.length, refreshData, selectedQuarter]);

  return {
    portfolioData,
    portfolioSummary,
    quarters,
    loading,
    error,
    selectedQuarter,
    setSelectedQuarter: handleQuarterChange,
    refreshData,
    addConstituent,
    updateConstituent,
    deleteConstituent,
    isDataStale,
    connectionStatus,
    retryConnection
  };
};