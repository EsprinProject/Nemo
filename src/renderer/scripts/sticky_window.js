/* 桌面便利贴窗口：一张纸对应一条笔记、一项待办，或一份只属于它自己的空白内容。
   条目内容的权威副本在主窗口那侧（State + 磁盘），因此这里只负责显示与输入，
   读取与写回都经主进程转发（见 src/main/sticky_notes.js 的桥接一节）。

   默认是预览：纸面上是渲染后的 Markdown，标题栏里是纯文本标题，整条标题栏都能拖窗口；
   点标题栏右侧的编辑按钮才切到编辑态（标题变输入框、纸面变文本框），再点一次回到预览。

   关联关系在贴出来的那一刻就定了（主窗口的「贴到桌面」或「新建便利贴」），
   窗口里不提供选择关联对象、也不提供收起；标题栏上没有关闭按钮，
   关闭走纸面上的右键菜单（桌面右键菜单里也有同样一条），关闭即从桌面移除这张纸。 */

const { ipcRenderer } = require('electron');

// 窗口 id：主进程创建窗口时经命令行参数注入（见 main/sticky_notes.js 的 ITEM_ID_ARG）
const ID_ARG_PREFIX = '--esprin-nemo-sticky-id=';
const STICKY_ID = (() => {
    const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(ID_ARG_PREFIX));
    return matched ? matched.slice(ID_ARG_PREFIX.length).trim() : '';
})();

// 纸张颜色：键与色相角与主进程的 COLOR_VALUES / COLOR_HUES 一一对应
const STICKY_COLORS = [
    { key: 'yellow', label: '黄色', hue: 48 },
    { key: 'green', label: '绿色', hue: 96 },
    { key: 'blue', label: '蓝色', hue: 205 },
    { key: 'pink', label: '粉色', hue: 335 },
    { key: 'purple', label: '紫色', hue: 268 },
    { key: 'gray', label: '灰色', hue: 220 }
];

// 输入停顿后再落盘，避免每个按键都写一次文件
const SAVE_DELAY = 400;
// 浮层提示的停留时长
const HINT_VISIBLE_MS = 2600;

const rootEl = document.getElementById('sticky-root');
const titleEl = document.getElementById('sticky-title');
const previewEl = document.getElementById('sticky-preview');
const contentEl = document.getElementById('sticky-content');
const doneRowEl = document.getElementById('sticky-done-row');
const doneEl = document.getElementById('sticky-done');
const editBtn = document.getElementById('sticky-edit');
const colorBtn = document.getElementById('sticky-color-btn');
const colorsEl = document.getElementById('sticky-colors');
const menuEl = document.getElementById('sticky-menu');
const menuCloseEl = document.getElementById('sticky-menu-close');
const hintEl = document.getElementById('sticky-hint');

// 当前这张纸：主进程给出的快照（id / kind / refId / color / readonly 等）
let sticky = null;
// 只读：绑定的条目进了废纸篓或正文已加密时，由主进程标记
let readonly = false;
// 编辑态：默认预览，点编辑按钮切换
let editing = false;
// 已落盘的内容快照：与界面完全一致时跳过保存
let savedTitle = null;
let savedContent = null;
let savedDone = false;
let saveTimer = null;
let hintTimer = null;
let colorsOpen = false;
let contextMenuOpen = false;
// 首次载入完成前不落盘，避免用还没读出来的空内容覆盖记录
let ready = false;

// 初始就是预览态：标题只读、正文框收起（HTML 里已把预览排出来，这里只对齐输入框）
titleEl.readOnly = true;
setEditButtonState(false);

/* ---------------- 提示 ---------------- */

// 没有底栏，保存失败与只读原因改用这张浮起的小纸条说明
function showHint(text, isError) {
    if (!text) return;
    hintEl.textContent = text;
    hintEl.classList.toggle('error', !!isError);
    hintEl.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
        hintTimer = null;
        hintEl.classList.remove('show');
    }, HINT_VISIBLE_MS);
}

