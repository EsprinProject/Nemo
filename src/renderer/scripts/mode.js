function applyUiMode() {
    const root = document.documentElement;
    root.classList.toggle(MODERN_LAYOUT_CLASS, isModernLayout());

    root.classList.toggle(TABS_DISABLED_CLASS, isTabsDisabled());
    syncNewButtonTitles();
}

function syncNewButtonTitles() {
    const noteBtn = document.getElementById('btn-new-note');
    const todoBtn = document.getElementById('btn-new-todo');
    if (noteBtn) {
        noteBtn.title = isModernLayout()
            ? '新建笔记 (Ctrl+N)'
            : '新建笔记或待办 (Ctrl+N / Ctrl+Shift+N)';
    }
    if (todoBtn) todoBtn.title = '新建待办 (Ctrl+Shift+N)';
}

function toggleUiMode(value) {
    const next = normalizeUiMode(value);
    if (next === State.uiMode) return;

    State.uiMode = next;
    applyUiMode();
    saveConfig();
    renderApp();
    syncUiModeUI();

    showToast(isModernLayout() ? '已切换到现代布局：标题栏已收起，标签页移到工作区顶部' : '已切换到经典布局');
}

function toggleTabsDisabled(disabled) {
    const next = !!disabled;
    if (next === State.tabsDisabled) return;

    State.tabsDisabled = next;
    applyUiMode();
    saveConfig();

    showToast(next ? '标签页已禁用：整条收起，列表里照旧能切条目' : '标签页已恢复');
}

function syncUiModeUI() {
    const select = document.getElementById('setting-ui-mode');
    if (select) select.value = normalizeUiMode(State.uiMode);

    const tabsToggle = document.getElementById('setting-tabs-disabled');
    if (tabsToggle) tabsToggle.checked = State.tabsDisabled;
}

function initUiMode() {
    const select = document.getElementById('setting-ui-mode');
    if (select) select.onchange = (event) => toggleUiMode(event.target.value);

    const tabsToggle = document.getElementById('setting-tabs-disabled');
    if (tabsToggle) tabsToggle.onchange = (event) => toggleTabsDisabled(event.target.checked);

applyUiMode();
    syncUiModeUI();
}
