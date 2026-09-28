// 桌面便利贴：把待办或笔记贴到桌面上的一组小窗口，位于所有窗口之下（与桌面同级）。
//
// 与小本本的分工：小本本是唯一的、停在屏幕右下角的随手记事窗口，内容属于它自己，
// 便利贴则是「一份数据、一张纸」——每一张都绑定某条笔记或待办（也可以是一张空白纸），
// 内容仍归主窗口渲染进程所有，便利贴只负责显示与输入。因此同一时刻只有一份权威副本，
// 两个窗口不会各存一份互相覆盖。
//
// 层级：便利贴贴在桌面层——不遮挡任何应用窗口，只在桌面露出来的地方可见。
// Electron 没有置底 API，因此经 desktop_layer.js 调 Win32 的 SetWindowPos(HWND_BOTTOM) 完成。
//
// 记录写在数据目录的 stickies.json：绑定关系、纸张颜色与窗口位置尺寸。
// 由主进程独写，渲染进程只通过 IPC 读写其中的字段。
const { BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./data_path.js');
const { keepDesktopLevel, raiseAboveDesktop, setDesktopLevel } = require('./desktop_layer.js');
const { syncDesktopMenu } = require('./desktop_menu.js');
const { buildWindowAppearance, safeResolve } = require('./window_appearance.js');

const STICKY_HTML = path.join(__dirname, '..', 'renderer', 'sticky.html');
// 记录文件：与笔记共用数据目录，随「数据存放位置」一起迁移
const STATE_FILE_NAME = 'stickies.json';
// 窗口 id 经命令行参数注入页面（渲染端见 renderer/sticky.html 的 readStickyId）
const ITEM_ID_ARG = '--esprin-nemo-sticky-id=';

// 窗口尺寸（内容尺寸）与最小尺寸
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 300;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 120;

// 新便利贴沿工作区左上角依次错开摆放，避免连续新建时叠在同一处
const SPAWN_MARGIN = 48;
const SPAWN_STEP = 26;
const SPAWN_WRAP = 10;

// 条目类型：note / todo 绑定已有条目，free 是便利贴自己的空白纸
const KIND_VALUES = ['note', 'todo', 'free'];
// 纸张颜色：与 renderer/sticky.html 的 --sticky-hue 一一对应
const COLOR_VALUES = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];
// 纸张颜色与色相角度的对应表（渲染端按同名键取色相）
const COLOR_HUES = { yellow: 48, green: 96, blue: 205, pink: 335, purple: 268, gray: 220 };

// 位置尺寸落盘的防抖器：拖动过程中不逐帧写盘
const geometryTimers = new Map();
// 主窗口渲染进程回应的超时：超时按失败处理，界面不会一直悬在等待中
const BRIDGE_TIMEOUT = 5000;

// id -> BrowserWindow
const windows = new Map();

let resolveTheme = () => 'dark';
let resolveStyle = () => 'default';
let resolveAccent = () => '';
let resolveRadius = () => 'default';
let resolveFonts = () => ({});
let resolveDataDir = () => '';
let resolveConfig = () => ({});
// 归属窗口（主窗口）：便利贴的落点与新窗口的父级参考都以它所在的显示器为准
let getOwnerWindow = () => null;
let iconPath = path.join(__dirname, '..', '..', 'assets', 'Main.new.png');
// 最后一张便利贴关闭后的回调（由 main.js 注入）：屏幕上是否还有窗口，只有 main.js 清楚
let handleWindowClosed = () => {};
let ipcRegistered = false;
// 应用正在退出：此后不再拦下便利贴窗口的关闭（见 createWindowForItem 的 close 拦截）
let quitting = false;

// 记录的内存镜像：只在数据目录变化时重新读盘
let loadedDir = '';
let items = [];