// 失败原因直白地写出来，而不是统一报「保存失败」
function reasonText(reason) {
    if (reason === 'readonly') return '条目在废纸篓中，无法保存';
    if (reason === 'locked') return '条目正文已加密，需在主窗口解锁后保存';
    if (reason === 'no-window') return '主窗口未就绪，内容暂存在便利贴里';
    if (reason === 'timeout') return '写入超时，内容暂存在便利贴里';
    if (reason === 'disabled') return '桌面便利贴已关闭';
    return '保存失败';
}

/* ---------------- 模式与内容 ---------------- */

function clearSaveTimer() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
}

function hasChanges() {
    return titleEl.value !== savedTitle || contentEl.value !== savedContent || doneEl.checked !== savedDone;
}

// 预览：与编辑器里的预览用同一份轻量渲染器，危险链接协议已在那边卡死
function renderPreview() {
    const text = contentEl.value;
    previewEl.innerHTML = text.trim() ? marked.parse(text) : '';
}

function setEditButtonState(isEditing) {
    const icon = editBtn.querySelector('.ms-icon');
    if (icon) icon.textContent = isEditing ? 'check' : 'edit';
    editBtn.title = isEditing ? '完成' : '编辑';
}

// 切换编辑 / 预览。回预览时把改动落盘（save 为 false 用于只读等不给保存的场合）
function setEditing(next, { save = true } = {}) {
    if (editing === next) return;
    editing = next;
    rootEl.classList.toggle('editing', editing);
    setEditButtonState(editing);

    if (editing) {
        // 编辑要占回标题那一行，先把色板收起来
        setColorsOpen(false);
        previewEl.classList.add('hidden');
        contentEl.classList.remove('hidden');
        titleEl.readOnly = false;
        // 标题还空着就先补标题，否则直接接着写正文
        if (!titleEl.value.trim()) {
            titleEl.focus();
            return;
        }
        contentEl.focus();
        contentEl.setSelectionRange(contentEl.value.length, contentEl.value.length);
        return;
    }

    titleEl.readOnly = true;
    contentEl.classList.add('hidden');
    previewEl.classList.remove('hidden');
    renderPreview();
    if (save) saveNow();
}

function applyColor(color) {
    const entry = STICKY_COLORS.find((item) => item.key === color) || STICKY_COLORS[0];
    document.body.dataset.stickyColor = entry.key;
    document.body.style.setProperty('--sticky-hue', String(entry.hue));
}

// 待办：完成勾选只在绑定待办时排出来，完成后标题划掉
function applyDoneState() {
    const isTodo = !!sticky && sticky.kind === 'todo';
    doneRowEl.classList.toggle('hidden', !isTodo);
    rootEl.classList.toggle('done', isTodo && savedDone);
    if (!isTodo) return;

    doneEl.checked = savedDone;
    doneEl.disabled = readonly;
}

// 只读：收掉编辑入口并说明原因（废纸篓中的条目仍可查看与复制）
function applyReadonly() {
    rootEl.classList.toggle('readonly', readonly);
    editBtn.classList.toggle('hidden', readonly);
    if (!readonly) return;

    setEditing(false, { save: false });
    showHint('该内容为只读：条目在废纸篓中，或正文已加密需先在主窗口解锁', true);
}

// 主进程给出的快照落到界面上
function applySnapshot(snapshot) {
    sticky = snapshot;
    readonly = snapshot.readonly === true;

    titleEl.value = snapshot.title || '';
    contentEl.value = snapshot.content || '';
    savedTitle = titleEl.value;
    savedContent = contentEl.value;
    savedDone = snapshot.isDone === true;

    applyColor(snapshot.color);
    renderPreview();
    setEditing(false, { save: false });
    applyDoneState();
    applyReadonly();
}

/* ---------------- 保存 ---------------- */

async function saveNow() {
    clearSaveTimer();
    if (!ready || !hasChanges()) return true;

    const title = titleEl.value;
    const content = contentEl.value;
    const isDone = doneEl.checked;

    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:save', { title, content, isDone });
    } catch (err) {
        console.error('保存便利贴失败:', err);
    }

    if (result && result.ok) {
        savedTitle = title;
        savedContent = content;
        savedDone = isDone;

        // 条目没了：解除关联，内容留在纸上（下一次保存就不再回写）
        if (result.reason === 'missing') {
            sticky = { ...sticky, refId: '', kind: 'free' };
            readonly = false;
            renderPreview();
            applyDoneState();
            applyReadonly();
            showHint('原条目已不存在，内容留在便利贴上', true);
            return true;
        }

        const wasReadonly = readonly;
        readonly = result.readonly === true;
        if (readonly !== wasReadonly) applyReadonly();
        return true;
    }

    showHint(reasonText(result && result.reason), true);
    return false;
}

