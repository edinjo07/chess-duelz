// frontend-token-standardization.js
// Run this in browser console on each admin page to test standardized token handling

const ADMIN_TOKEN_CONFIG = {
  TOKEN_KEY: 'adminAccessToken',
  REFRESH_TOKEN_KEY: 'adminRefreshToken',
  LOGIN_PAGE: '/admin-login.html',
  ADMIN_HOME: '/admin'
};

// Standardized auth check
function checkAdminAuth() {
  const token = localStorage.getItem(ADMIN_TOKEN_CONFIG.TOKEN_KEY);
  if (!token) {
    console.warn('No admin token found, redirecting to login...');
    window.location.href = ADMIN_TOKEN_CONFIG.LOGIN_PAGE;
    return false;
  }
  return token;
}

// Standardized API call with auth
async function adminAPI(endpoint, options = {}) {
  const token = checkAdminAuth();
  if (!token) return;

  const defaultOptions = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };

  const mergedOptions = {
    ...defaultOptions,
    ...options,
    headers: {
      ...defaultOptions.headers,
      ...options.headers
    }
  };

  try {
    const response = await fetch(endpoint, mergedOptions);
    
    // Handle 401/403 - token expired or invalid
    if (response.status === 401 || response.status === 403) {
      console.error('Authentication failed, clearing tokens...');
      localStorage.removeItem(ADMIN_TOKEN_CONFIG.TOKEN_KEY);
      localStorage.removeItem(ADMIN_TOKEN_CONFIG.REFRESH_TOKEN_KEY);
      window.location.href = ADMIN_TOKEN_CONFIG.LOGIN_PAGE;
      return null;
    }

    return response;
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}

// Standardized login handler
async function handleAdminLogin(username, password) {
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Login failed');
    }

    // Check if user is admin
    if (!data.user || data.user.isAdmin !== true) {
      throw new Error('Access denied: Admin privileges required');
    }

    // Store tokens with standardized keys
    localStorage.setItem(ADMIN_TOKEN_CONFIG.TOKEN_KEY, data.accessToken || data.token);
    if (data.refreshToken) {
      localStorage.setItem(ADMIN_TOKEN_CONFIG.REFRESH_TOKEN_KEY, data.refreshToken);
    }

    return { success: true, user: data.user };
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
}

// Standardized logout
function handleAdminLogout() {
  localStorage.removeItem(ADMIN_TOKEN_CONFIG.TOKEN_KEY);
  localStorage.removeItem(ADMIN_TOKEN_CONFIG.REFRESH_TOKEN_KEY);
  
  // Also clear old token keys (cleanup)
  localStorage.removeItem('token');
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  
  window.location.href = ADMIN_TOKEN_CONFIG.LOGIN_PAGE;
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ADMIN_TOKEN_CONFIG,
    checkAdminAuth,
    adminAPI,
    handleAdminLogin,
    handleAdminLogout
  };
}

console.log('✅ Admin token standardization loaded');
console.log('TOKEN_KEY:', ADMIN_TOKEN_CONFIG.TOKEN_KEY);
console.log('LOGIN_PAGE:', ADMIN_TOKEN_CONFIG.LOGIN_PAGE);
