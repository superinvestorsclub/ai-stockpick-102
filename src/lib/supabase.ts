import { createClient } from '@supabase/supabase-js';
import { connectionManager } from './connectionManager';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Create a mock client if environment variables are missing
const createSupabaseClient = () => {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase environment variables not found, using mock client');
    // Return a mock client for development
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signInWithOAuth: () => Promise.resolve({ data: null, error: new Error('Supabase not configured') }),
        signOut: () => Promise.resolve({ error: null })
      },
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) })
      }),
      rpc: () => Promise.resolve({ data: null, error: null }),
      channel: () => ({
        on: () => ({ subscribe: () => {} }),
        unsubscribe: () => {}
      })
    };
  }
  
  // Create client with enhanced configuration
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    },
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    },
    global: {
      headers: {
        'X-Client-Info': 'passive-wealth-app'
      }
    }
  });
  
  // Set up connection monitoring
  connectionManager.onHealthChange((health) => {
    if (!health.isConnected && health.error) {
      console.warn('Database connection issue detected:', health.error);
    }
  });
  
  return client;
};

export const supabase = createSupabaseClient() as any;

// Database types
export interface UserPreferences {
  id: string;
  user_id: string;
  preferences: Record<string, any>;
  cache_data: Record<string, any>;
  last_portfolio_quarter: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  subscription_status: 'free' | 'premium';
  created_at: string;
  updated_at: string;
}

export interface UserSession {
  id: string;
  user_id: string;
  session_token: string;
  expires_at: string;
  created_at: string;
}

export interface PortfolioPerformanceSummary {
  user_id: string;
  quarter: string;
  total_stocks: number;
  avg_returns: number;
  total_weight: number;
  best_performer: number;
  worst_performer: number;
  volatility: number;
  updated_at: string;
}