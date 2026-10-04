const { app, ipcMain } = require('electron');

let ipcRegistered = false;

let readUserConfig = () => ({});

function isSupported() {
  return app.isPackaged;
}

function launchPath() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }
  return process.execPath;
}

function launchOptions() {
  return { path: launchPath(), args: [] };
}

function readActual() {
  try {
    const settings = app.getLoginItemSettings(launchOptions());
    return !!(settings && settings.openAtLogin);
  } catch (error) {
    console.error('[Esprin Nemo] 读取开机自启状态失败:', error);
    return false;
  }
}

function readConfigured() {
  try {
    const config = readUserConfig();
    if (config && typeof config === 'object') return config.autoLaunch === true;
  } catch (error) {
    console.error('[Esprin Nemo] 读取开机自启设置失败:', error);
  }
  return false;
}

function describeError(error) {
  const message = error && error.message ? String(error.message) : '';
  return message ? `设置开机自启失败：${message}` : '设置开机自启失败';
}

function applyAutoLaunch(enabled) {
  if (!isSupported()) {
    return { supported: false, enabled: false, error: '当前为开发运行，无法设置开机自启' };
  }

  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, ...launchOptions() });
  } catch (error) {
    console.error('[Esprin Nemo] 设置开机自启失败:', error);
    return { supported: true, enabled: readActual(), error: describeError(error) };
  }

  return { supported: true, enabled: readActual(), error: '' };
}

function configureAutoLaunch({ getConfig } = {}) {
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (!isSupported()) return;

  const wanted = readConfigured();
  if (wanted === readActual()) return;
  applyAutoLaunch(wanted);
}

function registerAutoLaunchIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

ipcMain.handle('app:get-auto-launch', () => ({
    supported: isSupported(),
    enabled: readActual(),
    error: ''
  }));

ipcMain.handle('app:set-auto-launch', (event, payload) => {
    return applyAutoLaunch(!!(payload && payload.enabled));
  });
}

module.exports = {
  configureAutoLaunch,
  registerAutoLaunchIpc
};
