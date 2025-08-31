import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/AuthContext';
import Header from './components/Header';
import HeroSection from './components/HeroSection';
import StockTable from './components/StockTable';
import Footer from './components/Footer';
import BacktestHistory from './components/BacktestHistory';
import MomentumPortfolio from './components/MomentumPortfolio';
import PortfolioAdmin from './components/PortfolioAdmin';
import { mockStockData } from './data/mockData';

// Component to handle OAuth callback
function AuthCallback() {
  const navigate = useNavigate();
  const location = useLocation();
  const { restoreSession, isConnected, connectionError } = useAuth();
  const [status, setStatus] = useState<'processing' | 'redirecting' | 'error'>('processing');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const handleAuthCallback = async () => {
      try {
        console.log('Handling auth callback...');
        setStatus('processing');
        
        // Wait for connection to be established
        let connectionAttempts = 0;
        const maxConnectionAttempts = 10;
        
        while (!isConnected && connectionAttempts < maxConnectionAttempts) {
          console.log(`Waiting for database connection... (${connectionAttempts + 1}/${maxConnectionAttempts})`);
          await new Promise(resolve => setTimeout(resolve, 500));
          connectionAttempts++;
        }
        
        if (!isConnected && connectionError) {
          console.warn('Proceeding without database connection:', connectionError);
        }
        
        // Restore session to ensure all auth state is properly set
        try {
          await restoreSession();
        } catch (restoreError) {
          console.warn('Session restore failed, continuing with redirect:', restoreError);
        }
        
        setStatus('redirecting');
        
        // Enhanced redirect logic using sessionManager
        const redirectTo = sessionManager.getRedirectPath();
        
        console.log('Redirecting to:', redirectTo);
        
        // Use sessionManager's enhanced redirect
        sessionManager.performRedirect(redirectTo);

      } catch (error) {
        console.error('Error handling auth callback:', error);
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Authentication failed');
        
        // Fallback redirect after error
        setTimeout(() => {
          navigate('/', { replace: true });
        }, 3000);
      }
    };

    handleAuthCallback();
  }, [navigate, location, restoreSession, isConnected, connectionError]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        {status === 'processing' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Completing sign in...</p>
            {!isConnected && (
              <p className="text-sm text-orange-600 mt-2">Establishing database connection...</p>
            )}
          </>
        )}
        
        {status === 'redirecting' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Redirecting to your page...</p>
          </>
        )}
        
        {status === 'error' && (
          <>
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-red-600 text-xl">!</span>
            </div>
            <p className="text-red-600 mb-2">Authentication Error</p>
            <p className="text-sm text-gray-600">{errorMessage}</p>
            <p className="text-xs text-gray-500 mt-2">Redirecting to home page...</p>
          </>
        )}
      </div>
    </div>
  );
}

function HomePage() {
  const [stocks, setStocks] = useState(mockStockData);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate API loading
    const timer = setTimeout(() => {
      setLoading(false);
    }, 1500);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <HeroSection />
      <main className="container mx-auto px-4 py-8">
        <StockTable stocks={stocks} loading={loading} />
      </main>
      <Footer />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/backtest" element={<BacktestHistory />} />
          <Route path="/momentum" element={<MomentumPortfolio />} />
          <Route path="/admin" element={<PortfolioAdmin />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;