function scheduleSave() {
    clearSaveTimer();
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

/* ---------------- 纸张颜色 ---------------- */

function buildColors() {
    colorsEl.innerHTML = '';
    STICKY_COLORS.forEach((entry) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'sticky-color-swatch' + (sticky && sticky.color === entry.key ? ' active' : '');
        swatch.title = entry.label;
        swatch.dataset.color = entry.key;
        swatch.style.setProperty('--swatch-hue', String(entry.hue));
        colorsEl.appendChild(swatch);
    });
}

function setColorsOpen(next) {
    colorsOpen = next;
    if (colorsOpen) buildColors();
    colorsEl.classList.toggle('hidden', !colorsOpen);
    // 色板展开时标题让出整行：两者不并排，色板从圆点右侧展开
    titleEl.classList.toggle('hidden', colorsOpen);
}

colorsEl.addEventListener('click', async (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;

    const color = swatch.dataset.color;
    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:set-color', { color });
    } catch (err) {
        console.error('更改便利贴颜色失败:', err);
    }
    if (!result || !result.ok) return;

    applyColor(result.color);
    if (sticky) sticky.color = result.color;
    setColorsOpen(false);
});

/* ---------------- 右键菜单 ---------------- */

// 标题栏上没有关闭按钮：在纸上右键才给出关闭入口（桌面右键菜单里也有同样一条）
function setContextMenuOpen(next, x = 0, y = 0) {
    contextMenuOpen = next;
    if (!contextMenuOpen) {
        menuEl.classList.add('hidden');
        return;
    }

    menuEl.classList.remove('hidden');
    // 先显示再量尺寸，位置才算得准；贴边时向内收，不越出窗口
    const rect = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

menuCloseEl.onclick = () => {
    setContextMenuOpen(false);
    requestClose();
};

document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setColorsOpen(false);
    setContextMenuOpen(true, e.clientX, e.clientY);
});

/* 按住便利贴时暂时置于顶层，松开时回到桌面最底层 */
document.addEventListener('mousedown', (e) => {
    if (colorsOpen && !e.target.closest('#sticky-colors') && !e.target.closest('#sticky-color-btn')) {
        setColorsOpen(false);
    }
    if (contextMenuOpen && !e.target.closest('#sticky-menu')) setContextMenuOpen(false);
    ipcRenderer.send('sticky:raise');
});

document.addEventListener('mouseup', () => {
    ipcRenderer.send('sticky:keep-bottom');
});

window.addEventListener('blur', () => {
    ipcRenderer.send('sticky:keep-bottom');
});

/* ---------------- 关闭 ---------------- */

/* 关闭即从桌面移除。未关联条目的纸上内容只属于它自己，移除前问一次；
   关联了条目时内容留在条目里，直接移除。 */
async function requestClose() {
    if (editing) await saveNow();

    const isFree = !sticky || !sticky.refId;
    const hasText = !!titleEl.value.trim() || !!contentEl.value.trim();
    if (isFree && hasText) {
        let choice = null;
        try {
            choice = await ipcRenderer.invoke('dialog:message', {
                type: 'question',
                icon: 'help',
                title: '桌面便利贴',
                message: '关闭并移除这张便利贴？',
                detail: '这张便利贴没有关联任何笔记或待办，纸上的内容只属于它自己，移除后无法恢复。',
                buttons: [
                    { id: 'cancel', label: '取消', cancel: true },
                    { id: 'remove', label: '移除', variant: 'danger' }
                ]
            });
        } catch (err) {
            console.error('打开确认窗口失败:', err);
            return;
        }
        if (!choice || choice.id !== 'remove') return;
    }

    ipcRenderer.invoke('sticky:close');
}

/* ---------------- 事件 ---------------- */

editBtn.onclick = () => setEditing(!editing);
colorBtn.onclick = (e) => {
    e.stopPropagation();
    setColorsOpen(!colorsOpen);
};

