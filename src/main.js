import { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import dotenv from 'dotenv';

const loadEnv = () => {
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(process.execPath), '.env'),
    path.join(process.resourcesPath || '', '.env'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
  }

  dotenv.config();
};

loadEnv();

if (started) {
  app.quit();
}

// Disable GPU disk cache writing to prevent Windows file-lock errors on restart
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let mainWindow;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 380,
    minHeight: 500,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Default: Screen capture protection ON (invisible to screen shares/recorders)
  mainWindow.setContentProtection(true);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

// --- Screen Capture IPC Handler ---
ipcMain.handle('capture-screen', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;

    // High quality capture for reading code/problem text
    const maxDimension = 1440;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: targetWidth,
        height: targetHeight,
      },
    });

    if (sources.length > 0) {
      const image = sources[0].thumbnail.toJPEG(80);
      return `data:image/jpeg;base64,${image.toString('base64')}`;
    }
    return null;
  } catch (error) {
    console.error('Error capturing screen:', error);
    return null;
  }
});

// IPC Handlers
ipcMain.handle('get-env', () => {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_VISION_MODEL: process.env.GEMINI_VISION_MODEL || 'gemini-3.1-flash-lite',
    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
    GROQ_MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || '',
  };
});

ipcMain.on('toggle-protection', (_, enable) => {
  if (mainWindow) mainWindow.setContentProtection(enable);
});

ipcMain.on('set-opacity', (_, value) => {
  if (mainWindow) mainWindow.setOpacity(parseFloat(value));
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

app.whenReady().then(() => {
  // CRITICAL: Handle getDisplayMedia permission for System Loopback Audio (Speaker/Friend)
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      callback({});
    });
  });

  if (process.platform === 'darwin') {
    app.dock.hide();
  }
  createWindow();

  // Register emergency hide/show toggle hotkey (Ctrl+Shift+X)
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.showInactive();
      }
    }
  });

  // Global screen-snap hotkey (Ctrl+Shift+S)
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (mainWindow) {
      mainWindow.webContents.send('trigger-screen-capture');
    }
  });

  // Global new chat hotkey (Ctrl+Shift+N)
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (mainWindow) {
      mainWindow.webContents.send('trigger-new-chat');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
