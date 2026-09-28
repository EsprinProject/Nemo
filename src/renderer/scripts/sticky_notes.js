/* 桌面便利贴（主窗口侧）：把笔记或待办贴到桌面上，并应答便利贴窗口的读写请求。
   条目数据的读写全部发生在主窗口（State + 磁盘），便利贴窗口只负责显示与输入，
   两个窗口因此不会各存一份内容、互相覆盖。

   便利贴窗口本身由主进程创建与管理（见 src/main/sticky_notes.js），
   这里只提供三件事：标题栏入口与设置分区、条目右键菜单的「贴到桌面」，以及桥接应答。 */

// 已贴在桌面上的条目 id：主窗口改一条时据此判断要不要通知主进程，
// 批量导入 / 恢复备份时因此不会对着没有便利贴的条目空发消息
let stickyRefIds = new Set();

// 应答主进程：请求带着 id 转发过来，必须原样带回，主进程据此兑现对应的 Promise
function replyToStickyHost(payload) {
    try {
        ipcRenderer.send('sticky:reply', payload);
    } catch (err) {
        console.error('回复便利贴请求失败:', err);
    }
}

// 取一条条目给便利贴：加密未解锁的条目不给正文（取出来的是密文，显示没有意义）
function stickyItemSnapshot(itemId) {
    const item = getItemById(itemId);
    if (!item) return { ok: false, reason: 'missing' };
    if (isSecretLocked(item)) return { ok: false, reason: 'locked' };

    return {
        ok: true,
        item: {
            id: item.id,
            title: item.title || '',
            content: item.content || '',
            isDone: item.isDone === true,
            // 废纸篓中的条目仍可显示，但不接受编辑
            readonly: item.isTrashed === true
        }
    };
}

// 便利贴写回的改动：与从编辑器写回走同一条保存链路，界面同步刷新
function saveItemFromSticky(itemId, title, content, isDone) {
    const item = getItemById(itemId);
    if (!item) return { ok: false, reason: 'missing' };
    if (isSecretLocked(item)) return { ok: false, reason: 'locked' };
    if (isReadOnlyItem(item)) return { ok: false, reason: 'readonly' };

    const isActive = State.activeNoteId === itemId;
    // 主窗口可能也开着这一条：先把它自己的改动落盘，避免稍后的自动保存用旧内容覆盖
    if (isActive) flushPendingSave();

    item.title = typeof title === 'string' ? title : item.title;
    item.content = typeof content === 'string' ? content : item.content;
    if (typeof isDone === 'boolean' && isTodoItem(item)) item.isDone = isDone;
    item.updatedAt = Date.now();
    saveItem(item);

    // 正在看这一条时连编辑区一起刷新；否则只更新列表与标签页标题，尽量不打扰主窗口
    if (isActive) renderApp();
    else {
        renderListPanel();
        renderTabs();
    }
    return { ok: true, readonly: false };
}

function toggleDoneFromSticky(itemId, isDone) {
    const item = getItemById(itemId);
    if (!item) return { ok: false, reason: 'missing' };
    if (!isTodoItem(item)) return { ok: false, reason: 'not-todo' };
    if (isReadOnlyItem(item)) return { ok: false, reason: 'readonly' };

    item.isDone = typeof isDone === 'boolean' ? isDone : !item.isDone;
    saveItem(item);
    renderApp();
    return { ok: true, isDone: item.isDone };
}

// 主窗口内改动条目后，让贴在桌面上的那一份跟着刷新
function notifyStickyItemSaved(item) {
    if (!item || !item.id || !stickyRefIds.has(item.id)) return;
    try {
        ipcRenderer.send('sticky:item-changed', {
            itemId: item.id,
            exists: true,
            title: item.title || '',
            content: item.content || '',
            isDone: item.isDone === true,
            readonly: isReadOnlyItem(item)
        });
    } catch (err) {
        // 通知失败不影响本地保存
    }
}