titleEl.addEventListener('input', scheduleSave);
contentEl.addEventListener('input', scheduleSave);

// 勾选完成状态：条目在主窗口那边写，失败就把勾选退回去
doneEl.addEventListener('change', async () => {
    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:toggle-done', { isDone: doneEl.checked });
    } catch (err) {
        console.error('更改完成状态失败:', err);
    }

    if (!result || !result.ok) {
        doneEl.checked = savedDone;
        applyDoneState();
        showHint(result && result.reason === 'readonly' ? '条目在废纸篓中，无法更改完成状态' : '更改完成状态失败', true);
        return;
    }

    savedDone = result.isDone === true;
    applyDoneState();
});

// 拖动窗口由标题栏承担（.titlebar 自带的 -webkit-app-region: drag，见 sticky.html）：
// 便利贴窗口小，交给系统拖动比按屏幕增量搬运可靠——指针很快会移到窗口之外，
// 而窗口外的 mousemove 不会送到渲染进程。位置尺寸的落盘由主进程在 moved / resized 时完成。

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (colorsOpen) {
            setColorsOpen(false);
            return;
        }
        if (contextMenuOpen) {
            setContextMenuOpen(false);
            return;
        }
        // 编辑中先退回预览：一次 Esc 不该把还在输入的内容带出窗口
        if (editing) setEditing(false);
        return;
    }

    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    // 编辑中按 Ctrl+S 等同「完成」，预览态则把未落盘的改动立刻写回
    if (editing) setEditing(false);
    else saveNow();
});

// 离开窗口（例如点开其它应用）时收起浮层并立刻落盘一次
window.addEventListener('blur', () => {
    setColorsOpen(false);
    setContextMenuOpen(false);
    if (!readonly) saveNow();
});

// 关窗兜底：异步写盘来不及等待，直接交给主进程接着完成
window.addEventListener('beforeunload', () => {
    if (readonly || !hasChanges()) return;
    ipcRenderer.send('sticky:flush', {
        id: STICKY_ID,
        title: titleEl.value,
        content: contentEl.value,
        isDone: doneEl.checked
    });
});

// 主窗口内变更外观后同步过来，与本窗口首屏用的是同一套应用逻辑
ipcRenderer.on('sticky:appearance', (event, payload) => {
    window.applyWindowAppearance(payload || {});
});

// 系统路径的关闭（Alt+F4 等）由主进程拦下后转到这里，与点关闭按钮同一条流程
ipcRenderer.on('sticky:request-close', () => requestClose());

/* 条目在主窗口被改动：同步到这张纸上。
   本地有未落盘的输入时直接跳过，免得把正在写的内容盖掉（本窗口带起的改动不会回到这里）。 */
ipcRenderer.on('sticky:item', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    if (!sticky || !sticky.refId || data.itemId !== sticky.refId) return;

    if (data.exists === false) {
        sticky = { ...sticky, refId: '', kind: 'free' };
        readonly = false;
        applyDoneState();
        applyReadonly();
        showHint('原条目已不存在，内容留在便利贴上', true);
        return;
    }

    if (data.readonly === true) {
        readonly = true;
        applyReadonly();
        return;
    }

    if (titleEl.value !== savedTitle || contentEl.value !== savedContent) return;

    titleEl.value = data.title;
    contentEl.value = data.content;
    savedTitle = data.title;
    savedContent = data.content;
    savedDone = data.isDone === true;
    applyDoneState();
    if (!editing) renderPreview();
});

async function boot() {
    window.applyWindowAppearance(window.readWindowAppearanceFromArgs());

    if (!STICKY_ID) {
        showHint('便利贴标识缺失，无法载入内容', true);
        return;
    }

    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:resolve');
    } catch (err) {
        console.error('载入便利贴失败:', err);
    }

    if (!result || !result.ok) {
        showHint('便利贴记录已不存在', true);
        ready = true;
        return;
    }

    applySnapshot(result.sticky);
    ready = true;

    if (result.reason === 'missing') showHint('原条目已不存在，内容留在便利贴上', true);
    else if (result.reason === 'no-window' || result.reason === 'timeout') {
        showHint('主窗口未就绪，内容暂存在便利贴里', true);
    }
}

boot();
