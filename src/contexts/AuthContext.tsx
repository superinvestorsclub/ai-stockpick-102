import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, UserProfile } from '../lib/supabase';
import { sessionManager } from '../utils/sessionManager';

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  session: Session | null;
  loading: boolean;
  isInitialized: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  restoreSession: () => Promise<void>;
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
  useEffect(() => {
    // Get initial session
    const getInitialSession = async () => {
      try {
        setLoading(true);
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
          console.error('Error getting session:', error);
        } else {
          setSession(session);
          setUser(session?.user ?? null);
          if (session?.user) {
            await fetchUserProfile(session.user.id);
          }
        }
      } catch (error) {
        console.error('Error in getInitialSession:', error);
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
          } else {
            setUserProfile(null);
            sessionManager.clearAll();
          }
          
          // Handle successful login - restore user's last location
          if (event === 'SIGNED_IN') {
            const redirectPath = sessionManager.getRedirectPath();
            if (redirectPath !== '/') {
              // Small delay to ensure all auth state is properly set
              setTimeout(() => {
                window.location.href = redirectPath;
              }, 100);
            }
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
      
      // First ensure user has portfolio data
      try {
        const { error: rpcError } = await supabase.rpc('ensure_user_portfolio_data', {
          p_user_id: userId
        });
        if (rpcError) {
          console.warn('Could not ensure portfolio data:', rpcError);
        }
      } catch (rpcError) {
        console.warn('RPC call failed:', rpcError);
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
      const currentPath = window.location.pathname + window.location.search;
      if (sessionManager.shouldStorePath(currentPath)) {
        sessionManager.storeLocation(currentPath);
      }
      
      const { error } = await supabase.auth.signInWithOAuth({
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
    restoreSession
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};