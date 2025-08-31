/**
 * Centralized Error Handling Utilities
 * Provides consistent error handling across the application
 */

export interface AppError {
  type: 'auth' | 'database' | 'network' | 'validation' | 'unknown';
  message: string;
  originalError?: any;
  timestamp: Date;
  context?: Record<string, any>;
}

export interface ErrorHandlerOptions {
  showToUser?: boolean;
  logToConsole?: boolean;
  retryable?: boolean;
  fallbackData?: any;
}

class ErrorHandler {
  private static instance: ErrorHandler;
  private errorLog: AppError[] = [];
  private readonly MAX_LOG_SIZE = 100;

  private constructor() {}

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  /**
   * Handle and categorize errors
   */
  handleError(
    error: any, 
    context: string, 
    options: ErrorHandlerOptions = {}
  ): AppError {
    const {
      showToUser = false,
      logToConsole = true,
      retryable = false
    } = options;

    const appError: AppError = {
      type: this.categorizeError(error),
      message: this.extractErrorMessage(error),
      originalError: error,
      timestamp: new Date(),
      context: { context, retryable, ...options }
    };

    // Log to console if requested
    if (logToConsole) {
      console.error(`[${appError.type.toUpperCase()}] ${context}:`, appError.message, error);
    }

    // Add to error log
    this.addToLog(appError);

    // Show to user if requested
    if (showToUser) {
      this.showUserError(appError);
    }

    return appError;
  }

  /**
   * Categorize error by type
   */
  private categorizeError(error: any): AppError['type'] {
    if (!error) return 'unknown';

    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code?.toLowerCase() || '';

    // Authentication errors
    if (errorMessage.includes('auth') || errorMessage.includes('unauthorized') || 
        errorMessage.includes('forbidden') || errorCode.includes('auth')) {
      return 'auth';
    }

    // Database errors
    if (errorMessage.includes('database') || errorMessage.includes('sql') || 
        errorMessage.includes('relation') || errorCode.startsWith('pg') ||
        errorCode.includes('pgrst')) {
      return 'database';
    }

    // Network errors
    if (errorMessage.includes('network') || errorMessage.includes('connection') ||
        errorMessage.includes('timeout') || errorMessage.includes('fetch') ||
        errorMessage.includes('cors')) {
      return 'network';
    }

    // Validation errors
    if (errorMessage.includes('validation') || errorMessage.includes('invalid') ||
        errorMessage.includes('required') || errorCode.includes('validation')) {
      return 'validation';
    }

    return 'unknown';
  }

  /**
   * Extract user-friendly error message
   */
  private extractErrorMessage(error: any): string {
    if (!error) return 'An unknown error occurred';

    // Handle Supabase errors
    if (error.message) {
      const message = error.message;
      
      // Common Supabase error translations
      if (message.includes('JWT expired')) {
        return 'Your session has expired. Please sign in again.';
      }
      
      if (message.includes('Invalid API key')) {
        return 'Configuration error. Please contact support.';
      }
      
      if (message.includes('relation') && message.includes('does not exist')) {
        return 'Database table not found. The application may need setup.';
      }
      
      if (message.includes('connection')) {
        return 'Unable to connect to database. Please check your internet connection.';
      }
      
      if (message.includes('timeout')) {
        return 'Request timed out. Please try again.';
      }
      
      return message;
    }

    // Handle network errors
    if (error.name === 'NetworkError') {
      return 'Network connection failed. Please check your internet connection.';
    }

    // Handle fetch errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return 'Unable to connect to server. Please try again.';
    }

    return error.toString();
  }

  /**
   * Add error to log with size management
   */
  private addToLog(error: AppError): void {
    this.errorLog.unshift(error);
    
    // Keep log size manageable
    if (this.errorLog.length > this.MAX_LOG_SIZE) {
      this.errorLog = this.errorLog.slice(0, this.MAX_LOG_SIZE);
    }
  }

  /**
   * Show error to user (can be customized)
   */
  private showUserError(error: AppError): void {
    // For now, use alert. In production, you might use a toast library
    const userMessage = this.getUserFriendlyMessage(error);
    
    // Only show critical errors to users
    if (error.type === 'auth' || error.type === 'network') {
      alert(userMessage);
    }
  }

  /**
   * Get user-friendly error message
   */
  private getUserFriendlyMessage(error: AppError): string {
    switch (error.type) {
      case 'auth':
        return 'Authentication failed. Please sign in again.';
      case 'database':
        return 'Unable to load data. Please try refreshing the page.';
      case 'network':
        return 'Network connection issue. Please check your internet connection and try again.';
      case 'validation':
        return 'Invalid input. Please check your data and try again.';
      default:
        return 'Something went wrong. Please try again or contact support if the problem persists.';
    }
  }

  /**
   * Check if error is retryable
   */
  isRetryable(error: AppError): boolean {
    return error.type === 'network' || error.type === 'database';
  }

  /**
   * Get recent errors
   */
  getRecentErrors(limit: number = 10): AppError[] {
    return this.errorLog.slice(0, limit);
  }

  /**
   * Clear error log
   */
  clearLog(): void {
    this.errorLog = [];
  }

  /**
   * Get error statistics
   */
  getErrorStats(): {
    total: number;
    byType: Record<AppError['type'], number>;
    recent: number;
  } {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    const byType: Record<AppError['type'], number> = {
      auth: 0,
      database: 0,
      network: 0,
      validation: 0,
      unknown: 0
    };
    
    let recent = 0;
    
    this.errorLog.forEach(error => {
      byType[error.type]++;
      if (error.timestamp.getTime() > oneHourAgo) {
        recent++;
      }
    });
    
    return {
      total: this.errorLog.length,
      byType,
      recent
    };
  }
}

export const errorHandler = ErrorHandler.getInstance();

/**
 * Utility function for handling async operations with error handling
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: string,
  options: ErrorHandlerOptions = {}
): Promise<{ data: T | null; error: AppError | null }> {
  try {
    const data = await operation();
    return { data, error: null };
  } catch (error) {
    const appError = errorHandler.handleError(error, context, options);
    return { data: options.fallbackData || null, error: appError };
  }
}

/**
 * Utility function for handling database operations
 */
export async function withDatabaseErrorHandling<T>(
  operation: () => Promise<{ data: T | null; error: any }>,
  context: string,
  fallbackData?: T
): Promise<{ data: T | null; error: AppError | null }> {
  try {
    const result = await operation();
    
    if (result.error) {
      const appError = errorHandler.handleError(result.error, context, {
        retryable: true,
        fallbackData
      });
      return { data: fallbackData || null, error: appError };
    }
    
    return { data: result.data, error: null };
  } catch (error) {
    const appError = errorHandler.handleError(error, context, {
      retryable: true,
      fallbackData
    });
    return { data: fallbackData || null, error: appError };
  }
}