// 由 main.js 注入主题、主题风格、主题色、圆角尺度、字体、数据目录、配置读取、图标与关闭回调
function configureStickyNotes({ getTheme, getStyle, getAccent, getRadius, getFonts, getDataDir, getConfig, getOwner, icon, onClosed } = {}) {
  if (typeof getTheme === 'function') resolveTheme = getTheme;
  if (typeof getStyle === 'function') resolveStyle = getStyle;
  if (typeof getAccent === 'function') resolveAccent = getAccent;
  if (typeof getRadius === 'function') resolveRadius = getRadius;
  if (typeof getFonts === 'function') resolveFonts = getFonts;
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
  if (typeof getConfig === 'function') resolveConfig = getConfig;
  if (typeof getOwner === 'function') getOwnerWindow = getOwner;
  if (typeof icon === 'string' && icon) iconPath = icon;
  if (typeof onClosed === 'function') handleWindowClosed = onClosed;
}

// 当前外观：取值交给注入的读取函数，换算与参数拼装交给 window_appearance.js，
// 与小本本、弹窗用的是同一套逻辑
function currentAppearance() {
  return buildWindowAppearance({
    theme: safeResolve(resolveTheme, 'dark', '主题'),
    style: safeResolve(resolveStyle, 'default', '主题风格'),
    accent: safeResolve(resolveAccent, '', '主题色'),
    radius: safeResolve(resolveRadius, 'default', '圆角尺度'),
    fonts: safeResolve(resolveFonts, {}, '字体')
  });
}

// 便利贴设置（config.json 的 stickyNotes）：总开关与新建时的默认颜色
function readStickyConfig() {
  const config = safeResolve(resolveConfig, {}, '便利贴设置');
  const source = config && typeof config === 'object' && config.stickyNotes && typeof config.stickyNotes === 'object'
    ? config.stickyNotes
    : {};

  return {
    enabled: source.enabled !== false,
    color: COLOR_VALUES.includes(source.color) ? source.color : 'yellow'
  };
}

function stateFilePath() {
  return path.join(resolveDataDir(), STATE_FILE_NAME);
}

function randomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 10; index++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

// 单条记录的规范化：字段类型、取值范围与缺省值都在这里落定，
// 手写或旧版本的记录因此不会让窗口跑到屏幕外、或让渲染端拿到非法颜色
function normalizeItem(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = typeof source.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source.id.trim()) ? source.id.trim() : '';
  if (!id) return null;

  const kind = KIND_VALUES.includes(source.kind) ? source.kind : 'free';
  return {
    id,
    kind,
    // 绑定的条目 id：kind 为 free 时为空
    refId: ['note', 'todo'].includes(kind) && typeof source.refId === 'string' ? source.refId.trim() : '',
    title: typeof source.title === 'string' ? source.title : '',
    content: typeof source.content === 'string' ? source.content : '',
    isDone: source.isDone === true,
    color: COLOR_VALUES.includes(source.color) ? source.color : 'yellow',
    // 只读：绑定的条目进了废纸篓或已加密时由界面锁定编辑
    readonly: source.readonly === true,
    // 收起：仅由设置 / 托盘里的「全部收起」写入（单张便利贴没有收起动作，关闭即移除）
    hidden: source.hidden === true,
    x: Number.isFinite(Number(source.x)) ? Math.round(Number(source.x)) : null,
    y: Number.isFinite(Number(source.y)) ? Math.round(Number(source.y)) : null,
    width: clampNumber(source.width, MIN_WIDTH, 4000, DEFAULT_WIDTH),
    height: clampNumber(source.height, MIN_HEIGHT, 4000, DEFAULT_HEIGHT),
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now()
  };
}

function readItemsFromDisk(dir) {
  try {
    const file = path.join(dir, STATE_FILE_NAME);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = parsed && Array.isArray(parsed.items) ? parsed.items : [];
    const seen = new Set();
    const result = [];
    list.forEach((entry) => {
      const item = normalizeItem(entry);
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      result.push(item);
    });
    return result;
  } catch (error) {
    console.error('[Esprin Nemo] 读取桌面便利贴记录失败:', error);
    return [];
  }
}