// 条目被彻底删除后，贴在它上面的便利贴解除绑定（内容保留在便利贴上）
function notifyStickyItemRemoved(itemId) {
    if (!itemId || !stickyRefIds.has(itemId)) return;
    stickyRefIds.delete(itemId);
    try {
        ipcRenderer.send('sticky:item-changed', { itemId, exists: false });
    } catch (err) {
        // 同上
    }
}

/* ---------------- 标题栏入口 ---------------- */

// 标题栏按钮展开的菜单：贴当前内容 / 选择笔记贴上 / 显示与收起全部
function stickyMenuEntries() {
    const active = getActiveItem();
    const entries = [];
    if (active) {
        entries.push({ action: 'stick-current', icon: 'keep', label: `把当前${itemKindLabel(active)}贴到桌面` });
    }
    entries.push({ action: 'pick-note', icon: 'note_add', label: '贴上便利贴…' });
    entries.push({ action: 'show-all', icon: 'visibility', label: '显示全部便利贴' });
    entries.push({ action: 'hide-all', icon: 'visibility_off', label: '收起全部便利贴' });
    return entries;
}

function showStickyMenu(anchor) {
    const menu = document.getElementById('sticky-notes-menu');
    menu.innerHTML = '';

    stickyMenuEntries().forEach((entry) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'dropdown-option';
        el.dataset.action = entry.action;

        const icon = document.createElement('span');
        icon.className = 'ms-icon sm';
        icon.textContent = entry.icon;

        const label = document.createElement('span');
        label.className = 'dropdown-option-text';
        label.textContent = entry.label;

        el.append(icon, label);
        menu.appendChild(el);
    });

    // 触发按钮在窗口右上角：菜单与按钮右对齐，向下展开
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.classList.remove('hidden');

    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const menuRect = menu.getBoundingClientRect();
    const x = rect ? rect.right - menuRect.width : window.innerWidth - menuRect.width - 8;
    const y = rect ? rect.bottom + 4 : 8;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menuRect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menuRect.height - 4))}px`;
}

function hideStickyMenu() {
    document.getElementById('sticky-notes-menu').classList.add('hidden');
}

function toggleStickyMenu(anchor) {
    const menu = document.getElementById('sticky-notes-menu');
    if (menu.classList.contains('hidden')) showStickyMenu(anchor);
    else hideStickyMenu();
}

// 把当前打开的笔记或待办贴到桌面
function stickActiveItemToDesktop() {
    const item = getActiveItem();
    if (!item) {
        showToast('当前没有打开的内容');
        return;
    }
    stickItemToDesktop(item.id);
}

/* ---------------- 与主进程的交互 ---------------- */

// 桌面便利贴的总开关，以及记录条数（设置分区据此显示）
function applyStickyList(result) {
    const items = result && Array.isArray(result.items) ? result.items : [];
    stickyRefIds = new Set(items.map(item => item.refId).filter(Boolean));

    const countEl = document.getElementById('sticky-count');
    if (countEl) {
        countEl.textContent = items.length
            ? `已贴出 ${items.length} 张便利贴`
            : '还没有贴出的便利贴';
    }
    return items;
}

function refreshStickyList() {
    return ipcRenderer.invoke('sticky:list')
        .then((result) => applyStickyList(result))
        .catch((err) => {
            console.error('读取桌面便利贴列表失败:', err);
            return [];
        });
}

// 贴上便利贴：弹出选择窗口选择一篇笔记贴到桌面上
async function pickNoteToStick() {
    if (State.stickyNotes.enabled !== true) {
        showToast('桌面便利贴已关闭：可在「设置 → 系统 → 桌面便利贴」中开启');
        return;
    }

    // 可供贴上桌面的笔记：排除废纸篓、隐藏、未解锁加密与已贴出的笔记
    const candidates = State.notes.filter(note =>
        !note.isTrashed &&
        !isSecretHidden(note) &&
        note.locked !== true
    );

    if (!candidates.length) {
        showToast('当前没有可贴到桌面的笔记');
        return;
    }

    const choices = candidates.map(note => itemDisplayTitle(note));
    const picked = await showPromptWithChoices('请选择要贴到桌面的笔记', {
        title: '贴上便利贴',
        placeholder: '可输入笔记标题筛选或直接点选下方笔记…',
        choices,
        multiple: false,
        confirmLabel: '贴上'
    });

    if (!picked) return;

    const selectedTitle = (picked.selected && picked.selected[0]) || picked.value;
    if (!selectedTitle) return;

    // 优先匹配标题完全相同的笔记，若无则按输入文本模糊查找
    const matched = candidates.find(note => itemDisplayTitle(note) === selectedTitle)
        || candidates.find(note => (note.title || '').includes(selectedTitle));

    if (!matched) {
        showToast('未找到匹配的笔记');
        return;
    }

    await stickItemToDesktop(matched.id);
}

// 把一条笔记或待办贴到桌面
async function stickItemToDesktop(itemId) {
    if (State.stickyNotes.enabled !== true) {
        showToast('桌面便利贴已关闭：可在「设置 → 系统 → 桌面便利贴」中开启');
        return;
    }

    const item = getItemById(itemId);
    if (!item) return;
    if (isSecretHidden(item)) {
        showToast('隐藏的条目不在列表中，无法贴到桌面');
        return;
    }
    if (isSecretLocked(item)) {
        showToast('加密条目需在主窗口解锁后才能贴到桌面');
        return;
    }

    // 正在编辑的条目先把改动落盘，贴出来的是最新内容
    if (State.activeNoteId === itemId) flushPendingSave();

    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:create', {
            kind: isTodoItem(item) ? 'todo' : 'note',
            refId: item.id,
            title: item.title || '',
            content: item.content || '',
            isDone: item.isDone === true
        });
    } catch (err) {
        console.error('贴到桌面失败:', err);
    }

    if (!result || !result.ok) {
        showToast(result && result.reason === 'disabled' ? '桌面便利贴已关闭' : '贴到桌面失败');
        return;
    }

    await refreshStickyList();
    if (!result.shown) showToast(`已把${itemKindLabel(item)}贴到桌面`);
}

async function showAllStickyNotes() {
    if (State.stickyNotes.enabled !== true) {
        showToast('桌面便利贴已关闭：可在「设置 → 系统 → 桌面便利贴」中开启');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('sticky:show-all');
        const count = result && Number.isFinite(result.count) ? result.count : 0;
        showToast(count ? `已显示 ${count} 张便利贴` : '还没有贴出的便利贴');
        await refreshStickyList();
    } catch (err) {
        console.error('显示桌面便利贴失败:', err);
    }
}

async function hideAllStickyNotes() {
    try {
        const result = await ipcRenderer.invoke('sticky:hide-all');
        const count = result && Number.isFinite(result.count) ? result.count : 0;
        showToast(count ? `已收起 ${count} 张便利贴` : '还没有贴出的便利贴');
        await refreshStickyList();
    } catch (err) {
        console.error('收起桌面便利贴失败:', err);
    }
}

// 清除全部便利贴：记录与窗口一并移除，绑定条目的内容不受影响
async function clearAllStickyNotes() {
    const confirmed = await showConfirm('移除全部桌面便利贴？', {
        title: '清除桌面便利贴',
        detail: '所有贴出的便利贴会被移除，记录一并删除。便利贴上关联的笔记与待办本身不会被删除；只属于便利贴自己的内容会随之丢失。',
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '全部移除',
        danger: true
    });
    if (!confirmed) return;

    try {
        const result = await ipcRenderer.invoke('sticky:clear-all');
        const count = result && Number.isFinite(result.count) ? result.count : 0;
        showToast(count ? `已移除 ${count} 张便利贴` : '还没有贴出的便利贴');
        await refreshStickyList();
    } catch (err) {
        console.error('清除桌面便利贴失败:', err);
    }
}

// 外观（主题 / 风格 / 主题色 / 圆角 / 字体）变化后同步给便利贴窗口，
// 与小本本走同一条广播路径（见 scripts/appearance.js 的 syncScratchpadAppearance）
function syncStickyNotesAppearance() {
    try {
        ipcRenderer.send('sticky:appearance', {
            theme: getEffectiveTheme(),
            style: normalizeThemeStyle(State.themeStyle),
            accent: normalizeAccentColor(State.accentColor),
            radius: normalizeCornerRadius(State.cornerRadius),
            fonts: typeof normalizeFonts === 'function' ? normalizeFonts(State.fonts) : {}
        });
    } catch (err) {
        console.error('同步桌面便利贴外观失败:', err);
    }
}

/* ---------------- 设置分区 ---------------- */

function applyStickySettingsUI() {
    const config = State.stickyNotes;
    const enabled = document.getElementById('setting-sticky-enabled');
    if (enabled) enabled.checked = config.enabled !== false;
    const color = document.getElementById('setting-sticky-color');
    if (color) color.value = config.color;
}

// 总开关：关闭时把所有便利贴收起（记录保留），重新开启时贴回来
function setStickyEnabled(enabled) {
    State.stickyNotes.enabled = !!enabled;
    saveConfig();
    applyStickySettingsUI();

    ipcRenderer.invoke('sticky:set-enabled', { enabled: State.stickyNotes.enabled })
        .then((result) => {
            const count = result && Number.isFinite(result.count) ? result.count : 0;
            if (State.stickyNotes.enabled) showToast(count ? `已贴回 ${count} 张便利贴` : '已开启桌面便利贴');
            else showToast(count ? `已收起 ${count} 张便利贴，记录保留` : '已关闭桌面便利贴');
            return refreshStickyList();
        })
        .catch((err) => console.error('同步桌面便利贴开关失败:', err));
}

function initStickyNoteSettings() {
    const config = State.stickyNotes;
    applyStickySettingsUI();

    const enabled = document.getElementById('setting-sticky-enabled');
    if (enabled) {
        enabled.onchange = (e) => setStickyEnabled(e.target.checked);
    }

    const color = document.getElementById('setting-sticky-color');
    if (color) {
        color.onchange = (e) => {
            const value = String(e.target.value || '');
            const known = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];
            State.stickyNotes.color = known.includes(value) ? value : 'yellow';
            saveConfig();
        };
    }

    const btnNew = document.getElementById('btn-sticky-new');
    if (btnNew) btnNew.onclick = () => pickNoteToStick();
    const btnShow = document.getElementById('btn-sticky-show-all');
    if (btnShow) btnShow.onclick = () => showAllStickyNotes();
    const btnHide = document.getElementById('btn-sticky-hide-all');
    if (btnHide) btnHide.onclick = () => hideAllStickyNotes();
    const btnClear = document.getElementById('btn-sticky-clear');
    if (btnClear) btnClear.onclick = () => clearAllStickyNotes();

    // 标题栏按钮与它的菜单
    const btn = document.getElementById('btn-sticky-notes');
    if (btn) btn.onclick = () => toggleStickyMenu(btn);

    const menu = document.getElementById('sticky-notes-menu');
    if (menu) {
        menu.onclick = (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const action = target.getAttribute('data-action');
            hideStickyMenu();
            if (action === 'stick-current') stickActiveItemToDesktop();
            else if (action === 'pick-note' || action === 'new') pickNoteToStick();
            else if (action === 'show-all') showAllStickyNotes();
            else if (action === 'hide-all') hideAllStickyNotes();
        };
    }

    // 启动时与主进程对一次状态：记录里的便利贴数量与已贴出的条目清单
    refreshStickyList();
}

/* 便利贴窗口发来的桥接请求（读取与写回条目） */
ipcRenderer.on('sticky:get-item', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    replyToStickyHost({ id: data.id, ...stickyItemSnapshot(data.itemId) });
});

ipcRenderer.on('sticky:save-item', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    replyToStickyHost({
        id: data.id,
        ...saveItemFromSticky(data.itemId, data.title, data.content, data.isDone)
    });
});

ipcRenderer.on('sticky:toggle-done', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    replyToStickyHost({ id: data.id, ...toggleDoneFromSticky(data.itemId, data.isDone) });
});

// 主进程侧增删了便利贴（托盘与桌面右键菜单的入口）：重拉一次清单，设置里的张数跟着变
ipcRenderer.on('sticky:list-changed', () => refreshStickyList());
