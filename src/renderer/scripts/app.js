/* 应用启动：载入数据、迁移旧版单文件记录（index.json / ai_chats.json）与清理过期废纸篓条目，
   初始化各模块并首次渲染 */

// 废纸篓定期复查的定时器句柄：留一个引用，便于窗口卸载或调试时清理
let trashPurgeTimer = null;

/* 启动链的容错与自诊断。

   事件绑定（setupEvents）与首次渲染（renderApp）排在二十来个 init 之后，任何一步抛错
   都会让后面的步骤一并停下：界面画得出来、却点不动任何东西，也就是「整个界面都操作不了」。
   因此在启动前先装上三道保险：
     1. 每一步单独包起来（runBootStep）——一步失败只记一条，其余照常跑完，
        事件绑定与首次渲染因此一定能走到；
     2. 载入数据（loadData）单独兜底——数据层出错时退回空数据继续启动，而不是整体停摆；
     3. 未捕获的异常与未处理的异步错误一并记下（window 的 error / unhandledrejection）
        ——点某处没反应时能留下到底是哪一句抛的。
   渲染进程的 console 只在开发者工具里可见，因此最后把这些失败用提示条摆到界面上
   （showUiFailures），出错的那一块是哪一步、什么原因，一眼就能看到。 */
const UI_FAILURES = [];

function reportUiFailure(label, error) {
    const detail = error && error.message ? error.message : String(error);
    UI_FAILURES.push(`${label}：${detail}`);
    try {
        console.error(`[ERROR] [Boot] step=${label} msg=${detail}`);
    } catch (e) {}
}

function runBootStep(label, run) {
    try {
        return run();
    } catch (error) {
        reportUiFailure(label, error);
        return undefined;
    }
}

// 全局兜底：任何一处未捕获的异常 / 未处理的 Promise 拒绝都记一条，
// 免得界面「看着正常却点不动」时一行线索都留不下
window.addEventListener('error', (event) => {
    reportUiFailure('未捕获异常', (event && (event.error || event.message)) || '未知错误');
});
window.addEventListener('unhandledrejection', (event) => {
    reportUiFailure('未处理的异步错误', (event && event.reason) || '未知原因');
});

// 把失败清单摆到界面上：一条提示条报总数与第一条原因，完整清单留在 console 里
function showUiFailures() {
    if (!UI_FAILURES.length) return;
    try {
        console.error(`[ERROR] [Boot] failures=${UI_FAILURES.length}\n` + UI_FAILURES.join('\n'));
    } catch (e) {}
    if (typeof showToast !== 'function') return;
    const more = UI_FAILURES.length > 1 ? `（共 ${UI_FAILURES.length} 处，详情见开发者工具）` : '';
    showToast(`界面有一处出错：${UI_FAILURES[0]}${more}`);
}

