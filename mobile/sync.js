/**
 * sync.js - Copies web files from mobile/ root to www/ before Capacitor sync
 * Run: node sync.js
 *
 * Note: The web app lives in www/ directly. This script ensures backwards
 * compatibility by also copying files from mobile/ root if they exist.
 *
 * Note: app.js was removed in favour of renderer.js; do not add it here.
 */
const fs = require('fs');
const path = require('path');

const files = ['index.html', 'style.css', 'url-detector.js'];
const wwwDir = path.join(__dirname, 'www');

if (!fs.existsSync(wwwDir)) {
    fs.mkdirSync(wwwDir, { recursive: true });
}

files.forEach(file => {
    const src = path.join(__dirname, file);
    const dest = path.join(wwwDir, file);

    // If file exists in mobile/ root, copy to www/ (overrides www/ version)
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`✓ Copied ${file} (from mobile/ root) → www/`);
    } else {
        // Otherwise, ensure www/ has the file
        if (!fs.existsSync(dest)) {
            console.warn(`⚠ Missing: ${file} (in both mobile/ and www/)`);
        } else {
            console.log(`✓ Kept ${file} (in www/)`);
        }
    }
});

console.log('\n✅ Sync complete');
