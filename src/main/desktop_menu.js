/* 桌面右键菜单：桌面空白处右键 → 「EsprinNemo 便利贴」，可直接新建便利贴、
   把某一张提到最前，或批量显示与收起。
 *
 * Electron 没有桌面右键菜单的 API，只能写注册表，一共两棵键：
 *   HKCU\Software\Classes\DesktopBackground\Shell\EsprinNemoStickies   菜单本身
 *   HKCU\Software\Classes\EsprinNemoStickyMenu\shell\<动词>             子菜单各项
 * 前者用 ExtendedSubCommandsKey 指向后者——不用「SubCommands 留空 + 自己的 shell 子键」
 * 那套：菜单键的 shell 子键与标准动词共用同一命名空间，混在一起容易踩到保留动词名。
 * 动词名一律带序号前缀（01-new / 20-001-xxx / 90-show-all）：既避开 new、open、print
 * 这类会被当作标准动词处理的名字（同名时整棵子菜单可能都展不开），又让菜单顺序稳定。
 *
 * 菜单内容随便利贴的增删与标题变化重建：整棵子树的重建走一次 `reg import`，
 * 先在 .reg 里用 `[-键]` 行删掉旧树、再按当前列表写回，一次进程调用搞定，
 * 不必逐项 reg add（几条便利贴就是十几次进程调用）。应用退出时删除整棵子树：
 * 菜单项指向的是本机应用，应用不在时留着它没有意义。
 *
 * 已知限制：Windows 11 的新式右键菜单默认折叠，这一项要经「显示更多选项」才看得到。
 * 这是系统行为（传统 Win32 菜单项一律进二级菜单），注册表项本身照常出现。
 */
const { app, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 菜单挂在桌面背景的右键菜单下（资源管理器里的文件夹空白处用的是 Directory\Background）
const MENU_KEY = 'Software\\Classes\\DesktopBackground\\Shell\\EsprinNemoStickies';
const MENU_KEY_FULL = `HKEY_CURRENT_USER\\${MENU_KEY}`;
// 子项所在的键：由 ExtendedSubCommandsKey 按「相对 HKEY_CLASSES_ROOT 的路径」指过来
const ITEMS_KEY = 'Software\\Classes\\EsprinNemoStickyMenu';
const ITEMS_KEY_FULL = `HKEY_CURRENT_USER\\${ITEMS_KEY}`;
const ITEMS_KEY_NAME = 'EsprinNemoStickyMenu';
const MENU_LABEL = 'EsprinNemo 便利贴';

// 动作参数：由菜单项的 command 行传给第二次启动的进程（见 handleDesktopMenuArgv）
const ACTION_PREFIX = '--sticky-action=';
const ID_PREFIX = '--sticky-id=';

const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
const TEMP_FILE_NAME = 'esprin_nemo_sticky_menu.reg';
// 运行时生成的菜单图标：shell 的 Icon 值只认 .ico / exe / dll，不认 PNG
const MENU_ICON_NAME = 'sticky_menu.ico';
const ICON_SIZE = 256;
// 菜单里按 16px 显示，带一张小图才不会从 256px 糊着缩下来
const ICON_SMALL_SIZE = 32;
// 菜单项标题的长度上限：再长会被系统截断
const LABEL_MAX = 40;
// 菜单重建的防抖：标题是随输入变的，等停手后再写注册表
const SYNC_DELAY = 600;
// 没有标题时的菜单文字
const UNTITLED = '未命名便利贴';

let enabled = false;
let timer = null;
// 上一次写进注册表的「id + 标题」清单：没变就不重复写盘
let lastSignature = null;
// 应用自己的图标源（PNG），由 main.js 注入
let appIconPath = '';
// 生成好的 .ico 路径：本次运行内缓存，null 表示还没算过
let menuIcon = null;

// 由 main.js 注入：读取当前便利贴清单、执行菜单动作
let getItems = () => [];
let onAction = () => {};

function isSupported() {
  return process.platform === 'win32' && fs.existsSync(REG_EXE);
}

/* 菜单项点击后要启动的那个可执行文件。
   便携版每次启动都会解压到临时目录，登记 process.execPath 会在重启后失效，
   因此优先登记用户实际双击的那个文件（与 auto_launch.js 同一套判定）；
   开发运行（bun start）是 electron.exe，要带上项目目录才能启动应用。 */
function launchTarget() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  }
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [app.getAppPath()] };
}

