// Chess Duelz - Backend API URL
// Update this to your Railway backend URL when you deploy.
// All frontend pages load this file from <head> to get window.CHESS_API.
window.CHESS_API = (function () {
  // Replace the string below with your Railway app URL, e.g.:
  // return 'https://chess-duelz-production.up.railway.app';
  var railwayUrl = 'https://chess-duelz-production.up.railway.app';

  // Fallback to same-origin when running locally
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return window.location.origin;
  }
  return railwayUrl;
}());
