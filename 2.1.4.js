// ==UserScript==
// @name         抖音下载工具-调试版Pro
// @namespace    http://tampermonkey.net/
// @version      2.1.4
// @description  下载抖音用户主页数据! 自动过滤已下载作品，多线程批量下载，作品数量进度，超时重试，打包防崩，失败统计（顶部工具栏+历史表格优化+文件名修正）| 新增: 实时状态栏显示下载/打包进度百分比，下方详情栏动态显示当前下载文件名/打包进度条 | 修复: 暂停/恢复支持，重置功能强制清除所有任务
// @author       xxmdmst
// @match        https://www.douyin.com/*
// @icon         https://xxmdmst.oss-cn-beijing.aliyuncs.com/imgs/favicon.ico
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.6.0/jszip.min.js
// @license MIT
// ==/UserScript==

(function () {
    // ========== 全局变量 - 下载历史 & 任务管理 ==========
    let downloadHistory = GM_getValue("downloadHistory", []);
    let downloadQueue = GM_getValue("downloadQueue", []);
    let currentDownloadIndex = GM_getValue("currentDownloadIndex", 0);
    let isBatchPaused = GM_getValue("isPaused", false);
    let currentXHR = null;
    let downloadProgress = GM_getValue("downloadProgress", {});
    let maxConcurrent = 5;
    let activeDownloads = 0;
    let pendingWorks = [];
    let totalWorkCount = 0;
    let completedWorkCount = 0;
    let failedAwemeIds = new Set();
    let successWorks = [];
    let isDownloadingBatch = false;
    let abortControllers = new Map();
    const BATCH_ZIP_SIZE = 50;
    let failureStatsDiv = null;
    let lastFailureInfo = { successCount: 0, failCount: 0 };

    // ========== v2.1.3 新增变量 ==========
    let currentDownloadingFilename = "";           // 当前正在下载的作品文件名
    let packagedProcessedFiles = 0;                // 已经成功打包的文件数（用于百分比）
    let totalPackFiles = 0;                        // 需要打包的总文件数 (= successWorks.length)
    let currentPackagingIndex = 0;                 // 打包断点续传：下一个要打包的文件索引
    let isPackaging = false;                       // 是否正在打包中

    // ========== 原有全局变量 ==========
    let max_author_num = GM_getValue("max_author_num", 1000);
    let table;
    window.all_aweme_map = new Map();
    window.user_map = new Map();
    window.batchDownloadVideoIds = new Set();
    const user_local_data = localStorage.getItem('user_local_data');
    if (user_local_data) {
        JSON.parse(user_local_data).forEach((userInfo) => {
            user_map.set(userInfo.uid, userInfo);
        });
    }
    let current_user_id = null;
    const user_key = {
        "nickname": "昵称", "following_count": "关注", "mplatform_followers_count": "粉丝",
        "total_favorited": "获赞", "unique_id": "抖音号", "ip_location": "IP属地",
        "gender": "性别", "city": "位置", "signature": "签名", "aweme_count": "作品数"
    };

    // ========== 油猴菜单命令 ==========
    GM_registerMenuCommand("🔍 查看下载历史", showDownloadHistory);
    GM_registerMenuCommand("🗑️ 清空下载历史", clearDownloadHistory);
    GM_registerMenuCommand("📊 下载作品数据(UTF8)", () => downloadData(null));
    GM_registerMenuCommand("🔄 清空信息内容", () => msg_pre.textContent = "");
    GM_registerMenuCommand("👤 设置最大缓存作者数", setMaxAuthorNum);

    // ========== 工具函数（保持不变） ==========
    function initGbkTable() {
        const ranges = [
            [0xA1, 0xA9, 0xA1, 0xFE], [0xB0, 0xF7, 0xA1, 0xFE],
            [0x81, 0xA0, 0x40, 0xFE], [0xAA, 0xFE, 0x40, 0xA0],
            [0xA8, 0xA9, 0x40, 0xA0], [0xAA, 0xAF, 0xA1, 0xFE],
            [0xF8, 0xFE, 0xA1, 0xFE], [0xA1, 0xA7, 0x40, 0xA0]
        ];
        const codes = new Uint16Array(23940);
        let i = 0;
        for (const [b1Begin, b1End, b2Begin, b2End] of ranges) {
            for (let b2 = b2Begin; b2 <= b2End; b2++) {
                if (b2 !== 0x7F) {
                    for (let b1 = b1Begin; b1 <= b1End; b1++) codes[i++] = b2 << 8 | b1;
                }
            }
        }
        table = new Uint16Array(65536);
        table.fill(0xFFFF);
        const str = new TextDecoder('gbk').decode(codes);
        for (let i = 0; i < str.length; i++) table[str.charCodeAt(i)] = codes[i];
    }

    function str2gbk(str, opt = {}) {
        if (!table) initGbkTable();
        const defaultOnAlloc = (len) => new Uint8Array(len);
        const defaultOnError = () => 63;
        const onAlloc = opt.onAlloc || defaultOnAlloc;
        const onError = opt.onError || defaultOnError;
        const buf = onAlloc(str.length * 2);
        let n = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code < 0x80) { buf[n++] = code; continue; }
            const gbk = table[code];
            if (gbk !== 0xFFFF) { buf[n++] = gbk; buf[n++] = gbk >> 8; }
            else if (code === 8364) buf[n++] = 0x80;
            else {
                const ret = onError(i, str);
                if (ret === -1) break;
                if (ret > 0xFF) { buf[n++] = ret; buf[n++] = ret >> 8; }
                else buf[n++] = ret;
            }
        }
        return buf.subarray(0, n);
    }

    const toast = (msg, duration = 3000) => {
        let toastDom = document.createElement('pre');
        toastDom.textContent = msg;
        toastDom.style.cssText = 'padding:2px 15px;min-height:36px;line-height:36px;text-align:center;transform:translate(-50%);border-radius:4px;color:#fff;position:fixed;top:50%;left:50%;z-index:9999999;background:#000;font-size:16px;';
        document.body.appendChild(toastDom);
        setTimeout(() => {
            toastDom.style.transition = 'transform 0.5s ease-in, opacity 0.5s ease-in';
            toastDom.style.opacity = '0';
            setTimeout(() => document.body.removeChild(toastDom), 500);
        }, duration);
    };

    function formatSeconds(seconds) {
        const timeUnits = ['小时', '分', '秒'];
        const timeValues = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
        return timeValues.map((v, i) => v > 0 ? v + timeUnits[i] : '').join('');
    }

    const timeFormat = (timestamp = null, fmt = 'yyyy-mm-dd') => {
        timestamp = parseInt(timestamp);
        if (!timestamp) timestamp = Number(new Date());
        if (timestamp.toString().length === 10) timestamp *= 1000;
        let date = new Date(timestamp);
        let opt = {
            "y{4,}": date.getFullYear().toString(), "y+": date.getFullYear().toString().slice(2),
            "m+": (date.getMonth() + 1).toString(), "d+": date.getDate().toString(),
            "h+": date.getHours().toString(), "M+": date.getMinutes().toString(), "s+": date.getSeconds().toString()
        };
        for (let k in opt) {
            let ret = new RegExp("(" + k + ")").exec(fmt);
            if (ret) fmt = fmt.replace(ret[1], ret[1].length === 1 ? opt[k] : opt[k].padStart(ret[1].length, "0"));
        }
        return fmt;
    };

    function copyText(text, node = null) {
        if (node) {
            let old = node.textContent;
            node.textContent = "复制中...";
            navigator.clipboard.writeText(text).then(() => {
                toast("复制成功");
                node.textContent = "复制成功";
            }).catch(() => {
                toast("复制失败");
                node.textContent = "复制失败";
            });
            setTimeout(() => node.textContent = old, 2000);
        } else {
            navigator.clipboard.writeText(text).then(() => toast("复制成功")).catch(() => toast("复制失败"));
        }
    }

    function copyUserData(node) {
        if (!current_user_id) { toast("未捕获用户数据"); return; }
        let text = [];
        let user = user_map.get(current_user_id);
        for (let k in user_key) if (user[k]) text.push(user_key[k] + "：" + user[k]);
        copyText(text.join("\n"), node);
    }

    function createVideoButton(text, top, func) {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.style.position = "absolute";
        btn.style.right = "0px";
        btn.style.top = top;
        btn.style.zIndex = "99";
        btn.style.cursor = "pointer";
        btn.style.border = "1px solid #e0e0e0";
        btn.style.background = "#f5f5f5";
        btn.style.borderRadius = "4px";
        btn.style.padding = "3px 8px";
        btn.style.fontSize = "12px";
        btn.style.fontWeight = "bold";
        btn.style.color = "#333";
        btn.style.margin = "2px";
        if (func) btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); func(); };
        return btn;
    }

    function addToDownloadHistory(awemeId, nickname, filename) {
        downloadHistory = downloadHistory.filter(item => item.awemeId !== awemeId);
        downloadHistory.push({
            awemeId: awemeId,
            nickname: nickname || "未知作者",
            filename: filename
        });
        GM_setValue("downloadHistory", downloadHistory);
        refreshAllDownloadStatus();
    }

    function createDownloadLink(blob, filename, ext, prefix, awemeId) {
        if (!prefix) prefix = "";
        let fname = prefix + filename.replace(/[\\/:*?"<>|\s]/g, "").slice(0, 40) + "." + ext;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        a.click();
        URL.revokeObjectURL(a.href);

        if (awemeId && !awemeId.startsWith("batch_")) {
            let aweme = window.all_aweme_map.get(awemeId);
            let nickname = aweme ? aweme.nickname : "未知作者";
            addToDownloadHistory(awemeId, nickname, fname.replace(prefix, ""));
        }
    }

    function txt2file(txt, filename, ext) {
        createDownloadLink(new Blob([txt], { type: 'text/plain' }), filename, ext);
    }

    function getAwemeName(aweme) {
        let name = aweme.item_title || aweme.caption || aweme.desc || aweme.awemeId;
        return (aweme.date ? `【${aweme.date.slice(0, 10)}】` : "") + name.replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 27);
    }

    async function fetchWithRetry(url, signal, retries = 3, timeout = 3000) {
        let lastError;
        for (let i = 0; i <= retries; i++) {
            const controller = new AbortController();
            const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            const timeoutId = setTimeout(() => controller.abort(new Error("下载超时")), timeout);
            try {
                const response = await fetch(url.replace('http://', 'https://'), { signal: combinedSignal });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                return blob;
            } catch (err) {
                clearTimeout(timeoutId);
                lastError = err;
                if (i < retries) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        throw lastError;
    }

    async function downloadSingleAweme(aweme, abortSignal, retries = 3) {
        if (aweme.images && aweme.images.length > 0) {
            const imageBlobs = [];
            for (let i = 0; i < aweme.images.length; i++) {
                if (abortSignal?.aborted) throw new Error("下载已取消");
                const imgUrl = aweme.images[i].replace('http://', 'https://');
                try {
                    const blob = await fetchWithRetry(imgUrl, abortSignal, retries, 3000);
                    imageBlobs.push({
                        blob,
                        filename: `${getAwemeName(aweme)}_${i + 1}.jpg`
                    });
                } catch (err) {
                    throw new Error(`图片${i+1}下载失败: ${err.message}`);
                }
            }
            return { type: "image", blobs: imageBlobs };
        } else {
            const blob = await fetchWithRetry(aweme.url, abortSignal, retries, 3000);
            return {
                type: "video",
                blob: blob,
                filename: getAwemeName(aweme) + ".mp4"
            };
        }
    }

    // ========== 修复：支持暂停/恢复的批量下载主流程 ==========
    async function startBatchDownload() {
        if (isDownloadingBatch) {
            toast("检测到残留任务，正在强制重置...");
            forceResetAllTasks();
        }

        let selectedIds = Array.from(window.batchDownloadVideoIds);
        if (selectedIds.length === 0) {
            toast("请先选择要下载的作品");
            return;
        }

        const downloadedIds = new Set(downloadHistory.map(item => item.awemeId));
        const pendingIds = selectedIds.filter(id => !downloadedIds.has(id));
        if (pendingIds.length === 0) {
            toast("所选作品均已下载，无需重复下载");
            return;
        }
        toast(`已自动过滤 ${selectedIds.length - pendingIds.length} 个已下载作品，剩余 ${pendingIds.length} 个待下载`);

        // 初始化全局状态
        isDownloadingBatch = true;
        isBatchPaused = false;
        isPackaging = false;
        GM_setValue("isPaused", false);
        activeDownloads = 0;
        completedWorkCount = 0;
        successWorks = [];
        failedAwemeIds.clear();
        abortControllers.clear();

        // 构建待下载队列
        pendingWorks = [];
        totalWorkCount = 0;
        for (let id of pendingIds) {
            const aweme = window.all_aweme_map.get(id);
            if (!aweme) {
                toast(`作品 ${id} 数据不存在，跳过`);
                continue;
            }
            pendingWorks.push(aweme);
            totalWorkCount++;
        }
        if (pendingWorks.length === 0) {
            toast("无有效待下载作品");
            isDownloadingBatch = false;
            return;
        }

        updateTaskStatus();
        clearDetailPanel();
        toast(`开始批量下载，总作品数:${totalWorkCount} 并发:${maxConcurrent}`);

        // 主循环：只要有作品未下载且未被手动重置，就继续调度
        while (isDownloadingBatch && (pendingWorks.length > 0 || activeDownloads > 0)) {
            // 如果处于暂停状态，则等待恢复
            while (isBatchPaused && isDownloadingBatch) {
                await new Promise(r => setTimeout(r, 500));
                updateTaskStatus();
            }
            if (!isDownloadingBatch) break;
            await scheduleDownloads();   // 内部会下载一批任务，直到当前并发满或队列空
            await new Promise(r => setTimeout(r, 100)); // 避免过于频繁的空转
        }

        // 如果因为手动重置而退出，清理后返回
        if (!isDownloadingBatch) {
            resetAfterBatch();
            return;
        }

        // 下载阶段结束，等待用户取消暂停（如果有最后的暂停请求）
        while (isBatchPaused && isDownloadingBatch) {
            await new Promise(r => setTimeout(r, 500));
            updateTaskStatus();
        }
        if (!isDownloadingBatch) {
            resetAfterBatch();
            return;
        }

        // 所有作品下载完成，开始打包
        await startPackaging();

        // 打包完成后清理标志
        if (isDownloadingBatch && !isPackaging) {
            isDownloadingBatch = false;
            resetAfterBatch();
        }
    }

    // 打包入口（支持断点续传）- 保持不变
    async function startPackaging() {
        if (successWorks.length === 0) {
            toast("没有成功下载的文件，无法打包");
            updateFailureStats(0, failedAwemeIds.size);
            isPackaging = false;
            updateTaskStatus();
            updateDetailPanel();
            return;
        }

        isPackaging = true;
        isBatchPaused = false;    // 打包期间暂停标志复用
        totalPackFiles = successWorks.length;
        if (totalPackFiles === 0) return;

        if (currentPackagingIndex === 0) {
            packagedProcessedFiles = 0;
        }
        updateTaskStatus();
        updateDetailPanel();

        try {
            while (currentPackagingIndex < totalPackFiles && !isBatchPaused) {
                const startIdx = currentPackagingIndex;
                const endIdx = Math.min(startIdx + BATCH_ZIP_SIZE, totalPackFiles);
                const batchFiles = successWorks.slice(startIdx, endIdx);
                await generateZipWithProgress(batchFiles, startIdx, endIdx);
                const bundledCount = endIdx - startIdx;
                currentPackagingIndex = endIdx;
                packagedProcessedFiles = currentPackagingIndex;
                updateTaskStatus();
                updateDetailPanel();
                await new Promise(r => setTimeout(r, 50));
            }

            if (currentPackagingIndex >= totalPackFiles && !isBatchPaused) {
                const uniqueSuccessWorks = new Map();
                for (let item of successWorks) {
                    if (!uniqueSuccessWorks.has(item.awemeId)) {
                        uniqueSuccessWorks.set(item.awemeId, { nickname: item.nickname, filename: item.filename });
                    }
                }
                for (let [awemeId, info] of uniqueSuccessWorks.entries()) {
                    addToDownloadHistory(awemeId, info.nickname, info.filename);
                }
                const successWorkCount = uniqueSuccessWorks.size;
                const failCount = failedAwemeIds.size;
                updateFailureStats(successWorkCount, failCount);
                toast(`打包完成！成功作品:${successWorkCount} 失败作品:${failCount}`);
                isPackaging = false;
                updateTaskStatus();
                updateDetailPanel();
                packagedProcessedFiles = 0;
                totalPackFiles = 0;
                currentPackagingIndex = 0;
            } else if (isBatchPaused) {
                toast("打包已暂停");
                updateTaskStatus();
                updateDetailPanel();
            }
        } catch (err) {
            console.error("打包出错", err);
            toast(`打包中断: ${err.message}`);
            isPackaging = false;
            updateTaskStatus();
            updateDetailPanel();
        }
    }

    // 生成zip并更新进度 - 保持不变
    async function generateZipWithProgress(filesBatch, startIdx, endIdx) {
        const zip = new JSZip();
        for (let item of filesBatch) {
            zip.file(item.filename, item.blob);
        }
        let zipFilename = "";
        let authorNick = "未知作者";
        if (current_user_id && user_map.has(current_user_id)) {
            authorNick = user_map.get(current_user_id).nickname || "未知作者";
        } else if (successWorks.length > 0 && successWorks[0].nickname) {
            authorNick = successWorks[0].nickname;
        }
        authorNick = authorNick.replace(/[\\/:*?"<>|\s]/g, "");
        const batchNum = Math.floor(startIdx / BATCH_ZIP_SIZE) + 1;
        const totalBatch = Math.ceil(totalPackFiles / BATCH_ZIP_SIZE);
        if (totalBatch === 1) {
            zipFilename = `${authorNick}_抖音批量下载_${timeFormat(null, 'yyyyMMddHHmmss')}.zip`;
        } else {
            zipFilename = `${authorNick}_抖音批量下载_第${batchNum}部分_${timeFormat(null, 'yyyyMMddHHmmss')}.zip`;
        }
        toast(`正在生成压缩包 (${batchNum}/${totalBatch}): ${zipFilename}`);
        const zipBlob = await zip.generateAsync({ type: "blob" });
        createDownloadLink(zipBlob, zipFilename, "zip", "", "batch_" + Date.now() + "_" + batchNum);
    }

    // ========== 修复：强制重置所有任务（不依赖暂停条件） ==========
    function forceResetAllTasks() {
        // 中止所有下载请求
        for (let [id, controller] of abortControllers.entries()) {
            try { controller.abort(); } catch(e) {}
        }
        abortControllers.clear();
        // 重置所有标志
        isDownloadingBatch = false;
        isBatchPaused = false;
        isPackaging = false;
        // 清空队列和计数
        activeDownloads = 0;
        pendingWorks = [];
        successWorks = [];
        failedAwemeIds.clear();
        completedWorkCount = 0;
        totalWorkCount = 0;
        packagedProcessedFiles = 0;
        totalPackFiles = 0;
        currentPackagingIndex = 0;
        currentDownloadingFilename = "";
        if (currentXHR) {
            try { currentXHR.abort(); } catch(e) {}
            currentXHR = null;
        }
        // 更新UI
        updateTaskStatus();
        clearDetailPanel();
        // 额外重置暂停标志存储
        GM_setValue("isPaused", false);
        toast("已强制重置所有任务");
    }

    async function scheduleDownloads() {
        while ((pendingWorks.length > 0 || activeDownloads > 0) && !isBatchPaused) {
            while (activeDownloads < maxConcurrent && pendingWorks.length > 0 && !isBatchPaused) {
                const aweme = pendingWorks.shift();
                activeDownloads++;
                downloadOneWork(aweme).finally(() => {
                    activeDownloads--;
                    updateTaskStatus();
                    if (!isBatchPaused) scheduleDownloads();
                });
                updateTaskStatus();
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // ========== 修复：对 AbortError（暂停导致）的作品放回队列 ==========
    async function downloadOneWork(aweme) {
        currentDownloadingFilename = getAwemeName(aweme) + (aweme.images ? " (图片组)" : ".mp4");
        updateDetailPanel();

        const abortController = new AbortController();
        abortControllers.set(aweme.awemeId, abortController);
        let success = false;
        let error = null;
        try {
            const result = await downloadSingleAweme(aweme, abortController.signal, 3);
            if (result.type === "video") {
                successWorks.push({
                    blob: result.blob,
                    filename: result.filename,
                    awemeId: aweme.awemeId,
                    nickname: aweme.nickname || "未知作者"
                });
            } else {
                result.blobs.forEach(img => {
                    successWorks.push({
                        blob: img.blob,
                        filename: img.filename,
                        awemeId: aweme.awemeId,
                        nickname: aweme.nickname || "未知作者"
                    });
                });
            }
            completedWorkCount++;
            success = true;
            toast(`✅ 作品 ${aweme.awemeId} 下载成功`);
        } catch (err) {
            error = err;
            console.error(`下载失败 ${aweme.awemeId}:`, err);
            // 判断是否为用户主动暂停导致的中止错误
            const isAbortError = (err.name === 'AbortError' || (err.message && err.message.includes('aborted')));
            if (isAbortError && isBatchPaused) {
                // 放回队列头部，等待恢复后重试
                pendingWorks.unshift(aweme);
                toast(`⏸️ 下载已暂停，作品 ${aweme.awemeId} 将稍后重试`);
                // 不增加失败计数，也不减少 totalWorkCount
            } else {
                // 其他永久性失败
                failedAwemeIds.add(aweme.awemeId);
                toast(`❌ 作品 ${aweme.awemeId} 下载失败，已跳过: ${err.message}`);
            }
        } finally {
            abortControllers.delete(aweme.awemeId);
            if (!success && !failedAwemeIds.has(aweme.awemeId) && error && !(error.name === 'AbortError' && isBatchPaused)) {
                failedAwemeIds.add(aweme.awemeId);
            }
            updateTaskStatus();
            if (activeDownloads === 0 && pendingWorks.length === 0) {
                currentDownloadingFilename = "";
                updateDetailPanel();
            }
        }
    }

    // 更新顶部状态栏
    function updateTaskStatus() {
        if (window.taskEl) {
            let s = "";
            if (isPackaging && totalPackFiles > 0) {
                let percent = Math.floor((packagedProcessedFiles / totalPackFiles) * 100);
                s = `📦 正在打包：${percent}% (${packagedProcessedFiles}/${totalPackFiles} 文件)`;
            } else if (isDownloadingBatch) {
                s = `⏬ 正在下载：${completedWorkCount}/${totalWorkCount} 作品 | 并发: ${activeDownloads}/${maxConcurrent}`;
                if (isBatchPaused) s = `⏸️ 已暂停 | ${s}`;
            } else {
                s = "📥 任务状态：无任务";
            }
            window.taskEl.textContent = s;
        }
        refreshBatchCount();
    }

    // 更新下方详情栏
    function updateDetailPanel() {
        if (!failureStatsDiv) return;
        failureStatsDiv.style.display = "block";
        if (isDownloadingBatch && !isPackaging && (activeDownloads > 0 || pendingWorks.length > 0)) {
            let displayName = currentDownloadingFilename || "准备下载...";
            failureStatsDiv.innerHTML = `<div style="font-size:13px; color:#cbd5e1;">⬇️ 当前下载：<span style="color:#facc15; font-weight:bold;">${escapeHtml(displayName)}</span></div>`;
        } else if (isPackaging && totalPackFiles > 0) {
            let percent = (packagedProcessedFiles / totalPackFiles) * 100;
            let percentFixed = percent.toFixed(1);
            failureStatsDiv.innerHTML = `
                <div style="margin-bottom:4px; font-size:12px;">📦 打包进度 ${percentFixed}% (${packagedProcessedFiles}/${totalPackFiles})</div>
                <div style="background:#334155; border-radius:8px; height:8px; width:100%; overflow:hidden;">
                    <div style="background:#3b82f6; width:${percent}%; height:100%; border-radius:8px; transition:width 0.2s;"></div>
                </div>
            `;
        } else if (!isDownloadingBatch && !isPackaging && (lastFailureInfo.successCount > 0 || lastFailureInfo.failCount > 0)) {
            if (lastFailureInfo.failCount > 0) {
                failureStatsDiv.innerHTML = `⚠️ 打包完成：成功 <span style="color:#4ade80;">${lastFailureInfo.successCount}</span> 个作品，失败 <span style="color:#ff5555;">${lastFailureInfo.failCount}</span> 个（失败作品可重新选择下载）`;
            } else if (lastFailureInfo.successCount > 0) {
                failureStatsDiv.innerHTML = `✅ 打包完成：成功 ${lastFailureInfo.successCount} 个作品，无失败`;
            } else {
                failureStatsDiv.innerHTML = "";
            }
        } else {
            failureStatsDiv.innerHTML = "";
        }
    }

    function clearDetailPanel() {
        if (failureStatsDiv) {
            failureStatsDiv.innerHTML = "";
            failureStatsDiv.style.display = "block";
        }
        currentDownloadingFilename = "";
    }

    function escapeHtml(str) {
        if (!str) return "";
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
            return c;
        });
    }

    function updateFailureStats(successCount, failCount) {
        lastFailureInfo = { successCount, failCount };
        if (!isPackaging && !isDownloadingBatch) {
            updateDetailPanel();
        }
    }

    function clearFailureStatsUI() {
        clearDetailPanel();
        lastFailureInfo = { successCount: 0, failCount: 0 };
        if (failureStatsDiv && !isDownloadingBatch && !isPackaging) {
            failureStatsDiv.innerHTML = "";
        }
    }

    function bindClearFailureOnButtons(boxBody) {
        const btns = boxBody.querySelectorAll('button');
        btns.forEach(btn => {
            const originalClick = btn.onclick;
            btn.onclick = (e) => {
                if (originalClick) originalClick.call(btn, e);
                clearFailureStatsUI();
            };
        });
    }

    function refreshAllDownloadStatus() {
        document.querySelectorAll('[data-vid]').forEach(n => {
            let id = n.dataset.vid;
            let b = Array.from(n.children).find(x => x.dataset.t === "ds");
            if (b) updateDownloadStatusBtn(b, id);
        });
        updateTaskStatus();
    }

    function updateDownloadStatusBtn(btn, id) {
        if (downloadHistory.some(x => x.awemeId === id)) {
            btn.textContent = "✅已下载"; btn.style.color = "#090";
        } else {
            btn.textContent = "❌未下载"; btn.style.color = "#f00"; btn.style.fontWeight = "bold";
        }
    }

    function markAsDownloaded() {
        let ids = Array.from(window.batchDownloadVideoIds);
        if (ids.length === 0) { toast("未选择"); return; }
        ids.forEach(id => {
            let a = window.all_aweme_map.get(id);
            if (a) addToDownloadHistory(id, a.nickname || "未知", getAwemeName(a) + (a.images ? "_1.jpg" : ".mp4"));
        });
        toast(`已标记 ${ids.length} 个`);
        refreshAllDownloadStatus();
        clearFailureStatsUI();
    }

    function unmarkAsDownloaded() {
        let ids = Array.from(window.batchDownloadVideoIds);
        if (ids.length === 0) { toast("未选择"); return; }
        downloadHistory = downloadHistory.filter(x => !ids.includes(x.awemeId));
        GM_setValue("downloadHistory", downloadHistory);
        toast(`已取消标记`);
        refreshAllDownloadStatus();
        clearFailureStatsUI();
    }

    function showDownloadHistory() {
        if (downloadHistory.length === 0) {
            toast("暂无下载记录");
            return;
        }
        let box = document.createElement('div');
        box.style.cssText = `
            position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
            width:750px; max-height:80vh; background:#1e293b; color:#fff;
            padding:20px; border-radius:12px; z-index:9999999;
            overflow-y:auto; box-shadow:0 8px 32px #0008;
        `;
        let copyBtn = document.createElement('button');
        copyBtn.textContent = "📋 一键复制所有记录";
        copyBtn.style.cssText = "padding:8px 16px; background:#0ea5e9; color:#fff; border:none; border-radius:8px; cursor:pointer; margin-bottom:10px;";

        let html = `<div style='display:flex;justify-content:space-between;align-items:center;'>
            <h3>📥 下载历史记录</h3>
        </div>
        <table style='width:100%;border-collapse:collapse;margin-top:10px;'>
            <thead>
                <tr style='background:#334155;text-align:left'>
                    <th style='padding:10px;border:1px solid #475569'>UP主昵称</th>
                    <th style='padding:10px;border:1px solid #475569'>作品ID</th>
                    <th style='padding:10px;border:1px solid #475569'>文件名</th>
                 </tr>
            </thead>
            <tbody>`;

        let allText = "下载历史：\n";
        downloadHistory.forEach((item, i) => {
            let bg = i % 2 === 0 ? '#1e293b' : '#273444';
            html += `<tr style='background:${bg};border-bottom:1px solid #475569'>
                <td style='padding:10px;border:1px solid #475569'>${item.nickname}</td>
                <td style='padding:10px;border:1px solid #475569'>${item.awemeId}</td>
                <td style='padding:10px;border:1px solid #475569'>${item.filename}</td>
             </tr>`;
            allText += `【${i + 1}】${item.nickname} | ${item.awemeId} | ${item.filename}\n`;
        });

        html += `</tbody></table>`;
        copyBtn.onclick = () => copyText(allText);
        box.innerHTML = html;
        box.insertBefore(copyBtn, box.firstChild);
        document.body.appendChild(box);

        const close = () => { if (document.body.contains(box)) document.body.removeChild(box); };
        box.onclick = (e) => { if (e.target === box) close(); };
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
        });
    }

    function clearDownloadHistory() {
        if (!confirm("确定清空下载历史？")) return;
        downloadHistory = []; GM_setValue("downloadHistory", []);
        toast("下载历史已清空"); refreshAllDownloadStatus();
    }

    function refreshBatchCount() {
        if (window.dlBtn) window.dlBtn.textContent = `打包下载选中作品 [${window.batchDownloadVideoIds.size}]`;
        updatePauseResumeBtnText();
    }

    function updatePauseResumeBtnText() {
        if (window.pauseResumeBtn) {
            if (isDownloadingBatch || isPackaging) window.pauseResumeBtn.textContent = isBatchPaused ? "继续" : "暂停";
            else window.pauseResumeBtn.textContent = "暂停/继续";
        }
    }

    function toggleSelect(vid, btn) {
        if (window.batchDownloadVideoIds.has(vid)) {
            window.batchDownloadVideoIds.delete(vid);
            btn.textContent = "❌未选择"; btn.style.background = ""; btn.style.color = "";
        } else {
            window.batchDownloadVideoIds.add(vid);
            btn.textContent = "✅已选择"; btn.style.background = "#ff4444"; btn.style.color = "#fff";
        }
        refreshBatchCount();
        clearFailureStatsUI();
    }

    function cancelAllSelect() {
        window.batchDownloadVideoIds.clear();
        document.querySelectorAll('[data-vid]').forEach(n => {
            let b = Array.from(n.children).find(x => x.textContent.includes("选择"));
            if (b) { b.textContent = "❌未选择"; b.style.background = ""; b.style.color = ""; }
        });
        toast("已取消全部选择");
        refreshBatchCount();
        clearFailureStatsUI();
    }

    function selectAllCurrentUp() {
        if (!current_user_id) { toast("请先进入作者主页"); return; }
        let list = Array.from(window.all_aweme_map.values()).filter(x => x.uid === current_user_id).map(x => x.awemeId);
        if (list.length === 0) { toast("无作品"); return; }
        list.forEach(id => window.batchDownloadVideoIds.add(id));
        document.querySelectorAll('[data-vid]').forEach(n => {
            let b = Array.from(n.children).find(x => x.textContent.includes("选择"));
            if (b && list.includes(n.dataset.vid)) { b.textContent = "✅已选择"; b.style.background = "#ff4444"; b.style.color = "#fff"; }
        });
        toast(`已全选 ${list.length} 个作品`);
        refreshBatchCount();
        clearFailureStatsUI();
    }

    function reverseSelect() {
        if (!current_user_id) { toast("请进入作者主页"); return; }
        let list = Array.from(window.all_aweme_map.values()).filter(x => x.uid === current_user_id).map(x => x.awemeId);
        list.forEach(id => {
            if (window.batchDownloadVideoIds.has(id)) window.batchDownloadVideoIds.delete(id);
            else window.batchDownloadVideoIds.add(id);
        });
        document.querySelectorAll('[data-vid]').forEach(n => {
            let b = Array.from(n.children).find(x => x.textContent.includes("选择"));
            if (b) {
                let has = window.batchDownloadVideoIds.has(n.dataset.vid);
                b.textContent = has ? "✅已选择" : "❌未选择";
                b.style.background = has ? "#ff4444" : "";
                b.style.color = has ? "#fff" : "";
            }
        });
        toast("已反选");
        refreshBatchCount();
        clearFailureStatsUI();
    }

    function downloadImage(aweme, btn) {
        if (downloadHistory.some(x => x.awemeId === aweme.awemeId)) {
            toast("已下载"); btn.textContent = "✅已下载"; btn.style.color = "green";
            setTimeout(()=> { btn.textContent = "图片打包"; btn.style.color = ""; }, 2000); return;
        }
        let zip = new JSZip();
        let old = btn.textContent; btn.textContent = "打包中...";
        Promise.all(aweme.images.map((u, i) => fetch(u).then(r => r.arrayBuffer()).then(b => zip.file(`img${i+1}.jpg`, b))))
            .then(() => zip.generateAsync({ type: "blob" })).then(b => {
                createDownloadLink(b, getAwemeName(aweme), "zip", "【图文】", aweme.awemeId);
                btn.textContent = old;
            }).catch(() => { btn.textContent = old; toast("打包失败"); });
    }

    function createButtonGroup(aNode) {
        if (aNode.dataset.vid) return;
        let m = aNode.href.match(/(video|note)\/(\d+)/);
        if (!m) return;
        let vid = m[2];
        let aweme = window.all_aweme_map.get(vid);
        if (!aweme) return;
        let copyBtn = createVideoButton("复制描述", "0px", () => copyText(aweme.desc, copyBtn));
        aNode.appendChild(copyBtn);
        let openBtn = createVideoButton("打开源", "28px", () => window.open(aweme.url));
        aNode.appendChild(openBtn);
        let dlBtn = createVideoButton("下载视频", "56px", () => downloadVideo(aweme, dlBtn));
        aNode.appendChild(dlBtn);
        let selBtn = createVideoButton(window.batchDownloadVideoIds.has(vid) ? "✅已选择" : "❌未选择", aweme.images ? "112px" : "84px", () => toggleSelect(vid, selBtn));
        aNode.appendChild(selBtn);
        let statBtn = createVideoButton("", aweme.images ? "140px" : "112px");
        statBtn.dataset.t = "ds"; statBtn.style.pointerEvents = "none";
        updateDownloadStatusBtn(statBtn, vid);
        aNode.appendChild(statBtn);
        if (aweme.images) { let imgBtn = createVideoButton("图片打包", "84px", () => downloadImage(aweme, imgBtn)); aNode.appendChild(imgBtn); }
        aNode.dataset.vid = vid;
    }

    function downloadData(node, enc) {
        if (window.all_aweme_map.size === 0) { alert("无作品数据"); return; }
        let t = "作者昵称,作品描述,作品链接,点赞,评论,收藏,分享,发布时间,时长,标签,分类,封面,下载链接\n";
        Array.from(window.all_aweme_map.values()).sort((a,b)=>b.create_time-a.create_time).forEach(a=>{
            t+= [a.nickname,`"${(a.desc||"").replace(/"/g,'""')}"`,"https://www.douyin.com/video/"+a.awemeId,a.diggCount,a.commentCount,a.collectCount,a.shareCount,a.date,a.duration,a.tag,a.video_tag,a.cover,`"${a.url}"`].join(",")+"\n";
        });
        if (enc === "gbk") t = str2gbk(t);
        txt2file(t, "抖音作品数据", "csv");
    }

    function downloadUserData(node, enc) {
        if (window.user_map.size === 0) { toast("无作者数据"); return; }
        let t = "昵称,关注,粉丝,获赞,抖音号,IP,性别,位置,签名,作品数,记录时间,主页\n";
        Array.from(window.user_map.values()).sort((a,b)=>b.create_time-a.create_time).forEach(u=>{
            t+= [u.nickname,u.following_count,u.mplatform_followers_count,u.total_favorited,u.unique_id,u.ip_location,u.gender,u.city,`"${(u.signature||"").replace(/"/g,'""')}"`,u.aweme_count,timeFormat(u.create_time),"https://www.douyin.com/user/"+u.uid].join(",")+"\n";
        });
        if (enc === "gbk") t = str2gbk(t);
        txt2file(t, "抖音作者数据", "csv");
    }

    function setMaxAuthorNum() {
        let v = prompt("最大缓存作者数：", max_author_num);
        if (!v || !/^\d+$/.test(v)) { toast("请输入数字"); return; }
        max_author_num = parseInt(v); GM_setValue("max_author_num", max_author_num);
        toast("已设置：" + max_author_num);
    }

    function downloadVideo(aweme, node, isBatch = false) {
        let id = aweme.awemeId;
        if (downloadHistory.some(x => x.awemeId === id)) {
            toast("已下载"); node.textContent = "✅已下载"; node.style.color = "green";
            setTimeout(()=>{ node.textContent = isBatch?`下载${currentDownloadIndex+1}/${downloadQueue.length}`:"下载视频"; node.style.color=""; },2000);
            return;
        }
        const ext = aweme.images ? "mp3" : "mp4";
        downloadUrl(aweme.url, node, getAwemeName(aweme), ext, id, isBatch);
    }

    function downloadUrl(url, node, filename, ext, awemeId, isBatch = false) {
        if (downloadHistory.some(x => x.awemeId === awemeId)) {
            toast("已下载过，跳过");
            if(isBatch) {}
            return;
        }
        toast("开始下载");
        currentXHR = new XMLHttpRequest();
        currentXHR.open('GET', url.replace('http://','https://'), true);
        currentXHR.responseType = 'blob';
        let oldText = node.textContent;
        currentXHR.onload = () => {
            createDownloadLink(currentXHR.response, filename, ext, "", awemeId);
            node.textContent = oldText;
        };
        currentXHR.onerror = () => { toast("下载失败"); node.textContent = oldText; };
        currentXHR.send();
    }

    // ========== 修复：重置功能强制清除所有任务 ==========
    function resetDownloadQueue() {
        // 强制重置所有任务，无需先暂停
        forceResetAllTasks();
        toast("已重置所有任务");
        updatePauseResumeBtnText();
        updateTaskStatus();
        clearDetailPanel();
        // 额外确保失败统计UI也被清空
        if (failureStatsDiv) failureStatsDiv.innerHTML = "";
        lastFailureInfo = { successCount: 0, failCount: 0 };
    }

    // ========== 修复：暂停/继续逻辑，不再手动调度，依赖主流程的循环 ==========
    function togglePauseResume() {
        if (!isDownloadingBatch && !isPackaging) {
            toast("当前没有进行中的批量任务");
            return;
        }
        if (isBatchPaused) {
            isBatchPaused = false;
            GM_setValue("isPaused", false);
            toast("继续批量任务");
            if (isPackaging) {
                startPackaging();
            }
        } else {
            isBatchPaused = true;
            GM_setValue("isPaused", true);
            for (let [id, controller] of abortControllers.entries()) {
                controller.abort();
            }
            abortControllers.clear();
            toast("批量任务已暂停");
        }
        updateTaskStatus();
        updatePauseResumeBtnText();
        updateDetailPanel();
    }

    function resetAfterBatch() {
        downloadQueue = [];
        currentDownloadIndex = 0;
        isBatchPaused = false;
        downloadProgress = {};
        GM_setValue("downloadQueue", []);
        GM_setValue("currentDownloadIndex", 0);
        GM_setValue("isPaused", false);
        GM_setValue("downloadProgress", {});
        activeDownloads = 0;
        pendingWorks = [];
        successWorks = [];
        failedAwemeIds.clear();
        isDownloadingBatch = false;
        isPackaging = false;
        packagedProcessedFiles = 0;
        totalPackFiles = 0;
        currentPackagingIndex = 0;
        currentDownloadingFilename = "";
        updateTaskStatus();
        refreshBatchCount();
        clearDetailPanel();
    }

    // 创建工具箱（保持不变）
    function createToolBox() {
        let box = document.createElement('div');
        box.id = "dy-toolbox";
        box.style.cssText = `
            position:fixed;
            top:20px;
            left:50%;
            transform:translateX(-50%);
            width:260px;
            background:#1e293b;
            border-radius:12px;
            z-index:999999;
            color:#fff;
            box-shadow:0 8px 32px #0004;
            overflow:hidden;
            border:1px solid #334155;
            transition: width 0.3s;
        `;
        let head = document.createElement('div');
        head.style.cssText = "padding:10px 15px; display:flex; justify-content:space-between; align-items:center; background:#273444; border-bottom:1px solid #334155;";
        let titleSpan = document.createElement('span');
        titleSpan.textContent = "工具栏";
        titleSpan.style.fontWeight = "bold";
        titleSpan.style.whiteSpace = "nowrap";
        let toggleBtn = document.createElement('button');
        toggleBtn.textContent = "收起";
        toggleBtn.style.cssText = "background:#38bdf8; color:#fff; border:none; border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer; white-space:nowrap;";
        head.append(titleSpan, toggleBtn);
        box.appendChild(head);

        let body = document.createElement('div');
        body.style.padding = "12px";
        box.appendChild(body);

        let line1 = document.createElement('div'); line1.style.display = "flex"; line1.style.gap = "6px"; line1.style.marginBottom = "8px";
        let btnStyle = "flex:1; padding:8px 0; border-radius:8px; border:none; color:#fff; cursor:pointer; font-size:14px; font-weight:bold;";
        let selAll = document.createElement('button'); selAll.textContent = "全选"; selAll.style.cssText = btnStyle + "background:#10b981;"; selAll.onclick = selectAllCurrentUp;
        let cancel = document.createElement('button'); cancel.textContent = "取消"; cancel.style.cssText = btnStyle + "background:#64748b;"; cancel.onclick = cancelAllSelect;
        let reverse = document.createElement('button'); reverse.textContent = "反选"; reverse.style.cssText = btnStyle + "background:#8b5cf6;"; reverse.onclick = reverseSelect;
        line1.append(selAll, cancel, reverse);
        body.appendChild(line1);

        let dlBtn = document.createElement('button');
        dlBtn.style.cssText = "width:100%; padding:10px; background:#f97316; color:#fff; border:none; border-radius:8px; font-weight:bold; margin-bottom:8px;";
        dlBtn.textContent = `打包下载选中作品 [0]`;
        dlBtn.onclick = () => { startBatchDownload(); clearFailureStatsUI(); };
        window.dlBtn = dlBtn;
        body.appendChild(dlBtn);

        let line3 = document.createElement('div'); line3.style.display = "flex"; line3.style.gap = "6px"; line3.style.marginBottom = "8px";
        let mark = document.createElement('button'); mark.textContent = "✅ 标记下载"; mark.style.cssText = "flex:1; padding:8px; background:#10b981; color:#fff; border:none; border-radius:8px; font-weight:bold;"; mark.onclick = markAsDownloaded;
        let unmark = document.createElement('button'); unmark.textContent = "❌ 取消标记"; unmark.style.cssText = "flex:1; padding:8px; background:#ef4444; color:#fff; border:none; border-radius:8px; font-weight:bold;"; unmark.onclick = unmarkAsDownloaded;
        line3.append(mark, unmark);
        body.appendChild(line3);

        let taskEl = document.createElement('div');
        taskEl.style.cssText = "background:#273444; padding:8px; border-radius:8px; text-align:center; font-size:13px; margin-bottom:8px;";
        taskEl.textContent = "📥 任务状态：无任务";
        window.taskEl = taskEl;
        body.appendChild(taskEl);

        failureStatsDiv = document.createElement('div');
        failureStatsDiv.style.cssText = "background:#1e293b; padding:8px; border-radius:8px; text-align:center; font-size:12px; margin-bottom:8px; color:#cbd5e1; border:1px solid #334155; display:block;";
        body.appendChild(failureStatsDiv);

        let line5 = document.createElement('div'); line5.style.display = "flex"; line5.style.gap = "6px";
        let pauseResumeBtn = document.createElement('button'); pauseResumeBtn.textContent = "暂停/继续"; pauseResumeBtn.style.cssText = "flex:2; padding:8px 0; border-radius:8px; border:none; color:#fff; cursor:pointer; font-size:14px; font-weight:bold; background:#f59e0b;"; pauseResumeBtn.onclick = togglePauseResume; window.pauseResumeBtn = pauseResumeBtn;
        let resetBtn = document.createElement('button'); resetBtn.textContent = "重置"; resetBtn.style.cssText = "flex:1; padding:8px 0; border-radius:8px; border:none; color:#fff; cursor:pointer; font-size:14px; font-weight:bold; background:#dc2626;"; resetBtn.onclick = resetDownloadQueue;
        line5.append(pauseResumeBtn, resetBtn);
        body.appendChild(line5);

        document.body.appendChild(box);

        let isFold = false;
        toggleBtn.onclick = () => {
            isFold = !isFold;
            body.style.display = isFold ? "none" : "block";
            toggleBtn.textContent = isFold ? "展开" : "收起";
        };

        let dragging = false, startX, startY, startLeft, startTop;
        head.onmousedown = (e) => {
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = box.offsetLeft;
            startTop = box.offsetTop;
            box.style.transition = "none";
        };
        document.onmousemove = (e) => {
            if (!dragging) return;
            box.style.left = (startLeft + e.clientX - startX) + "px";
            box.style.top = (startTop + e.clientY - startY) + "px";
            box.style.right = "auto";
            box.style.transform = "none";
        };
        document.onmouseup = () => {
            if (dragging) box.style.transition = "all 0.2s";
            dragging = false;
        };
        bindClearFailureOnButtons(body);
    }

    // 数据拦截（保持不变）
    function interceptResponse() {
        let send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
            send.apply(this, arguments);
            if (!this._url) return;
            let p = new URL(this._url).pathname;
            if (!p.startsWith("/aweme/v1/web/")) return;
            this.onreadystatechange = function () {
                if (this.readyState === 4) {
                    try {
                        let d = JSON.parse(this.response);
                        if (p.startsWith("/aweme/v1/web/user/profile/other")) {
                            let u = d.user;
                            let user = { uid: u.uid, nickname: u.nickname, following_count: u.following_count, mplatform_followers_count: u.mplatform_followers_count, total_favorited: u.total_favorited, unique_id: u.unique_id || u.short_id, ip_location: (u.ip_location || "").replace("IP属地：", ""), gender: u.gender ? "男女"[u.gender-1] || "" : "", city: [u.province, u.city, u.district].filter(x=>x).join("·"), signature: u.signature, aweme_count: u.aweme_count, create_time: Date.now() };
                            user_map.set(user.uid, user);
                            current_user_id = user.uid;
                            localStorage.setItem('user_local_data', JSON.stringify(Array.from(user_map.values()).sort((a,b)=>b.create_time-a.create_time).slice(0, max_author_num)));
                        } else {
                            let list = [];
                            if (d.aweme_list) list = d.aweme_list;
                            else if (d.data && d.data.length) list = d.data.map(x => x.aweme || x.aweme_info).filter(x=>x);
                            if (list.length) {
                                list.forEach(item => {
                                    let a = { awemeId: item.aweme_id, item_title: item.item_title, caption: item.caption, desc: item.desc, date: timeFormat(item.create_time), create_time: item.create_time, diggCount: item.statistics?.digg_count || 0, commentCount: item.statistics?.comment_count || 0, collectCount: item.statistics?.collect_count || 0, shareCount: item.statistics?.share_count || 0, duration: formatSeconds(Math.round((item.video?.duration || 0)/1000)), url: item.video?.play_addr?.url_list[0] || "", cover: item.video?.cover?.url_list[0] || "", images: item.images?.map(x=>x.url_list.pop()) || null, uid: item.author?.uid, nickname: item.author?.nickname, tag: item.text_extra?.map(x=>x.hashtag_name).filter(x=>x).join("#") || "", video_tag: item.video_tag?.map(x=>x.tag_name).join("->") || "" };
                                    if (a.url && a.awemeId) window.all_aweme_map.set(a.awemeId, a);
                                });
                                refreshAllDownloadStatus();
                            }
                        }
                    } catch(e) { console.error("数据解析失败", e); }
                }
            };
        };
    }

    let msg_pre;
    function createMsgBox() {
        msg_pre = document.createElement('pre');
        msg_pre.textContent = '加载中...';
        msg_pre.style.cssText = 'position:fixed;right:5px;top:60px;color:white;z-index:503;opacity:0.4;';
        document.body.appendChild(msg_pre);
    }

    window.addEventListener('load', () => {
        interceptResponse();
        createMsgBox();
        createToolBox();
        new MutationObserver((ms) => {
            ms.forEach(m => m.addedNodes.forEach(n => {
                if (n.tagName === "A" && (n.href.includes("/video/") || n.href.includes("/note/"))) createButtonGroup(n);
                else if (n.querySelectorAll) n.querySelectorAll('a[href*="/video/"],a[href*="/note/"]').forEach(createButtonGroup);
            }));
        }).observe(document.body, { childList: true, subtree: true });
        setTimeout(refreshAllDownloadStatus, 1000);
    });
})();