/* ---------------- 菜单图标 ----------------
   shell 解析 Icon 值时只认 .ico / exe / dll，不认 PNG（窗口图标走 nativeImage 那一套，
   与这里无关）。应用图标只有 PNG 与 SVG 两个源，因此按「ICO 内嵌 PNG」的写法现拼一个
   .ico（Vista 起的 shell 支持这种格式）：每个条目就是一段 PNG，尺寸写在目录项里。
   开发运行下 process.execPath 是 electron.exe（图标自然是 Electron 的），
   所以这里不用 exe 的图标，自己生成一份。 */
function buildIco(images, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = 图标
  header.writeUInt16LE(images.length, 4);

  let offset = header.length + images.length * 16;
  const entries = images.map((data, index) => {
    const size = sizes[index];
    const entry = Buffer.alloc(16);
    // 256 在目录项里写作 0
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // 调色板颜色数：真彩色写 0
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4); // 颜色平面
    entry.writeUInt16LE(32, 6); // 位深
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images]);
}

function ensureMenuIcon() {
  if (menuIcon !== null) return menuIcon;
  menuIcon = '';

  if (!appIconPath || !fs.existsSync(appIconPath)) return menuIcon;

  try {
    const image = nativeImage.createFromPath(appIconPath);
    if (image.isEmpty()) return menuIcon;

    const sizes = [ICON_SMALL_SIZE, ICON_SIZE];
    const images = sizes.map((size) => image.resize({ width: size, height: size }).toPNG());
    const file = path.join(app.getPath('userData'), MENU_ICON_NAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildIco(images, sizes));
    menuIcon = file;
  } catch (error) {
    console.error('[ERROR] [DesktopMenu] 生成菜单图标失败:', error);
  }
  return menuIcon;
}

// Icon 值的最终写法：优先自己生成的 .ico，生成失败时退回可执行文件自带的图标
function menuIconValue() {
  const icon = ensureMenuIcon();
  return icon || `${launchTarget().exe},0`;
}