// 记录只在主进程内读写，因此首次访问读盘一次，之后一直用内存镜像；
// 数据目录切换时按新目录重新读盘
function ensureLoaded() {
  const dir = resolveDataDir();
  if (loadedDir === dir) return;
  loadedDir = dir;
  items = readItemsFromDisk(dir);
}

function writeState() {
  try {
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    writeFileAtomic(stateFilePath(), JSON.stringify({ items }, null, 2));
    // 便利贴的增删与标题变化要反映到桌面右键菜单上（函数内部有防抖与清单比对）
    syncDesktopMenu();
    return true;
  } catch (error) {
    console.error('[Esprin Nemo] 保存桌面便利贴记录失败:', error);
    return false;
  }
}

function findItem(id) {
  ensureLoaded();
  return items.find((entry) => entry.id === id) || null;
}

// 主进程侧增删便利贴后（托盘新建、桌面右键菜单新建 / 关闭），把变化告诉主窗口：
// 设置里的张数与标题栏入口据此刷新。主窗口自己发起的增删本就会重拉一次清单。
function notifyMainWindowListChanged() {
  const win = getOwnerWindow();
  if (!win || win.isDestroyed()) return;
  if (!win.webContents || win.webContents.isDestroyed()) return;
  win.webContents.send('sticky:list-changed');
}

// 合并写入一条记录：只接受调用方明确给出的字段，其余原样保留
function patchItem(id, patch) {
  const item = findItem(id);
  if (!item || !patch || typeof patch !== 'object') return null;

  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (value === undefined) return;
    item[key] = value;
  });
  item.updatedAt = Date.now();
  writeState();
  return item;
}

/* ---------------- 与主窗口渲染进程之间的请求 / 响应 ----------------
   绑定条目的读取与写回全部在主窗口完成（数据与 State 都在那边），
   便利贴只负责转发，保证同一时刻只有一份权威的条目内容。 */
const bridgePending = new Map();
let bridgeSeq = 0;

function askMainWindow(channel, payload) {
  const owner = ownerWindow();
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, reason: 'no-window' });
  }

  const contents = owner.webContents;

  return new Promise((resolve) => {
    const deliver = () => {
      if (contents.isDestroyed()) {
        resolve({ ok: false, reason: 'no-window' });
        return;
      }

      const id = ++bridgeSeq;
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        resolve({ ok: false, reason: 'timeout' });
      }, BRIDGE_TIMEOUT);

      bridgePending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        timer
      });
      contents.send(channel, { ...(payload || {}), id });
    };

    /* 主窗口页面尚未就绪时（启动阶段便利贴先于主窗口首屏载入完成）消息会被丢掉，
       因此先等页面加载完成再发，与托盘菜单的动作投递同一做法 */
    if (contents.isLoadingMainFrame() || !contents.getURL()) contents.once('did-finish-load', deliver);
    else deliver();
  });
}

function resolveBridgeReply(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const entry = bridgePending.get(data.id);
  if (!entry) return;

  bridgePending.delete(data.id);
  clearTimeout(entry.timer);

  if (data.ok === false) {
    entry.resolve({ ok: false, reason: typeof data.reason === 'string' ? data.reason : 'failed' });
    return;
  }
  entry.resolve({ ok: true, ...data });
}

// 主窗口被收起时渲染进程仍然存活，因此这里不排除隐藏窗口
function ownerWindow() {
  const owner = getOwnerWindow();
  return owner && !owner.isDestroyed() ? owner : null;
}

/* ---------------- 窗口 ---------------- */

function workArea() {
  const owner = ownerWindow();
  if (owner) {
    try {
      return screen.getDisplayMatching(owner.getBounds()).workArea;
    } catch (error) {
      // 忽略：退回主显示器
    }
  }
  return screen.getPrimaryDisplay().workArea;
}

