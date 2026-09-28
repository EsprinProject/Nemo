/* 桌面层级：把窗口压到所有窗口之下（贴在桌面之上，不遮挡任何应用窗口）。
 *
 * Electron 只能把窗口抬到最前（setAlwaysOnTop），没有「置底」的 API，
 * 也没有桌面窗口类型（type: 'desktop' 只在 Linux 上有效），
 * 因此这里维护一个常驻的 Windows PowerShell 子进程，把窗口句柄逐行送过去，
 * 由脚本调 Win32 的 SetWindowPos(HWND_BOTTOM) 完成（见 desktop_layer.ps1）。
 *
 * 常驻而不是逐次拉起：置底发生在每一次显示、失焦与点击之后，而 PowerShell 冷启动
 * 约百毫秒量级，每次点击都拉起一个进程在代价上说不过去。
 *
 * 环境不支持、或脚本反复退出时停用置底（unavailable）：便利贴退化为普通的窗口，
 * 功能照旧可用，只是被点击后会停在最前。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Windows PowerShell 5.1 的固定位置（与 speech_windows.js 同一约定：
// Add-Type 依赖 .NET Framework，pwsh 下不可用）
const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT_FILE = path.join(__dirname, 'desktop_layer.ps1');

// 子进程意外退出时的重启上限：脚本反复起不来时不至于变成拉起风暴
const MAX_RESTARTS = 3;
// 退出时等待子进程自行收场的时间，超时后强杀
const QUIT_GRACE_MS = 400;
// 首行脚本里的 Add-Type 需要编译一次（约百毫秒量级），期间写入 stdin 会排队，不必等待

let scriptSource = '';
let child = null;
let restarts = 0;
let unavailable = false;
let closing = false;

function isSupportedPlatform() {
  return process.platform === 'win32' && fs.existsSync(POWERSHELL_EXE);
}

// 脚本内容只读一次；以 UTF-16LE base64 经 -EncodedCommand 交给 PowerShell：
// 不落临时文件，也不受命令行引号与控制台代码页影响（见 desktop_layer.ps1 头部说明）
function buildEncodedCommand() {
  if (!scriptSource) scriptSource = fs.readFileSync(SCRIPT_FILE, 'utf8');
  return Buffer.from(scriptSource, 'utf16le').toString('base64');
}

// 窗口句柄：Windows 上按本机字节序存放，64 位系统为 8 字节、32 位系统为 4 字节
function windowHandle(win) {
  try {
    const buffer = win.getNativeWindowHandle();
    if (!buffer || !buffer.length) return '';
    return buffer.length >= 8 ? buffer.readBigUInt64LE(0).toString() : String(buffer.readUInt32LE(0));
  } catch (error) {
    return '';
  }
}

function spawnHelper() {
  const process_ = spawn(POWERSHELL_EXE, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', buildEncodedCommand()
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });

  // PowerShell 的报错只作诊断留在主进程日志里，不往界面上抛
  process_.stderr.setEncoding('utf8');
  process_.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn(`[WARN] [DesktopLayer] ${text.split(/\r?\n/)[0]}`);
  });

  // 子进程已经退出时再往管道里写会异步报错：这里接住，下一次请求自会重启它
  process_.stdin.on('error', () => {});

  process_.on('error', (error) => {
    console.warn('[WARN] [DesktopLayer] 子进程启动失败，便利贴退回普通窗口层级:', error.message);
    unavailable = true;
    child = null;
  });

  process_.on('exit', (code) => {
    if (child === process_) child = null;
    if (closing || unavailable) return;

    restarts++;
    if (restarts >= MAX_RESTARTS) {
      unavailable = true;
      console.warn(`[WARN] [DesktopLayer] 子进程已退出 ${restarts} 次，停用置底 (code=${code})`);
      return;
    }
    console.warn(`[WARN] [DesktopLayer] 子进程退出，下次请求时重启 (code=${code})`);
  });

  return process_;
}

function ensureChild() {
  if (unavailable) return null;
  if (child && child.exitCode === null && !child.killed) return child;

  if (!isSupportedPlatform()) {
    unavailable = true;
    console.warn('[WARN] [DesktopLayer] 当前平台没有可用的 Windows PowerShell，停用置底');
    return null;
  }

  try {
    child = spawnHelper();
    return child;
  } catch (error) {
    unavailable = true;
    console.warn('[WARN] [DesktopLayer] 启动子进程失败，便利贴退回普通窗口层级:', error);
    return null;
  }
}

// 把一扇窗口压到桌面层。返回是否确实递出了请求（失败只影响层级，不影响窗口本身）
function setDesktopLevel(win) {
  if (unavailable || !win || win.isDestroyed()) return false;

  const handle = windowHandle(win);
  if (!handle) return false;

  const helper = ensureChild();
  if (!helper || !helper.stdin || helper.stdin.destroyed) return false;

  try {
    helper.stdin.write(`${handle}\n`);
    return true;
  } catch (error) {
    console.warn('[WARN] [DesktopLayer] 写入置底请求失败:', error.message);
    return false;
  }
}

// 临时把一扇窗口提到顶层（例如鼠标按下便利贴期间），松开后再由 setDesktopLevel 压回底层
function raiseAboveDesktop(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.moveTop();
  } catch (error) {
    // 忽略异常
  }
}

/* 把一扇窗口一直按在桌面层。
 *
 * Windows 在窗口被点击时把它抬到最前（激活与 z 序是两件事，无法只取其一），
 * 因此「始终置底」只能靠在每一次可能被抬起之后重做一次：显示、从最小化恢复、
 * 获得焦点、失去焦点都在此列。窗口已经获得过焦点时再点它不会再触发 focus，
 * 那种情况由渲染进程在 mousedown 时补一次（见 renderer/sticky_window.js 的 keep-bottom）。
 *
 * 顺带接住「显示桌面」（Win+D）：那个动作会连便利贴一起最小化，
 * 而便利贴本来就该在桌面上，因此收到 minimize 立刻恢复并压回底层。 */
function keepDesktopLevel(win) {
  if (!win || win.isDestroyed()) return;

  const pushDown = () => {
    if (win.isDestroyed()) return;
    setDesktopLevel(win);
  };

  win.on('show', pushDown);
  win.on('restore', pushDown);
  win.on('blur', pushDown);
  win.on('minimize', () => {
    if (win.isDestroyed()) return;
    win.restore();
    pushDown();
  });
}

// 退出前收掉子进程：否则系统里会留下一个等 stdin 的 PowerShell
function disposeDesktopLayer() {
  closing = true;
  const current = child;
  child = null;
  if (!current || current.exitCode !== null) return;

  try {
    current.stdin.write('quit\n');
  } catch (error) {
    // 管道可能已经断了，下面照样兜底强杀
  }

  const timer = setTimeout(() => {
    if (current.exitCode === null) {
      try {
        current.kill();
      } catch (error) {
        // 进程可能刚好自己退出了，忽略
      }
    }
  }, QUIT_GRACE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  current.once('exit', () => clearTimeout(timer));
}

module.exports = {
  disposeDesktopLayer,
  isDesktopLayerSupported: isSupportedPlatform,
  keepDesktopLevel,
  raiseAboveDesktop,
  setDesktopLevel
};