// .reg 文件里的字符串值：控制字符（换行、制表等）先换成空格，再转义反斜杠与引号
function regEscape(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function quoteArg(value) {
  const text = String(value == null ? '' : value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function commandLine(extraArgs) {
  const target = launchTarget();
  return [quoteArg(target.exe), ...target.args.map(quoteArg), ...extraArgs].join(' ');
}

// 菜单项文字：去掉首尾空白，过长截断，空标题给一个兜底名称
function menuLabel(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return UNTITLED;
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/* 整棵菜单树的 .reg 文本：先删旧树（三棵键都要删，上一版的子项就挂在菜单键自己的
   shell 子键下），再按当前列表写回。顺序即菜单里的顺序：
   新建 → 各张（显示）→ 各张（关闭）→ 批量显示 / 收起。 */
function buildRegFile(items) {
  const lines = [
    'Windows Registry Editor Version 5.00',
    '',
    `[-${MENU_KEY_FULL}]`,
    `[-${ITEMS_KEY_FULL}]`,
    '',
    `[${MENU_KEY_FULL}]`,
    `@="${regEscape(MENU_LABEL)}"`,
    `"MUIVerb"="${regEscape(MENU_LABEL)}"`,
    `"Icon"="${regEscape(menuIconValue())}"`,
    // 排在桌面右键菜单靠下的位置，不挤动系统原有的项
    '"Position"="Bottom"',
    // 子菜单在另一棵键上（见文件头的说明）
    `"ExtendedSubCommandsKey"="${ITEMS_KEY_NAME}"`
  ];

  const entries = [
    { verb: '01-new', label: '贴上便利贴', args: [`${ACTION_PREFIX}pick`] }
  ];
  // 每张便利贴占两条：先是「显示」（收起状态下贴回来），后是「关闭并移除」
  items.forEach((item, index) => {
    entries.push({
      verb: `20-${String(index + 1).padStart(3, '0')}-${item.id}`,
      label: menuLabel(item.title),
      args: [`${ACTION_PREFIX}show`, `${ID_PREFIX}${item.id}`]
    });
  });
  items.forEach((item, index) => {
    entries.push({
      verb: `30-${String(index + 1).padStart(3, '0')}-${item.id}`,
      label: `关闭「${menuLabel(item.title)}」`,
      args: [`${ACTION_PREFIX}close`, `${ID_PREFIX}${item.id}`]
    });
  });
  entries.push({ verb: '90-show-all', label: '全部显示', args: [`${ACTION_PREFIX}show-all`] });
  entries.push({ verb: '91-hide-all', label: '全部收起', args: [`${ACTION_PREFIX}hide-all`] });

  entries.forEach((entry) => {
    const base = `${ITEMS_KEY_FULL}\\shell\\${entry.verb}`;
    lines.push(
      '',
      `[${base}]`,
      `@="${regEscape(entry.label)}"`,
      '',
      `[${base}\\command]`,
      `@="${regEscape(commandLine(entry.args))}"`
    );
  });

  return `${lines.join('\r\n')}\r\n`;
}

// 把菜单树写进注册表：一次 reg import（文件为 UTF-16LE + BOM，标题里的中文才不会走样）
function applyMenu(items) {
  if (!isSupported()) return false;

  let file = '';
  try {
    file = path.join(app.getPath('temp'), TEMP_FILE_NAME);
    // BOM 不能省：reg import 靠它认出 UTF-16
    fs.writeFileSync(file, Buffer.from(`\ufeff${buildRegFile(items)}`, 'utf16le'));
  } catch (error) {
    console.error('[ERROR] [DesktopMenu] 写入注册表脚本失败:', error);
    return false;
  }

  try {
    execFileSync(REG_EXE, ['import', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    /* 注册表脚本原样留着：双击一下就能看到 regedit 报的是哪一行，
       比只看一段 stderr 好定位得多（下次写入会覆盖它） */
    const detail = [error && error.stdout, error && error.stderr, error && error.message]
      .map((part) => String(part || '').trim().split(/\r?\n/).filter(Boolean).pop() || '')
      .find(Boolean) || '';
    console.warn(`[WARN] [DesktopMenu] 注册桌面右键菜单失败: ${detail} (script=${file})`);
    return false;
  }

  try {
    fs.unlinkSync(file);
  } catch (error) {
    // 临时文件删不掉只影响临时目录的整洁，忽略
  }
  return true;
}

function currentItems() {
  try {
    const items = getItems();
    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error('[ERROR] [DesktopMenu] 读取便利贴清单失败:', error);
    return [];
  }
}

// 「id + 标题」清单：没变就不重复写注册表（正文改动不会走到这里）
function signatureOf(items) {
  return items.map((item) => `${item.id}\u0000${item.title || ''}`).join('\u0001');
}

function flushMenu() {
  if (!enabled) return;
  const items = currentItems();
  const signature = signatureOf(items);
  if (signature === lastSignature) return;
  if (!applyMenu(items)) return;

  lastSignature = signature;
}

/* 便利贴增删或换标题后调用：防抖后再重建菜单。
   调用点见 sticky_notes.js 的记录写入，正文与窗口位置的变化不会改变清单签名。 */
function syncDesktopMenu() {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flushMenu();
  }, SYNC_DELAY);
}

// 注册菜单并写入当前清单；平台不支持时只留一条日志，其余功能不受影响
function registerDesktopMenu() {
  if (!isSupported()) {
    console.warn('[WARN] [DesktopMenu] 当前平台没有可用的 reg.exe，跳过桌面右键菜单注册');
    return false;
  }

  enabled = true;
  const items = currentItems();
  if (!applyMenu(items)) {
    enabled = false;
    return false;
  }

  lastSignature = signatureOf(items);
  console.log(`[INFO] [DesktopMenu] Registered desktop context menu (items=${items.length} icon=${menuIcon ? 'generated' : 'exe'})`);
  return true;
}

// 应用退出：删除整棵菜单树，桌面上不再留下指向本应用的菜单项
function unregisterDesktopMenu() {
  enabled = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!isSupported()) return;

  // 两棵键都要删：菜单本身，以及子项所在的那棵树
  [MENU_KEY_FULL, ITEMS_KEY_FULL].forEach((key) => {
    try {
      execFileSync(REG_EXE, ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' });
      console.log(`[INFO] [DesktopMenu] Removed desktop context menu (key=${key})`);
    } catch (error) {
      // 本来就没有这一项时 reg delete 会以非零退出，不是错误
    }
  });
}

function readArg(argv, prefix) {
  const found = (argv || []).find((item) => typeof item === 'string' && item.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : '';
}

/* 启动参数里带着菜单动作时执行它，返回是否确实处理了。
   主进程在首次启动与 second-instance（应用已在运行时点菜单）两处都调用这里。 */
function handleDesktopMenuArgv(argv) {
  const action = readArg(argv, ACTION_PREFIX);
  if (!action) return false;

  try {
    onAction(action, readArg(argv, ID_PREFIX));
  } catch (error) {
    console.error('[ERROR] [DesktopMenu] 执行桌面菜单动作失败:', error);
  }
  return true;
}

function configureDesktopMenu({ getItems: readItems, onAction: runAction, icon } = {}) {
  if (typeof readItems === 'function') getItems = readItems;
  if (typeof runAction === 'function') onAction = runAction;
  if (typeof icon === 'string' && icon) appIconPath = icon;
}

module.exports = {
  configureDesktopMenu,
  handleDesktopMenuArgv,
  registerDesktopMenu,
  syncDesktopMenu,
  unregisterDesktopMenu
};