// 新便利贴的落点：沿工作区左上角依次错开，越界时收回工作区内
function spawnBounds() {
  const area = workArea();
  const step = (items.length % SPAWN_WRAP) * SPAWN_STEP;
  const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, area.width - SPAWN_MARGIN * 2));
  const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, area.height - SPAWN_MARGIN * 2));

  return {
    width,
    height,
    x: Math.round(Math.min(area.x + SPAWN_MARGIN + step, area.x + Math.max(0, area.width - width - 8))),
    y: Math.round(Math.min(area.y + SPAWN_MARGIN + step, area.y + Math.max(0, area.height - height - 8)))
  };
}

// 已有记录的落点：记录里的位置优先，缺失或落在所有显示器之外时回到默认落点
function boundsForItem(item) {
  const fallback = spawnBounds();
  const width = clampNumber(item.width, MIN_WIDTH, 4000, fallback.width);
  const height = clampNumber(item.height, MIN_HEIGHT, 4000, fallback.height);
  if (item.x === null || item.y === null) return { ...fallback, width, height };

  const rect = { x: item.x, y: item.y, width, height };
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return rect.x < area.x + area.width && rect.x + rect.width > area.x
      && rect.y < area.y + area.height && rect.y + rect.height > area.y;
  });
  return visible ? rect : { ...fallback, width, height };
}

// 便利贴的窗口属性：不属于置顶窗口（它贴在桌面层，见 desktop_layer.js），
// 并且不进任务栏——任务栏里一堆同名条目既看不出哪张是哪张，也挤掉了别的窗口
function applyStickyWindowTraits(win) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(true);
}

// 位置尺寸立即写盘（用于关窗、退出或拖动结束时落盘当前位置）
function saveGeometryNow(id, win) {
  if (geometryTimers.has(id)) {
    clearTimeout(geometryTimers.get(id));
    geometryTimers.delete(id);
  }
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  patchItem(id, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}

// 退出前将所有可见便利贴的位置尺寸立即落盘
function flushAllGeometries() {
  windows.forEach((win, id) => {
    saveGeometryNow(id, win);
  });
}

// 位置尺寸落盘：拖动与缩放期间只有最后一次改动会写盘
function scheduleGeometryWrite(id, win) {
  if (geometryTimers.has(id)) clearTimeout(geometryTimers.get(id));
  geometryTimers.set(id, setTimeout(() => {
    geometryTimers.delete(id);
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    patchItem(id, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }, 250));
}

// 给渲染端的一份快照：不带上与界面无关的字段
function itemSnapshot(item) {
  return {
    id: item.id,
    kind: item.kind,
    refId: item.refId,
    title: item.title,
    content: item.content,
    isDone: item.isDone,
    color: item.color,
    hue: COLOR_HUES[item.color] || COLOR_HUES.yellow,
    readonly: item.readonly === true
  };
}

// 创建便利贴窗口：已存在时只把它显示出来，不另开一扇
function createWindowForItem(item) {
  if (windows.has(item.id)) {
    showStickyNote(item.id);
    return windows.get(item.id);
  }

  const appearance = currentAppearance();
  const win = new BrowserWindow({
    ...boundsForItem(item),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: '桌面便利贴',
    // 桌面层：不置顶，并由 keepDesktopLevel 在显示 / 恢复 / 获得焦点 / 点击后压回所有窗口之下
    alwaysOnTop: false,
    backgroundColor: appearance.backgroundColor,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      additionalArguments: [...appearance.args, `${ITEM_ID_ARG}${item.id}`]
    }
  });

  windows.set(item.id, win);
  applyStickyWindowTraits(win);
  keepDesktopLevel(win);
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    /* 始终置底、不抢焦点：便利贴是桌面上的纸，不是要人马上看的窗口，
       因此一律 showInactive，并立即把它压到所有窗口之下 */
    win.showInactive();
    setDesktopLevel(win);
  });

  /* 系统路径的关闭（Alt+F4 等）与右键菜单里的「关闭并移除」同义：从桌面移除这张纸。
     界面那一步要先落盘、并对无关联的纸问一次，因此这里拦下并交给渲染进程走同一个流程。
     记录已被移除（正在走该流程）或应用正在退出时直接放行。 */
  win.on('close', (event) => {
    if (quitting || !findItem(item.id)) return;
    event.preventDefault();
    if (!win.webContents.isDestroyed()) win.webContents.send('sticky:request-close');
  });

  win.on('moved', () => scheduleGeometryWrite(item.id, win));
  win.on('resized', () => scheduleGeometryWrite(item.id, win));

  win.once('closed', () => {
    windows.delete(item.id);
    if (geometryTimers.has(item.id)) {
      clearTimeout(geometryTimers.get(item.id));
      geometryTimers.delete(item.id);
    }
    // 关掉窗口不等于删掉这张纸：记录留着并标记为收起，可在设置里重新显示
    if (findItem(item.id)) patchItem(item.id, { hidden: true });
    handleWindowClosed();
  });

  win.loadFile(STICKY_HTML).catch((error) => {
    console.error('[Esprin Nemo] 加载桌面便利贴页面失败:', error);
    if (!win.isDestroyed()) win.destroy();
  });

  return win;
}

