// Firebase web app config for the "rcmi-website" project.
// These values are public by design; firestore.rules protects the data.
export const firebaseConfig = {
  apiKey: "AIzaSyCGjAefXgnG_O48Bp2gBRkbMHv0xQVjNuQ",
  authDomain: "rcmi-website.firebaseapp.com",
  projectId: "rcmi-website",
  storageBucket: "rcmi-website.firebasestorage.app",
  messagingSenderId: "109325988808",
  appId: "1:109325988808:web:d13a38fa24d5ba216246fd",
  measurementId: "G-GF1L1N0MP1"
};

// Google Drive photo uploads (scripts/drive-upload.gs deployed as a web app). Empty = photos stay inside the posts.
export const uploadUrl = "https://script.google.com/macros/s/AKfycbykQFyeWs9J_xHx1jdNGJyBUmW-PgKeJ-7u-iBiHQICTlBHvLneHjViHOJa8NvWer66Og/exec";
