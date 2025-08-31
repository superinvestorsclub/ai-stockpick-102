import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, UserProfile } from '../lib/supabase';
import { sessionManager } from '../utils/sessionManager';
import { useLocation, useNavigate } from 'react-router-dom';

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  session: Session | null;
  loading: boolean;
  isInitialized: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  restoreSession: () => Promise<void>;
  isConnected: boolean;
  connectionError: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 3;

  // Test database connectivity
  const testConnection = async (): Promise<boolean> => {
    try {
      setConnectionError(null);
      
      // Simple connectivity test
      const { error } = await supabase
        .from('user_profiles')
        .select('id')
        .limit(1);
      
      if (error) {
        console.warn('Database connection test failed:', error);
        setConnectionError(error.message);
        setIsConnected(false);
        return false;
      }
      
      setIsConnected(true);
      setRetryCount(0);
      return true;
    } catch (error) {
      console.error('Connection test error:', error);
      setConnectionError(error instanceof Error ? error.message : 'Connection failed');
      setIsConnected(false);
      return false;
    }
  };

  // Retry connection with exponential backoff
  const retryConnection = async (): Promise<void> => {
    if (retryCount >= maxRetries) {
      console.log('Max retries reached, giving up');
      return;
    }
    
    const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
    console.log(`Retrying connection in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`);
    
    setTimeout(async () => {
      setRetryCount(prev => prev + 1);
      await testConnection();
    }, delay);
  };

  useEffect(() => {
    // Test initial connection
    testConnection();
    
    // Get initial session
    const getInitialSession = async () => {
      try {
        setLoading(true);
        
        // Wait for connection before proceeding
        const isConnected = await testConnection();
        if (!isConnected) {
          console.warn('Database not connected, proceeding with limited functionality');
        }
        
        let session = null;
        let error = null;
        
        try {
          const result = await supabase.auth.getSession();
          session = result.data.session;
          error = result.error;
        } catch (authError) {
          console.warn('Auth service not available:', authError);
          error = authError;
        }
        
        if (error) {
          console.error('Error getting session:', error);
          setConnectionError(error.message);
        } else {
          setSession(session);
          setUser(session?.user ?? null);
          if (session?.user) {
            await fetchUserProfile(session.user.id);
          }
        }
      } catch (error) {
        console.error('Error in getInitialSession:', error);
        setConnectionError(error instanceof Error ? error.message : 'Initialization failed');
        // Continue without auth if Supabase is not configured
        setSession(null);
        setUser(null);
      } finally {
        setLoading(false);
        setIsInitialized(true);
      }
    };

    getInitialSession();

    // Listen for auth changes
    let subscription: any = null;
    
    try {
      const { data } = supabase.auth.onAuthStateChange(
        async (event, session) => {
          console.log('Auth state change:', event, session?.user?.id);
          
          setSession(session);
          setUser(session?.user ?? null);
          
          if (session?.user) {
            await fetchUserProfile(session.user.id);
            
            // Store session metadata for performance optimization
            sessionManager.storeSessionMetadata(session.user.id, {
              lastLogin: new Date().toISOString(),
              subscription: userProfile?.subscription_status || 'free'
            });
            
            // Handle post-login redirect
            if (event === 'SIGNED_IN') {
              console.log('User signed in, handling redirect...');
              
              // Small delay to ensure all state is set
              setTimeout(() => {
                const redirectPath = sessionManager.getRedirectPath();
                console.log('Redirecting to:', redirectPath);
                
                // Use sessionManager's enhanced redirect
                sessionManager.performRedirect(redirectPath);
              }, 500);
            }
          } else {
            setUserProfile(null);
            sessionManager.clearAll();
          }
          
          // Clear stored location on sign out
          if (event === 'SIGNED_OUT') {
            sessionManager.clearAll();
          }
          
          setLoading(false);
        }
      );
      subscription = data.subscription;
    } catch (error) {
      console.error('Error setting up auth listener:', error);
      setConnectionError(error instanceof Error ? error.message : 'Auth setup failed');
      setLoading(false);
    }

    return () => {
      if (subscription) {
        subscription.unsubscribe();
      }
    };
  }, []);

  const fetchUserProfile = async (userId: string) => {
    try {
      console.log('Fetching user profile for:', userId);
      
      // Check connection before proceeding
      if (!isConnected) {
        console.warn('Database not connected, skipping profile fetch');
        return;
      }
      
      // First ensure user has portfolio data
      try {
        const { error: rpcError } = await supabase.rpc('ensure_user_portfolio_data', {
          p_user_id: userId
        });
        if (rpcError) {
          console.warn('Could not ensure portfolio data:', rpcError);
          // Don't fail completely, continue with profile fetch
        }
      } catch (rpcError) {
        console.warn('RPC call failed:', rpcError);
        // Continue without portfolio data setup
      }
      
      let data = null;
      let error = null;
      
      try {
        const result = await supabase
          .from('user_profiles')
          .select('*')
          .eq('id', userId)
          .single();
        data = result.data;
        error = result.error;
      } catch (fetchError) {
        console.warn('Could not fetch user profile:', fetchError);
        error = fetchError;
      }

      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching user profile:', error);
        return;
      }

      if (data) {
        setUserProfile(data);
        
        // Update session metadata with profile info
        sessionManager.storeSessionMetadata(userId, {
          subscription: data.subscription_status,
          lastProfileUpdate: data.updated_at
        });
      } else {
        // Create user profile if it doesn't exist
        try {
          await createUserProfile(userId);
        } catch (createError) {
          console.warn('Could not create user profile:', createError);
        }
      }
    } catch (error) {
      console.error('Error in fetchUserProfile:', error);
    }
  };

  const createUserProfile = async (userId: string) => {
    try {
      console.log('Creating user profile for:', userId);
      
      const { data, error } = await supabase
        .from('user_profiles')
        .insert([
          {
            id: userId,
            email: user?.email || '',
            full_name: user?.user_metadata?.full_name || null,
            avatar_url: user?.user_metadata?.avatar_url || null,
            subscription_status: 'free'
          }
        ])
        .select()
        .single();

      if (error) {
        console.error('Error creating user profile:', error);
        // Don't throw error, just log it
        return;
      } else {
        setUserProfile(data);
        console.log('User profile created successfully');
      }
    } catch (error) {
      console.error('Error in createUserProfile:', error);
    }
  };

  const signInWithGoogle = async () => {
    try {
      // Store current location before redirecting to auth
      const currentPath = window.location.pathname;
      const currentSearch = window.location.search;
      const currentHash = window.location.hash;
      
      if (sessionManager.shouldStorePath(currentPath)) {
        sessionManager.storeLocation(currentPath, currentSearch, currentHash);
        
        // Also store as pending redirect for extra safety
        const fullPath = currentPath + currentSearch + currentHash;
        sessionManager.storePendingRedirect(fullPath, {
          timestamp: Date.now(),
          source: 'google_oauth'
        });
      }
      
      let error = null;
      
      try {
        const result = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: `${window.location.origin}/auth/callback`,
            queryParams: {
              access_type: 'offline',
              prompt: 'consent'
            }
          }
        });
        error = result.error;
      } catch (authError) {
        console.error('OAuth initiation failed:', authError);
        error = authError;
      }
      
      if (error) {
        console.error('Error signing in with Google:', error);
        setConnectionError(error.message);
        
        // Clear stored redirects on error
        sessionManager.clearPendingRedirect();
        
        // Show user-friendly error message
        if (error.message.includes('not configured') || error.message.includes('provider')) {
          alert('Google sign-in is not configured yet. Please check the setup guide.');
        } else {
          alert(`Sign-in failed: ${error.message}. Please try again.`);
        }
        return;
      }
    } catch (error) {
      console.error('Error in signInWithGoogle:', error);
      setConnectionError(error instanceof Error ? error.message : 'Sign-in failed');
      alert('Sign-in failed. Please try again later.');
    }
  };

  // Enhanced location tracking with better URL handling
  useEffect(() => {
    if (user && isInitialized && typeof window !== 'undefined') {
      const currentPath = window.location.pathname;
      const currentSearch = window.location.search;
      const currentHash = window.location.hash;
      
      if (sessionManager.shouldStorePath(currentPath)) {
        sessionManager.storeLocation(currentPath, currentSearch, currentHash);
      }
    }
  }, [user, isInitialized]);

  // Connection health monitoring
  useEffect(() => {
    if (!isInitialized) return;
    
    const healthCheck = setInterval(async () => {
      if (!isConnected && retryCount < maxRetries) {
        console.log('Connection lost, attempting to reconnect...');
        await retryConnection();
      }
    }, 30000); // Check every 30 seconds
    
    return () => clearInterval(healthCheck);
  }, [isInitialized, isConnected, retryCount]);

  const signOut = async () => {
    try {
      setLoading(true);
      sessionManager.clearAll();
      
      let error = null;
      try {
        const result = await supabase.auth.signOut();
        error = result.error;
      } catch (signOutError) {
        console.warn('Sign out service call failed:', signOutError);
        // Continue with local cleanup even if service call fails
      }
      
      if (error) {
        console.error('Error signing out:', error);
        // Don't throw error, just log it and continue with cleanup
      }
      
      // Force clear local state
      setSession(null);
      setUser(null);
      setUserProfile(null);
      
    } catch (error) {
      console.error('Error in signOut:', error);
      // Don't throw error, ensure cleanup happens
    } finally {
      setLoading(false);
    }
  };
  
  const restoreSession = async () => {
    try {
      console.log('Restoring session...');
      setLoading(true);
      
      // Test connection first
      const connected = await testConnection();
      if (!connected) {
        console.warn('Database not connected, skipping session restore');
        setLoading(false);
        return;
      }
      
      let session = null;
      let error = null;
      
      try {
        const result = await supabase.auth.getSession();
        session = result.data.session;
        error = result.error;
      } catch (sessionError) {
        console.warn('Session restore failed:', sessionError);
        error = sessionError;
      }
      
      if (error) {
        console.error('Error restoring session:', error);
        setConnectionError(error.message);
        return;
      }
      
      if (session?.user) {
        setSession(session);
        setUser(session.user);
        await fetchUserProfile(session.user.id);
        console.log('Session restored successfully');
      } else {
        console.log('No valid session found');
      }
    } catch (error) {
      console.error('Error in restoreSession:', error);
      setConnectionError(error instanceof Error ? error.message : 'Session restore failed');
    } finally {
      setLoading(false);
    }
  };
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`
        }
      });
      
      if (error) {
        console.error('Error signing in with Google:', error);
        // Show user-friendly error message
        alert('Google sign-in is not configured yet. Please check the setup guide.');
        return;
      }
    } catch (error) {
      console.error('Error in signInWithGoogle:', error);
      alert('Sign-in failed. Please try again later.');
    }
  };

  // Track user navigation for session restoration
  useEffect(() => {
    if (user && isInitialized) {
      const currentPath = window.location.pathname + window.location.search;
      if (sessionManager.shouldStorePath(currentPath)) {
        sessionManager.storeLocation(currentPath);
      }
    }
  }, [user, isInitialized]);

  const signOut = async () => {
    try {
      setLoading(true);
      sessionManager.clearAll();
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('Error signing out:', error);
        throw error;
      }
    } catch (error) {
      console.error('Error in signOut:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };
  
  const restoreSession = async () => {
    try {
      console.log('Restoring session...');
      setLoading(true);
      
      const { data: { session }, error } = await supabase.auth.getSession();
      
      if (error) {
        console.error('Error restoring session:', error);
        return;
      }
      
      if (session?.user) {
        setSession(session);
        setUser(session.user);
        await fetchUserProfile(session.user.id);
        console.log('Session restored successfully');
      } else {
        console.log('No valid session found');
      }
    } catch (error) {
      console.error('Error in restoreSession:', error);
    } finally {
      setLoading(false);
    }
  };

  // Optimize initial load by checking stored session metadata
  useEffect(() => {
    const sessionMetadata = sessionManager.getSessionMetadata();
    if (sessionMetadata && !user && !loading) {
      console.log('Found stored session metadata, attempting restore...');
      restoreSession();
    }
  }, [user, loading]);

  const value = {
    user,
    userProfile,
    session,
    loading,
    isInitialized,
    signInWithGoogle,
    signOut,
    restoreSession,
    isConnected,
    connectionError
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};