// 把一张便利贴显示出来（收起状态下用它贴回来）：只显示、不抢焦点，随后压回底层
function showStickyNote(id) {
  const win = windows.get(id);
  if (!win || win.isDestroyed()) return false;
  patchItem(id, { hidden: false });
  if (win.isMinimized()) win.restore();
  win.showInactive();
  setDesktopLevel(win);
  return true;
}

// 关闭并移除：记录与窗口一并去掉（单张便利贴没有「收起」，关闭就是让它从桌面消失）
function closeStickyNote(id) {
  ensureLoaded();
  items = items.filter((entry) => entry.id !== id);
  writeState();

  const win = windows.get(id);
  // 记录先移除，close 拦截因此不会再把这次关闭推回界面
  if (win && !win.isDestroyed()) win.destroy();
  else handleWindowClosed();
  notifyMainWindowListChanged();
  return { ok: true };
}

// 便利贴是否还贴在屏幕上（只看可见窗口：收起后记录还在，但屏幕上已经没有它了）。
// 主窗口关闭与最后一张纸关闭时据此决定是收起主窗口还是退出应用
function isStickyNoteOpen() {
  for (const win of windows.values()) {
    if (!win.isDestroyed() && win.isVisible()) return true;
  }
  return false;
}

// 供桌面右键菜单使用：每张便利贴的 id 与标题
function listStickyNotes() {
  ensureLoaded();
  return items.map((item) => ({ id: item.id, title: String(item.title || '') }));
}

// 显示一张便利贴，窗口不在时补开一扇（供桌面右键菜单使用）
function revealStickyNote(id) {
  const item = findItem(id);
  if (!item) return false;

  const win = windows.get(id);
  if (!win || win.isDestroyed()) {
    createWindowForItem({ ...item, hidden: false });
    return true;
  }
  return showStickyNote(id);
}

function showAllStickyNotes() {
  // 总开关关闭时什么都不做：托盘与设置里的「全部显示」都不该把它贴回来
  if (!readStickyConfig().enabled) return 0;

  ensureLoaded();
  let shown = 0;
  items.forEach((item) => {
    const win = windows.get(item.id);
    if (win && !win.isDestroyed()) {
      showStickyNote(item.id);
      shown++;
      return;
    }
    createWindowForItem({ ...item, hidden: false });
    shown++;
  });
  return shown;
}

function hideAllStickyNotes() {
  let hidden = 0;
  windows.forEach((win, id) => {
    patchItem(id, { hidden: true });
    if (!win.isDestroyed()) win.hide();
    hidden++;
  });
  // 全部收起后同样重新判定一次去留（见 hideStickyNote）
  handleWindowClosed();
  return hidden;
}

