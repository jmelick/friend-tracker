import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// ============================================================
// FILL IN YOUR FIREBASE CONFIG BELOW
// Get these values from: Firebase Console → Project Settings → General → Your apps → Web app
// ============================================================

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAqSdMpTFXJpLZKAeffFuBnV6tTKPYHsk0",
  authDomain: "friend-tracker-7f190.firebaseapp.com",
  projectId: "friend-tracker-7f190",
  storageBucket: "friend-tracker-7f190.firebasestorage.app",
  messagingSenderId: "420239685519",
  appId: "1:420239685519:web:6e2bd7bbb8e598942cfdfa"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
