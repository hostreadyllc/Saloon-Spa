// Salon Ledger desktop app (Windows / Mac): opens the bundled app in its own window.
// © 2026 Hostready LLC. All rights reserved.
const { app, BrowserWindow, shell, Menu, dialog } = require("electron");
const path = require("path");

if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 500,
    title: "Salon Ledger",
    backgroundColor: "#F3F5F3",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "www", "index.html"));
  // Open outside links (help pages, Supabase, etc.) in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (/^https?:/i.test(url)) { e.preventDefault(); shell.openExternal(url); } });
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId("ae.salonledger.app"); // shows booking notifications with the app name on Windows
  createWindow();
  setupAutoUpdate();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// Windows: download new versions in the background and install them on the next restart.
// Salon data lives in the cloud, so updating never touches records.
function setupAutoUpdate() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require("electron-updater")); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", info => {
    dialog.showMessageBox(win, {
      type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
      title: "Update ready", message: `Salon Ledger ${info.version} is ready.`,
      detail: "Restart to finish updating. Your data is safe and stays in the cloud.",
    }).then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on("error", () => {});
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}
