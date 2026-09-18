const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const log = require('electron-log');

// Define expected files to check relative to the app execution directory
// If sizes or hashes are known, we would verify them. 
// For now, we will verify existence and check if size > 0 to prevent empty corrupted files.
const CRITICAL_FILES = [
  'yt-dlp.exe',
  'ffmpeg.exe',
  'aria2c.exe',
  path.join('backend', 'dist', 'main.exe')
];

function checkIntegrity() {
  const resourcePath = app.isPackaged ? process.resourcesPath : path.join(__dirname);
  
  let missingFiles = [];
  let corruptedFiles = [];

  for (const file of CRITICAL_FILES) {
    const fullPath = path.join(resourcePath, file);
    log.info(`Checking integrity for: ${fullPath}`);
    if (!fs.existsSync(fullPath)) {
      // In development mode, backend/dist/main.exe might not exist since we use main.py
      if (!app.isPackaged && file.includes('main.exe')) {
          continue;
      }
      missingFiles.push(file);
    } else {
      const stats = fs.statSync(fullPath);
      if (stats.size === 0) {
        corruptedFiles.push(file);
      }
    }
  }

  if (missingFiles.length > 0 || corruptedFiles.length > 0) {
    let message = 'The application integrity check failed.\n\n';
    if (missingFiles.length > 0) {
      message += `Missing files: \n${missingFiles.join('\n')}\n\n`;
    }
    if (corruptedFiles.length > 0) {
      message += `Corrupted files (0 bytes): \n${corruptedFiles.join('\n')}\n\n`;
    }
    message += 'Please reinstall the application to restore these files. Some features like downloading may not work properly.';
    
    log.error(message);
    dialog.showErrorBox('Integrity Check Failed', message);
    return false;
  }
  
  log.info('Integrity check passed. All critical binaries are present.');
  return true;
}

module.exports = {
  checkIntegrity
};