// App Boot
window.onload = () => {
    // 数据载入失败不能让整个界面停在「画得出来、点不动」的状态上：退回空数据继续启动，
    // 出错的那一步记进失败清单并在最后提示出来
    let saved = {};
    try {
        saved = loadData() || {};
    } catch (error) {
        reportUiFailure('载入数据', error);
    }
    State.notes = Array.isArray(saved.notes) ? saved.notes : [];
    State.todos = Array.isArray(saved.todos) ? saved.todos : [];
    // 一次性标好条目类型：后续所有类型判断都是常数时间
    markItemKinds(State.notes, State.todos);
    State.folders = Array.isArray(saved.folders) && saved.folders.length ? saved.folders : ['默认'];
    State.theme = saved.theme || 'system';
    State.themeStyle = normalizeThemeStyle(saved.themeStyle);
    State.accentColor = normalizeAccentColor(saved.accentColor);
    State.brandColor = normalizeBrandColor(saved.brandColor);
    State.cornerRadius = normalizeCornerRadius(saved.cornerRadius);
    // 界面尺寸（缩放比例）：首屏已由 boot.js 按配置缩放，这里只接管后续的读写
    State.uiScale = normalizeUiScale(saved.uiScale);
    State.spellcheck = typeof saved.spellcheck === 'boolean' ? saved.spellcheck : false;
    // 界面布局（经典 / 现代，默认现代）：现代布局不排标题栏，标签页移到工作区顶部
    State.uiMode = normalizeUiMode(saved.uiMode);
    // 现代布局下的「禁用标签页」：只有显式写成 true 才算禁用，默认标签页开启
    State.tabsDisabled = saved.tabsDisabled === true;
    State.sidebarCollapsed = !!saved.sidebarCollapsed;
    State.trashRetentionDays = normalizeTrashRetentionDays(saved.trashRetentionDays);
    State.autoUpdate = saved.autoUpdate !== false;
    // gh-proxy 加速（默认关闭）：主进程检查更新与下载安装包时读这一项决定是否走代理
    State.ghProxyEnabled = saved.ghProxyEnabled === true;
    State.autoLaunch = saved.autoLaunch === true;
    State.trayEnabled = saved.trayEnabled !== false;
    State.stickyNotes = normalizeStickyConfig(saved.stickyNotes);
    State.fonts = normalizeFonts(saved.fonts);
    State.ai = normalizeAiConfig(saved.ai);
    // 随口记（语音转文本）：默认只走本机离线识别，联网要靠设置里的显式开关
    State.voice = normalizeVoiceConfig(saved.voice);
    // API Key 只保留「是否已保存 + 保管方式」，明文始终留在主进程与系统密钥链里
    State.aiHasApiKey = !!(saved.aiKeyStatus && saved.aiKeyStatus.hasKey);
    State.aiKeyStorage = aiKeyStorageKind(saved.aiKeyStatus);
    State.aiScope = State.ai.scope;
    // 自建同步（操作日志模型）：服务器地址、设备名与自动同步设置随 config.json 落盘，
    // 访问令牌在系统密钥链里。这一项必须在启动时载入：漏了的话界面读到的是默认空值，
    // 紧接着的首次保存又会把配置里那份抹掉
    State.syncServer = normalizeSyncServerConfig(saved.syncServer);
    State.syncServerLoaded = true;
    // 多对话记录（ai_chats/ 下的一份份文件）：载入后保证至少有一份可用对话
    adoptAiChats(saved.aiChats);

    // 笔记、待办与对话文件的格式修正已在 loadData 内就地完成，这里只需把文件夹列表的变化写回配置
    const cleanup = saved.dataCleanup;
    if (cleanup) {
        if (cleanup.foldersChanged) saveConfig();
        if (cleanup.legacyIndex && cleanup.legacyIndex.found) {
            console.warn(`索引迁移：已把 index.json 中的元数据并入 ${cleanup.legacyIndex.merged} 篇笔记文件`
                + (cleanup.legacyIndex.archived ? '，原文件保留为 index.json.bak' : '，原文件归档失败'));
        }
        if (cleanup.legacyAiChats && cleanup.legacyAiChats.found) {
            console.warn(`对话迁移：已把 ai_chats.json 中的 ${cleanup.legacyAiChats.merged} 份对话拆分为 ai_chats/{id}.json`
                + (cleanup.legacyAiChats.archived ? '，原文件保留为 ai_chats.json.bak' : '，原文件归档失败'));
        }
        if (cleanup.repairedNotes > 0) {
            console.warn(`笔记格式：已为 ${cleanup.repairedNotes} 篇笔记写回内嵌元数据`);
        }
        if (cleanup.repairedTodos > 0) {
            console.warn(`待办格式：已为 ${cleanup.repairedTodos} 项待办写回内嵌元数据`);
        }
        if (cleanup.skippedFiles > 0) {
            console.warn(`条目目录：已忽略 ${cleanup.skippedFiles} 个非笔记文件`);
        }
        if (cleanup.skippedTodoFiles > 0) {
            console.warn(`待办目录：已忽略 ${cleanup.skippedTodoFiles} 个非待办文件`);
        }
    }

    // 按保留策略清理过期的废纸篓条目：放在首次渲染之前，避免闪现即将被删除的内容
    const purgedTrashItems = runBootStep('清理废纸篓', purgeExpiredTrashItems) || 0;

    /* 以下每一步都经 runBootStep 隔离：某一步失败（某个元素对不上、某个数据目录读不出来）
       只记一条并继续，事件绑定（setupEvents）与首次渲染（renderApp）不受影响。
       步骤名会出现在失败提示里，据此能直接定位是哪个模块出的问题。 */

    // 原生下拉菜单统一换成自绘（select 与 datalist）：放在其余初始化之前，后续对 select.value 的赋值都能同步显示
    runBootStep('自绘下拉菜单', initCustomDropdowns);
    runBootStep('主题', initTheme);
    runBootStep('明暗模式', initThemeMode);
    runBootStep('界面风格', initThemeStyle);
    runBootStep('主题色', initAccentColor);
    runBootStep('应用名颜色', initBrandColor);
    runBootStep('圆角尺度', initCornerRadius);
    runBootStep('界面缩放', initUiScale);
    runBootStep('拼写检查', applySpellcheck);
    runBootStep('字体', initFonts);
    runBootStep('侧边栏收起状态', applySidebarCollapsed);
    runBootStep('设置分类', initSettingsNav);
    runBootStep('界面布局', initUiMode);
    runBootStep('AI 接口设置', initAiSettings);
    runBootStep('AI 对话记录', initAiChats);
    runBootStep('AI Agent', initAiAgent);
    runBootStep('AI 附件', initAiFiles);
    runBootStep('AI 面板', initAiPanel);
    // 随口记：编辑器顶栏入口、聆听条与快捷键（设置项由设置页渲染时同步）
    runBootStep('随口记', initVoiceNotes);
    // 事件绑定：这一步必须执行到，界面才不会「画得出来、点不动」
    runBootStep('事件绑定', setupEvents);
    runBootStep('废纸篓保留期限', syncTrashRetentionSelect);
    runBootStep('数据存放位置', refreshDataDirInfo);
    runBootStep('自建同步设置', initSyncServerSettings);
    runBootStep('日记文件设置', initJournalFileSettings);
    // 团队笔记：设置页里的共享请求与共享列表
    runBootStep('团队笔记设置', initTeamNotesSettings);
    // 秘密本：设置页里隐藏与加密条目的刷新入口
    runBootStep('秘密本设置', initSecretSettings);
    runBootStep('更新设置', initUpdateSettings);
    runBootStep('托盘设置', initTraySettings);
    runBootStep('开机自启设置', initAutoLaunchSettings);
    // 桌面便利贴：标题栏入口、设置分区与条目桥接（详见 scripts/sticky_notes.js）
    runBootStep('桌面便利贴设置', initStickyNoteSettings);

    // 启动时不自动打开任何标签页：停留在空状态，由用户自行选择、新建笔记或待办
    State.openNoteIds = [];
    State.activeNoteId = null;

    runBootStep('首次渲染', renderApp);
    // 上面任何一步失败都在这里汇总成一条提示：界面照常可用，出错的那一步写明在提示里
    showUiFailures();

    if (purgedTrashItems > 0) {
        showToast(`已自动清理 ${purgedTrashItems} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
    }
    if (cleanup && cleanup.legacyIndex && cleanup.legacyIndex.found) {
        showToast(cleanup.legacyIndex.archived
            ? '笔记元数据已并入各笔记文件（原 index.json 保留为 index.json.bak）'
            : '笔记元数据已并入各笔记文件');
    }
    if (cleanup && cleanup.legacyAiChats && cleanup.legacyAiChats.found) {
        showToast(cleanup.legacyAiChats.archived
            ? 'AI 对话已拆分为 ai_chats 下的一份份文件（原 ai_chats.json 保留为 ai_chats.json.bak）'
            : 'AI 对话已拆分为 ai_chats 下的一份份文件');
    }
    // 本次启动刚把 config.json 里的明文 API Key 收进系统密钥链：提示一次，避免用户以为密钥丢了
    if (saved.aiKeyStatus && saved.aiKeyStatus.migrated) {
        showToast('API Key 已改存到本机安全存储（不再明文写入 config.json）');
    }

    // 应用长时间驻留时也按策略复查；没有过期内容时不会产生任何刷新或磁盘写入。
    // 窗口在后台时先跳过，回到前台立即补一次，避免后台空转做无用的目录扫描。
    trashPurgeTimer = setInterval(() => {
        if (document.hidden) return;
        runTrashAutoPurge();
    }, TRASH_PURGE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) runTrashAutoPurge();
    });
};
