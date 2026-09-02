// Firebase project config — shared across every team (unlike config/teams.js,
// which is per-team). Not secret: Firebase's own docs are explicit that this
// object is meant to ship in public frontend code — access control lives in
// Firestore Security Rules and the signed custom-token auth flow, not in
// keeping this object hidden.
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDg3gFFb3N3xLEaZ_-PJwrUdCgusFBFsTw',
  authDomain: 'ftc-dashboard-379f3.firebaseapp.com',
  projectId: 'ftc-dashboard-379f3',
  storageBucket: 'ftc-dashboard-379f3.firebasestorage.app',
  messagingSenderId: '83490914073',
  appId: '1:83490914073:web:50cdf3b70005aab2d54f88',
};