// 新建一张便利贴：payload.kind 为 note / todo 时绑定对应条目，否则是一张空白纸
function createStickyNote(payload = {}) {
  const config = readStickyConfig();
  if (!config.enabled) return { ok: false, reason: 'disabled' };

  ensureLoaded();
  const kind = KIND_VALUES.includes(payload.kind) ? payload.kind : 'free';
  const refId = kind === 'free' ? '' : String(payload.refId || '').trim();

  // 同一个条目只贴一张：再次「贴到桌面」就是把它显示出来
  if (refId) {
    const existing = items.find((entry) => entry.refId === refId);
    if (existing) {
      showStickyNote(existing.id);
      return { ok: true, id: existing.id, shown: true };
    }
  }

  const item = {
    id: randomId(),
    kind,
    refId,
    title: typeof payload.title === 'string' ? payload.title : '',
    content: typeof payload.content === 'string' ? payload.content : '',
    isDone: payload.isDone === true,
    color: COLOR_VALUES.includes(payload.color) ? payload.color : config.color,
    readonly: false,
    hidden: false,
    x: null,
    y: null,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  items.push(item);
  writeState();
  createWindowForItem(item);
  notifyMainWindowListChanged();
  return { ok: true, id: item.id };
}

// 启动时把记录里未收起的便利贴重新贴出来（总开关关闭时不做任何事）
function restoreStickyNotes() {
  const config = readStickyConfig();
  if (!config.enabled) return 0;

  ensureLoaded();
  const visible = items.filter((entry) => !entry.hidden);
  visible.forEach((item) => createWindowForItem(item));
  if (visible.length) {
    console.log(`[INFO] [StickyNotes] Restored ${visible.length} desktop note(s)`);
  }
  return visible.length;
}

/* ---------------- 外观与条目变更的广播 ---------------- */

// 主窗口内变更主题 / 主题风格 / 主题色 / 圆角尺度 / 字体后同步给便利贴，
// 渲染端收到后用与小本本首屏完全相同的那套逻辑重新应用
function updateStickyNoteAppearance(payload) {
  const appearance = buildWindowAppearance(payload);
  windows.forEach((win) => {
    if (win.isDestroyed()) return;
    try {
      win.setBackgroundColor(appearance.backgroundColor);
    } catch (error) {
      // 忽略：窗口可能刚好在这一刻被关掉
    }
    if (win.webContents.isDestroyed()) return;
    win.webContents.send('sticky:appearance', {
      theme: appearance.theme,
      style: appearance.style,
      radius: appearance.radius,
      accent: appearance.accent,
      fonts: appearance.fonts
    });
  });
}

// 条目在主窗口被改动后刷新贴在它上面的便利贴；已删除的条目只通知失效，不改内容
function broadcastItemChanged(itemId, detail) {
  ensureLoaded();
  items
    .filter((entry) => entry.refId && entry.refId === itemId)
    .forEach((entry) => {
      const win = windows.get(entry.id);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send('sticky:item', detail);
    });
}

/* ---------------- 便利贴窗口发来的请求 ---------------- */

function idFromSender(event) {
  const sender = event && event.sender;
  if (!sender) return '';
  for (const [id, win] of windows) {
    if (!win.isDestroyed() && win.webContents === sender) return id;
  }
  return '';
}

// 取一条绑定的条目：内容以主窗口为准，失败时带回原因（missing / locked / readonly / no-window）
async function fetchBoundItem(item) {
  if (!item.refId) return { ok: false, reason: 'unbound' };
  const reply = await askMainWindow('sticky:get-item', { itemId: item.refId });
  if (!reply.ok || !reply.item) return { ok: false, reason: reply.reason || 'missing' };
  return { ok: true, item: reply.item };
}

// 载入一张便利贴：绑定时取条目最新内容，未绑定或条目已不可用时退回记录里的缓存
async function loadStickyNote(id) {
  const item = findItem(id);
  if (!item) return { ok: false, reason: 'missing' };

  if (!item.refId) return { ok: true, sticky: itemSnapshot(item), bound: false };

  const fetched = await fetchBoundItem(item);
  if (!fetched.ok) {
    /* 主窗口尚未就绪（no-window）或响应超时：保留绑定，先显示记录里的缓存内容，
       下一轮启动 / 下一次保存会重新取一次 */
    if (fetched.reason === 'no-window' || fetched.reason === 'timeout') {
      return { ok: true, sticky: itemSnapshot(item), bound: true, reason: fetched.reason };
    }

    /* 条目确实不在了（被彻底删除、换了数据目录）：解除绑定，
       内容按记录里的缓存保留，免得丢掉便利贴上写的东西 */
    patchItem(id, { refId: '', kind: 'free', readonly: false });
    return { ok: true, sticky: itemSnapshot(findItem(id)), bound: false, reason: fetched.reason };
  }

  const bound = fetched.item;
  const readonly = bound.readonly === true;
  patchItem(id, {
    title: bound.title || '',
    content: bound.content || '',
    isDone: bound.isDone === true,
    readonly
  });
  return { ok: true, sticky: itemSnapshot(findItem(id)), bound: true };
}

// 保存一张便利贴：先落记录，绑定时再写回条目
async function saveStickyNote(id, payload) {
  const item = findItem(id);
  if (!item) return { ok: false, reason: 'missing' };

  const title = typeof payload.title === 'string' ? payload.title : item.title;
  const content = typeof payload.content === 'string' ? payload.content : item.content;
  const isDone = payload.isDone === undefined ? item.isDone : payload.isDone === true;

  patchItem(id, { title, content, isDone });
  if (!item.refId) return { ok: true, readonly: false };

  const reply = await askMainWindow('sticky:save-item', { itemId: item.refId, title, content, isDone });
  if (reply.ok) {
    const readonly = reply.readonly === true;
    patchItem(id, { readonly });
    return { ok: true, readonly };
  }

  // 条目没了：解除绑定并保留内容，下一次保存就不再回写
  if (reply.reason === 'missing') {
    patchItem(id, { refId: '', kind: 'free', readonly: false });
    return { ok: true, reason: 'missing', readonly: false };
  }
  return { ok: false, reason: reply.reason || 'failed' };
}

// 切换绑定待办的完成状态：条目在主窗口那边写，便利贴只拿回结果
async function toggleStickyDone(id, done) {
  const item = findItem(id);
  if (!item) return { ok: false, reason: 'missing' };

  const next = done === undefined ? !item.isDone : done === true;
  patchItem(id, { isDone: next });
  if (!item.refId) return { ok: true, isDone: next };

  const reply = await askMainWindow('sticky:toggle-done', { itemId: item.refId, isDone: next });
  if (!reply.ok) return { ok: false, reason: reply.reason || 'failed', isDone: item.isDone };

  patchItem(id, { isDone: reply.isDone === true });
  return { ok: true, isDone: reply.isDone === true };
}

function registerStickyNotesIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  /* 主窗口侧：条目右键菜单的「贴到桌面」、标题栏入口与设置分区都走这几个通道 */
  ipcMain.handle('sticky:create', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return createStickyNote(data);
  });

  ipcMain.handle('sticky:list', () => {
    ensureLoaded();
    return {
      enabled: readStickyConfig().enabled,
      items: items.map((item) => ({ ...itemSnapshot(item), windowOpen: windows.has(item.id) }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    };
  });

  ipcMain.handle('sticky:show-all', () => ({ ok: true, count: showAllStickyNotes() }));
  ipcMain.handle('sticky:hide-all', () => ({ ok: true, count: hideAllStickyNotes() }));

  ipcMain.handle('sticky:clear-all', () => {
    ensureLoaded();
    const ids = items.map((item) => item.id);
    ids.forEach((id) => closeStickyNote(id));
    return { ok: true, count: ids.length };
  });

  // 总开关：关闭时把所有便利贴收起（记录保留），重新开启时贴回来
  ipcMain.handle('sticky:set-enabled', (event, payload) => {
    const enabled = !(payload && payload.enabled === false);
    if (enabled) return { ok: true, enabled: true, count: showAllStickyNotes() };
    return { ok: true, enabled: false, count: hideAllStickyNotes() };
  });

  /* 便利贴窗口侧：窗口自己发起的请求，目标记录由发送方窗口反查 */
  ipcMain.handle('sticky:resolve', (event) => {
    const id = idFromSender(event);
    return id ? loadStickyNote(id) : { ok: false, reason: 'missing' };
  });

  ipcMain.handle('sticky:save', (event, payload) => {
    const id = idFromSender(event);
    if (!id) return { ok: false, reason: 'missing' };
    return saveStickyNote(id, payload && typeof payload === 'object' ? payload : {});
  });

  ipcMain.handle('sticky:toggle-done', (event, payload) => {
    const id = idFromSender(event);
    const data = payload && typeof payload === 'object' ? payload : {};
    if (!id) return { ok: false, reason: 'missing' };
    return toggleStickyDone(id, data.isDone);
  });

  ipcMain.handle('sticky:set-color', (event, payload) => {
    const id = idFromSender(event);
    const data = payload && typeof payload === 'object' ? payload : {};
    if (!id) return { ok: false, reason: 'missing' };
    if (!COLOR_VALUES.includes(data.color)) return { ok: false, reason: 'invalid' };
    patchItem(id, { color: data.color });
    return { ok: true, color: data.color, hue: COLOR_HUES[data.color] };
  });

  ipcMain.handle('sticky:close', (event) => {
    const id = idFromSender(event);
    return id ? closeStickyNote(id) : { ok: false, reason: 'missing' };
  });

  // 主窗口渲染进程回传的应答
  ipcMain.on('sticky:reply', (event, payload) => resolveBridgeReply(payload));

  // 鼠标按住便利贴时临时提到最前
  ipcMain.on('sticky:raise', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) raiseAboveDesktop(win);
  });

  // 鼠标松开便利贴时压回桌面底层
  ipcMain.on('sticky:keep-bottom', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) setDesktopLevel(win);
  });

  // 主窗口渲染进程广播的外观与条目变更
  ipcMain.on('sticky:appearance', (event, payload) => updateStickyNoteAppearance(payload));
  ipcMain.on('sticky:item-changed', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const itemId = typeof data.itemId === 'string' ? data.itemId : '';
    if (!itemId) return;

    // 只带实际给出的字段：没有正文（例如只说「已删除」）时不覆盖便利贴上的内容
    const detail = { itemId, exists: data.exists !== false, readonly: data.readonly === true };
    if (data.exists !== false) {
      detail.title = typeof data.title === 'string' ? data.title : '';
      detail.content = typeof data.content === 'string' ? data.content : '';
      detail.isDone = data.isDone === true;
    }
    broadcastItemChanged(itemId, detail);
  });

  // 关窗兜底：渲染进程即将消失，异步保存只能由主进程接着完成
  ipcMain.on('sticky:flush', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) return;
    saveStickyNote(id, data).catch((error) => {
      console.error('[Esprin Nemo] 便利贴关窗保存失败:', error);
    });
  });
}

// 应用开始退出：由 main.js 在 before-quit 时调用，此后便利贴窗口不再拦下关闭
function releaseStickyNotes() {
  quitting = true;
  flushAllGeometries();
}

module.exports = {
  configureStickyNotes,
  registerStickyNotesIpc,
  closeStickyNote,
  createStickyNote,
  flushAllGeometries,
  hideAllStickyNotes,
  isStickyNoteOpen,
  listStickyNotes,
  releaseStickyNotes,
  restoreStickyNotes,
  revealStickyNote,
  showAllStickyNotes,
  showStickyNote
};
