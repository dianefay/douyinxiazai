// ==UserScript==
// @name         抖音下载工具-豆包版Pro 测试版
// @namespace    http://tampermonkey.net/
// @version      2.0.5
// @description  下载抖音用户主页数据! 浮动UI工具箱+多视频批量打包下载+最高清选择+下载历史+任务管理（修复图文批量下载+恢复打包功能）
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
    // 新增：批量打包相关全局变量
    let batchDownloadBlobs = []; // 存储批量下载的视频Blob和文件名
    let isPackaging = false;     // 是否正在打包

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

    // ========== 油猴菜单命令（精简：仅保留UTF8）==========
    GM_registerMenuCommand("🔍 查看下载历史", showDownloadHistory);
    GM_registerMenuCommand("🗑️ 清空下载历史", clearDownloadHistory);
    GM_registerMenuCommand("📊 下载作品数据(UTF8)", () => downloadData(null));
    GM_registerMenuCommand("🔄 清空信息内容", () => msg_pre.textContent = "");
    GM_registerMenuCommand("👤 设置最大缓存作者数", setMaxAuthorNum);

    // ========== 工具函数 ==========
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

    // 视频右上角按钮样式（恢复带框、灰色背景、分隔、粗体）
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

    // ========== 自动标记已下载（核心修复）==========
    function addToDownloadHistory(awemeId, nickname, filename) {
        downloadHistory = downloadHistory.filter(item => item.awemeId !== awemeId);
        downloadHistory.push({
            awemeId: awemeId,
            nickname: nickname || "未知作者",
            filename: filename
        });
        GM_setValue("downloadHistory", downloadHistory);
        refreshAllDownloadStatus(); // 修复：标记后立即刷新状态
    }

    function createDownloadLink(blob, filename, ext, prefix, awemeId) {
        if (!prefix) prefix = "";
        let fname = prefix + filename.replace(/[\\/:*?"<>|\s]/g, "").slice(0, 40) + "." + ext;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        a.click();
        URL.revokeObjectURL(a.href);

        if (awemeId) {
            let aweme = window.all_aweme_map.get(awemeId);
            let nickname = aweme ? aweme.nickname : "未知作者";
            addToDownloadHistory(awemeId, nickname, fname.replace(prefix, "")); // 核心：下载完成后自动标记
        }
    }

    function txt2file(txt, filename, ext) {
        createDownloadLink(new Blob([txt], { type: 'text/plain' }), filename, ext);
    }

    function getAwemeName(aweme) {
        let name = aweme.item_title || aweme.caption || aweme.desc || aweme.awemeId;
        return (aweme.date ? `【${aweme.date.slice(0, 10)}】` : "") + name.replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 27);
    }

    // ========== 改造：下载视频/图文到Blob（区分类型）==========
    async function downloadVideoToBlob(aweme) {
        // 如果是图文作品（有images字段），返回所有图片的Blob数组
        if (aweme.images && aweme.images.length > 0) {
            const imageBlobs = [];
            toast(`开始下载图文作品${aweme.awemeId}的${aweme.images.length}张图片`);
            for (let i = 0; i < aweme.images.length; i++) {
                try {
                    const imgUrl = aweme.images[i].replace('http://', 'https://');
                    const response = await fetch(imgUrl);
                    if (!response.ok) throw new Error(`图片${i+1}下载失败：${response.status}`);
                    const blob = await response.blob();
                    imageBlobs.push({
                        blob,
                        filename: `${getAwemeName(aweme)}_${i + 1}.jpg` // 图片命名：作品名_序号.jpg
                    });
                    console.log(`✅ 图文${aweme.awemeId}的第${i+1}张图片下载成功`);
                } catch (e) {
                    toast(`图文${aweme.awemeId}的第${i + 1}张图片下载失败，跳过: ${e.message}`);
                    console.error(`❌ 图文${aweme.awemeId}的第${i+1}张图片下载失败`, e);
                }
            }
            return { type: "image", blobs: imageBlobs }; // 标记为图片类型
        }
        // 视频作品，返回单个视频Blob
        else {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', aweme.url.replace('http://', 'https://'), true);
                xhr.responseType = 'blob';

                xhr.onload = () => {
                    if (xhr.status === 200) {
                        console.log(`✅ 视频${aweme.awemeId}下载成功`);
                        resolve({
                            type: "video",
                            blob: xhr.response,
                            filename: getAwemeName(aweme) + ".mp4" // 视频命名：作品名.mp4
                        });
                    } else {
                        reject(new Error(`视频下载失败：${xhr.status}`));
                    }
                };

                xhr.onerror = () => reject(new Error("网络错误"));
                xhr.send();
            });
        }
    }

    // ========== 新增：打包所有视频为ZIP ==========
    async function packageVideos() {
        const zip = new JSZip();
        const total = batchDownloadBlobs.length;

        toast(`开始打包${total}个文件（视频+图片）`);
        // 遍历添加视频/图片到ZIP
        for (let i = 0; i < total; i++) {
            if (isBatchPaused) break; // 暂停则终止打包
            const { blob, filename, awemeId } = batchDownloadBlobs[i];
            zip.file(filename, blob);
            // 更新打包进度
            currentDownloadIndex = i + 1;
            updateTaskStatus();
            console.log(`📦 已添加${filename}到压缩包 (${i+1}/${total})`);
        }

        if (isBatchPaused) {
            toast("打包已暂停");
            return;
        }

        // 生成ZIP Blob并触发下载
        const zipFilename = `抖音批量下载_${timeFormat(null, 'yyyyMMddHHmmss')}.zip`;
        toast(`正在生成压缩包：${zipFilename}`);
        const zipBlob = await zip.generateAsync({ type: "blob" });
        createDownloadLink(zipBlob, zipFilename, "zip", "", "batch_" + Date.now());

        // 批量标记已下载
        batchDownloadBlobs.forEach(item => {
            addToDownloadHistory(item.awemeId, item.nickname, item.filename);
        });
        console.log(`✅ 压缩包生成完成，共${batchDownloadBlobs.length}个文件`);
        toast(`打包完成！共${batchDownloadBlobs.length}个文件，文件名：${zipFilename}`);
    }

    // ========== 下载核心 ==========
    const downloadUrl = (url, node, filename, ext, awemeId, isBatch = false) => {
        if (downloadHistory.some(x => x.awemeId === awemeId)) {
            toast("已下载过，跳过");
            node.textContent = "✅已下载"; node.style.color = "green";
            setTimeout(() => { node.textContent = isBatch ? `下载${currentDownloadIndex + 1}/${downloadQueue.length}` : "下载视频"; node.style.color = ""; }, 2000);

            // 修复：已下载的视频也要推进队列，避免卡死
            if (isBatch) {
                currentDownloadIndex++;
                GM_setValue("currentDownloadIndex", currentDownloadIndex);
                updateTaskStatus();
                if (currentDownloadIndex < downloadQueue.length && !isBatchPaused) setTimeout(downloadNextInQueue, 500);
                else if (currentDownloadIndex >= downloadQueue.length) { toast("全部下载完成"); resetDownloadQueue(); }
            }
            return;
        }
        if (isBatch && isBatchPaused) {
            toast("批量任务已暂停"); return;
        }
        toast("开始下载");
        currentXHR = new XMLHttpRequest();
        currentXHR.open('GET', url.replace('http://', 'https://'), true);
        currentXHR.responseType = 'blob';
        let oldText = node.textContent;

        currentXHR.onprogress = (e) => {
            if (e.lengthComputable) {
                let p = (e.loaded * 100 / e.total).toFixed(1);
                downloadProgress[awemeId] = p;
                GM_setValue("downloadProgress", downloadProgress);
                node.textContent = `下载${p}%`;
                updateTaskStatus();
            }
        };

        currentXHR.onload = () => {
            createDownloadLink(currentXHR.response, filename, ext, "", awemeId);
            delete downloadProgress[awemeId];
            GM_setValue("downloadProgress", downloadProgress);
            node.textContent = oldText;

            // 修复：批量下载时推进队列
            if (isBatch) {
                currentDownloadIndex++;
                GM_setValue("currentDownloadIndex", currentDownloadIndex);
                updateTaskStatus();
                if (currentDownloadIndex < downloadQueue.length && !isBatchPaused) setTimeout(downloadNextInQueue, 500);
                else if (currentDownloadIndex >= downloadQueue.length) { toast("全部下载完成"); resetDownloadQueue(); }
            }
        };

        currentXHR.onerror = () => {
            toast("下载失败");
            node.textContent = oldText;
            // 修复：失败也推进队列，避免卡死
            if (isBatch) {
                currentDownloadIndex++;
                GM_setValue("currentDownloadIndex", currentDownloadIndex);
                if (currentDownloadIndex < downloadQueue.length && !isBatchPaused) setTimeout(downloadNextInQueue, 500);
            }
        };

        currentXHR.onabort = () => {
            toast(isBatch ? "批量任务已暂停" : "下载已暂停");
            node.textContent = isBatch ? `下载${currentDownloadIndex + 1}/${downloadQueue.length}` : "下载视频";
        };
        currentXHR.send();
    };

    const downloadVideo = (aweme, node, isBatch = false) => {
        let id = aweme.awemeId;
        if (downloadHistory.some(x => x.awemeId === id)) {
            toast("已下载");
            node.textContent = "✅已下载"; node.style.color = "green";
            setTimeout(() => { node.textContent = isBatch ? `下载${currentDownloadIndex + 1}/${downloadQueue.length}` : "下载视频"; node.style.color = ""; }, 2000);

            // 修复：批量场景下已下载也推进队列
            if (isBatch) {
                currentDownloadIndex++;
                GM_setValue("currentDownloadIndex", currentDownloadIndex);
                updateTaskStatus();
                if (currentDownloadIndex < downloadQueue.length && !isBatchPaused) setTimeout(downloadNextInQueue, 500);
                else if (currentDownloadIndex >= downloadQueue.length) { toast("全部下载完成"); resetDownloadQueue(); }
            }
            return;
        }
        // 修复：图文作品不再下载为mp3
        const ext = aweme.images ? (isBatch ? "jpg" : "mp3") : "mp4";
        downloadUrl(aweme.url, node, getAwemeName(aweme), ext, id, isBatch);
    };

    // ========== 任务管理 ==========
    function initDownloadQueue() {
        downloadQueue = Array.from(window.batchDownloadVideoIds);
        currentDownloadIndex = 0;
        isBatchPaused = false;
        downloadProgress = {};
        batchDownloadBlobs = []; // 清空打包缓存
        isPackaging = false;     // 重置打包状态
        GM_setValue("downloadQueue", downloadQueue);
        GM_setValue("currentDownloadIndex", 0);
        GM_setValue("isPaused", false);
        GM_setValue("downloadProgress", {});
        updateTaskStatus();
    }

    function downloadNextInQueue() {
        if (isBatchPaused || currentDownloadIndex >= downloadQueue.length) return;
        let id = downloadQueue[currentDownloadIndex];
        let aweme = window.all_aweme_map.get(id);
        if (!aweme) {
            currentDownloadIndex++;
            GM_setValue("currentDownloadIndex", currentDownloadIndex);
            downloadNextInQueue();
            return;
        }
        let node = { textContent: `下载${currentDownloadIndex + 1}/${downloadQueue.length}`, style: {} };
        downloadVideo(aweme, node, true);
    }

    // 新增：合并暂停/继续功能
    function togglePauseResume() {
        // 仅在有下载任务时生效
        if (downloadQueue.length === 0) {
            toast("暂无下载任务");
            return;
        }

        if (isBatchPaused) {
            // 继续任务
            isBatchPaused = false;
            GM_setValue("isPaused", false);
            toast("继续批量下载");
            if (isPackaging) {
                packageVideos(); // 继续打包
            } else {
                downloadNextInQueue();
            }
        } else {
            // 暂停任务
            isBatchPaused = true;
            GM_setValue("isPaused", true);
            if (currentXHR) {
                currentXHR.abort();
                currentXHR = null;
            }
            toast("批量任务已暂停");
        }
        updateTaskStatus();
        // 更新暂停/继续按钮文字
        updatePauseResumeBtnText();
    }

    function resetDownloadQueue() {
        downloadQueue = [];
        currentDownloadIndex = 0;
        isBatchPaused = false;
        downloadProgress = {};
        batchDownloadBlobs = [];
        isPackaging = false;
        GM_setValue("downloadQueue", []);
        GM_setValue("currentDownloadIndex", 0);
        GM_setValue("isPaused", false);
        GM_setValue("downloadProgress", {});
        currentXHR = null;
        toast("队列已重置");
        updateTaskStatus();
        // 更新按钮文字
        updatePauseResumeBtnText();
    }

    // ========== 改造：任务状态（新增打包状态）==========
    function updateTaskStatus() {
        if (window.taskEl) {
            let s = "📥 任务状态：";
            if (isPackaging) {
                // 打包状态 - 分母使用总任务数
    s += `▶️ 正在下载作品：${currentDownloadIndex}/${downloadQueue.length}`;
} else if (downloadQueue.length === 0) {
                s += "无任务";
            } else {
                // 下载状态
                s += isBatchPaused ? "⏸️已暂停" : "▶️下载中";
                s += ` | ${currentDownloadIndex + 1}/${downloadQueue.length}`;
                let cid = downloadQueue[currentDownloadIndex];
                if (cid && downloadProgress[cid]) s += ` | ${downloadProgress[cid]}%`;
            }
            window.taskEl.textContent = s;
        }
        // 刷新已选数量显示（更新到下载按钮）
        refreshBatchCount();
    }

    // ========== 下载状态 ==========
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

    // 修改：标记已下载 → 标记下载
    function markAsDownloaded() {
        let ids = Array.from(window.batchDownloadVideoIds);
        if (ids.length === 0) { toast("未选择"); return; }
        ids.forEach(id => {
            let a = window.all_aweme_map.get(id);
            if (a) {
                addToDownloadHistory(id, a.nickname || "未知", getAwemeName(a) + (a.images ? "_1.jpg" : ".mp4"));
            }
        });
        toast(`已标记 ${ids.length} 个`);
        refreshAllDownloadStatus();
    }

    function unmarkAsDownloaded() {
        let ids = Array.from(window.batchDownloadVideoIds);
        if (ids.length === 0) { toast("未选择"); return; }
        downloadHistory = downloadHistory.filter(x => !ids.includes(x.awemeId));
        GM_setValue("downloadHistory", downloadHistory);
        toast(`已取消标记`);
        refreshAllDownloadStatus();
    }

    // ========== 下载历史（表格 + ESC关闭 + 一键复制）==========
    function showDownloadHistory() {
        if (downloadHistory.length === 0) { toast("无记录"); return; }
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
        </div>`;

        html += `<table style='width:100%;border-collapse:collapse;margin-top:10px;'>
            <tr style='background:#334155;text-align:left'>
                <th style='padding:10px;border:1px solid #475569'>UP主昵称</th>
                <th style='padding:10px;border:1px solid #475569'>作品ID</th>
                <th style='padding:10px;border:1px solid #475569'>文件名</th>
            </tr>`;

        let allText = "下载历史：\n";
        downloadHistory.forEach((item, i) => {
            html += `<tr style='border-bottom:1px solid #475569'>
                <td style='padding:10px;border:1px solid #475569'>${item.nickname}</td>
                <td style='padding:10px;border:1px solid #475569'>${item.awemeId}</td>
                <td style='padding:10px;border:1px solid #475569'>${item.filename}</td>
            </tr>`;
            allText += `【${i + 1}】${item.nickname} | ${item.awemeId} | ${item.filename}\n`;
        });
        html += "</table>";

        copyBtn.onclick = () => copyText(allText);
        box.innerHTML = html;
        box.prepend(copyBtn);
        document.body.appendChild(box);

        const close = () => document.body.removeChild(box);
        box.onclick = (e) => { if (e.target === box) close(); };
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
    }

    function clearDownloadHistory() {
        if (!confirm("确定清空？")) return;
        downloadHistory = []; GM_setValue("downloadHistory", []);
        toast("已清空"); refreshAllDownloadStatus();
    }

    // ========== 批量选择（更新refreshBatchCount函数）==========
    function refreshBatchCount() {
        // 更新打包下载按钮文字，包含已选数量
        if (window.dlBtn) {
            window.dlBtn.textContent = `打包下载选中作品 [${window.batchDownloadVideoIds.size}]`;
        }
        // 更新暂停/继续按钮文字
        updatePauseResumeBtnText();
    }

    // 新增：更新暂停/继续按钮文字
    function updatePauseResumeBtnText() {
        if (window.pauseResumeBtn) {
            if (downloadQueue.length === 0) {
                window.pauseResumeBtn.textContent = "暂停/继续";
                window.pauseResumeBtn.style.opacity = "0.7";
            } else {
                window.pauseResumeBtn.textContent = isBatchPaused ? "继续" : "暂停";
                window.pauseResumeBtn.style.opacity = "1";
            }
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
    }

    function cancelAllSelect() {
        window.batchDownloadVideoIds.clear();
        document.querySelectorAll('[data-vid]').forEach(n => {
            let b = Array.from(n.children).find(x => x.textContent.includes("选择"));
            if (b) { b.textContent = "❌未选择"; b.style.background = ""; b.style.color = ""; }
        });
        toast("已取消全部");
        refreshBatchCount();
    }

    function selectAllCurrentUp() {
        if (!current_user_id) { toast("请先进入作者主页"); return; }
        let list = Array.from(window.all_aweme_map.values()).filter(x => x.uid === current_user_id).map(x => x.awemeId);
        if (list.length === 0) { toast("无作品"); return; }
        list.forEach(id => window.batchDownloadVideoIds.add(id));
        document.querySelectorAll('[data-vid]').forEach(n => {
            let b = Array.from(n.children).find(x => x.textContent.includes("选择"));
            if (b && list.includes(n.dataset.vid)) {
                b.textContent = "✅已选择"; b.style.background = "#ff4444"; b.style.color = "#fff";
            }
        });
        toast(`已全选 ${list.length} 个`);
        refreshBatchCount();
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
    }

    // ========== 图文下载 ==========
    function downloadImage(aweme, btn) {
        if (downloadHistory.some(x => x.awemeId === aweme.awemeId)) {
            toast("已下载"); btn.textContent = "✅已下载"; btn.style.color = "green";
            setTimeout(() => { btn.textContent = "图片打包"; btn.style.color = ""; }, 2000);
            return;
        }
        let zip = new JSZip();
        let old = btn.textContent;
        btn.textContent = "打包中...";
        Promise.all(aweme.images.map((u, i) =>
            fetch(u).then(r => r.arrayBuffer()).then(b => zip.file(`img${i + 1}.jpg`, b))
        )).then(() => zip.generateAsync({ type: "blob" })).then(b => {
            createDownloadLink(b, getAwemeName(aweme), "zip", "【图文】", aweme.awemeId);
            btn.textContent = old;
        });
    }

    // ========== 视频右上角按钮组 ==========
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
        statBtn.dataset.t = "ds";
        statBtn.style.pointerEvents = "none";
        updateDownloadStatusBtn(statBtn, vid);
        aNode.appendChild(statBtn);

        if (aweme.images) {
            let imgBtn = createVideoButton("图片打包", "84px", () => downloadImage(aweme, imgBtn));
            aNode.appendChild(imgBtn);
        }

        aNode.dataset.vid = vid;
    }

    // ========== 数据导出 ==========
    function downloadData(node, enc) {
        if (window.all_aweme_map.size === 0) { alert("无作品数据"); return; }
        let t = "作者昵称,作品描述,作品链接,点赞,评论,收藏,分享,发布时间,时长,标签,分类,封面,下载链接\n";
        Array.from(window.all_aweme_map.values()).sort((a, b) => b.create_time - a.create_time).forEach(a => {
            t += [a.nickname, `"${(a.desc || "").replace(/"/g, '""')}"`,
                "https://www.douyin.com/video/" + a.awemeId,
                a.diggCount, a.commentCount, a.collectCount, a.shareCount,
                a.date, a.duration, a.tag, a.video_tag, a.cover, `"${a.url}"`].join(",") + "\n";
        });
        if (enc === "gbk") t = str2gbk(t);
        txt2file(t, "抖音作品数据", "csv");
    }

    function downloadUserData(node, enc) {
        if (window.user_map.size === 0) { toast("无作者数据"); return; }
        let t = "昵称,关注,粉丝,获赞,抖音号,IP,性别,位置,签名,作品数,记录时间,主页\n";
        Array.from(window.user_map.values()).sort((a, b) => b.create_time - a.create_time).forEach(u => {
            t += [u.nickname, u.following_count, u.mplatform_followers_count, u.total_favorited,
                u.unique_id, u.ip_location, u.gender, u.city, `"${(u.signature || "").replace(/"/g, '""')}"`,
                u.aweme_count, timeFormat(u.create_time), "https://www.douyin.com/user/" + u.uid].join(",") + "\n";
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

    // ========== 浮动UI（核心修改）==========
    function createToolBox() {
        let box = document.createElement('div');
        box.id = "dy-toolbox";
        box.style.cssText = `
            position:fixed; right:20px; top:100px; width:260px;
            background:#1e293b; border-radius:12px; z-index:999999;
            color:#fff; box-shadow:0 8px 32px #0004;
            cursor:move; overflow:hidden; border:1px solid #334155;
        `;

        let head = document.createElement('div');
        head.style.cssText = "padding:10px 15px; display:flex; justify-content:space-between; align-items:center; background:#273444; border-bottom:1px solid #334155;";
        let title = document.createElement('span');
        title.textContent = "工具箱";
        title.style.fontWeight = "bold";
        let toggle = document.createElement('button');
        toggle.textContent = "收起";
        toggle.style.cssText = "background:#38bdf8; color:#fff; border:none; border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer;";
        head.append(title, toggle);
        box.appendChild(head);

        let body = document.createElement('div');
        body.style.padding = "12px";
        box.appendChild(body);

        let line1 = document.createElement('div');
        line1.style.display = "flex";
        line1.style.gap = "6px";
        line1.style.marginBottom = "8px";
        let btnStyle = "flex:1; padding:8px 0; border-radius:8px; border:none; color:#fff; cursor:pointer; font-size:14px; font-weight:bold;";

        let selAll = document.createElement('button');
        selAll.textContent = "全选";
        selAll.style.cssText = btnStyle + "background:#10b981;";
        selAll.onclick = selectAllCurrentUp;

        let cancel = document.createElement('button');
        cancel.textContent = "取消";
        cancel.style.cssText = btnStyle + "background:#64748b;";
        cancel.onclick = cancelAllSelect;

        let reverse = document.createElement('button');
        reverse.textContent = "反选";
        reverse.style.cssText = btnStyle + "background:#8b5cf6;";
        reverse.onclick = reverseSelect;
        line1.append(selAll, cancel, reverse);
        body.appendChild(line1);

        // 打包下载按钮（包含已选数量）- 核心修复：恢复压缩下载逻辑
        let dlBtn = document.createElement('button');
        dlBtn.style.cssText = "width:100%; padding:10px; background:#f97316; color:#fff; border:none; border-radius:8px; font-weight:bold; margin-bottom:8px;";
        dlBtn.textContent = `打包下载选中作品 [${window.batchDownloadVideoIds.size}]`;
        dlBtn.onclick = async () => {
            // 初始化下载队列
            initDownloadQueue();
            if (downloadQueue.length === 0) {
                toast("请先选择要下载的作品");
                return;
            }

            isPackaging = true; // 标记为打包状态
            batchDownloadBlobs = []; // 清空旧的Blob缓存
            toast(`开始批量下载${downloadQueue.length}个作品，完成后自动打包`);

            // 遍历所有选中的作品，下载为Blob并收集
            for (let i = 0; i < downloadQueue.length; i++) {
                if (isBatchPaused) break; // 暂停则终止下载

                const id = downloadQueue[i];
                const aweme = window.all_aweme_map.get(id);
                if (!aweme) {
                    toast(`作品${id}数据不存在，跳过`);
                    currentDownloadIndex++;
                    GM_setValue("currentDownloadIndex", currentDownloadIndex);
                    updateTaskStatus();
                    continue;
                }

                try {
                    // 下载视频/图文到Blob
                    const downloadResult = await downloadVideoToBlob(aweme);

                    if (downloadResult.type === "video") {
                        // 视频作品：添加单个Blob
                        batchDownloadBlobs.push({
                            blob: downloadResult.blob,
                            filename: downloadResult.filename,
                            awemeId: id,
                            nickname: aweme.nickname || "未知作者"
                        });
                    } else if (downloadResult.type === "image") {
                        // 图文作品：添加所有图片Blob
                        downloadResult.blobs.forEach(img => {
                            batchDownloadBlobs.push({
                                blob: img.blob,
                                filename: img.filename,
                                awemeId: id,
                                nickname: aweme.nickname || "未知作者"
                            });
                        });
                    }

                    // 更新进度
                    currentDownloadIndex = i + 1;
                    GM_setValue("currentDownloadIndex", currentDownloadIndex);
                    updateTaskStatus();
                    console.log(`✅ 已下载作品${id} (${i+1}/${downloadQueue.length})`);
                } catch (e) {
                    toast(`作品${id}下载失败：${e.message}，跳过`);
                    console.error(`❌ 作品${id}下载失败`, e);
                    // 失败也推进进度，避免卡死
                    currentDownloadIndex++;
                    GM_setValue("currentDownloadIndex", currentDownloadIndex);
                    updateTaskStatus();
                }
            }

            // 如果未暂停，执行打包
            if (!isBatchPaused && batchDownloadBlobs.length > 0) {
                await packageVideos();
            } else if (isBatchPaused) {
                toast("批量下载已暂停，未执行打包");
            } else {
                toast("无有效作品可打包");
            }

            // 重置打包状态
            isPackaging = false;
            resetDownloadQueue(); // 打包完成后重置队列
        };
        window.dlBtn = dlBtn; // 挂载到全局，用于更新数量显示
        body.appendChild(dlBtn);

        let line3 = document.createElement('div');
        line3.style.display = "flex";
        line3.style.gap = "6px";
        line3.style.marginBottom = "8px";
        // 修改：标记已下载 → 标记下载
        let mark = document.createElement('button');
        mark.textContent = "✅ 标记下载";
        mark.style.cssText = "flex:1; padding:8px; background:#10b981; color:#fff; border:none; border-radius:8px; font-weight:bold;";
        mark.onclick = markAsDownloaded;
        let unmark = document.createElement('button');
        unmark.textContent = "❌ 取消标记";
        unmark.style.cssText = "flex:1; padding:8px; background:#ef4444; color:#fff; border:none; border-radius:8px; font-weight:bold;";
        unmark.onclick = unmarkAsDownloaded;
        line3.append(mark, unmark);
        body.appendChild(line3);

        let taskEl = document.createElement('div');
        taskEl.style.cssText = "background:#273444; padding:8px; border-radius:8px; text-align:center; font-size:13px; margin-bottom:8px;";
        taskEl.textContent = "📥 任务状态：无任务";
        window.taskEl = taskEl;
        body.appendChild(taskEl);

        // 修改：最后一行改为 暂停/继续 + 重置 两个按钮
        let line5 = document.createElement('div');
        line5.style.display = "flex";
        line5.style.gap = "6px";

        // 暂停/继续合并按钮
        let pauseResumeBtn = document.createElement('button');
        pauseResumeBtn.textContent = "暂停/继续";
        pauseResumeBtn.style.cssText = "flex:2; padding:8px 0; border-radius:8px; border:none; color:#fff; cursor:pointer; font-size:14px; font-weight:bold; background:#f59e0b;";
        pauseResumeBtn.onclick = togglePauseResume;
        window.pauseResumeBtn = pauseResumeBtn;

        let resetBtn = document.createElement('button');
        resetBtn.textContent = "重置";
        resetBtn.style.cssText = "flex:1; padding:8px 0; border-radius:8px; border:none; color:#fff; cursor:pointer; font-size:14px; font-weight:bold; background:#dc2626;";
        resetBtn.onclick = resetDownloadQueue;

        line5.append(pauseResumeBtn, resetBtn);
        body.appendChild(line5);

        document.body.appendChild(box);

        let fold = false;
        toggle.onclick = () => {
            fold = !fold;
            body.style.display = fold ? "none" : "block";
            toggle.textContent = fold ? "展开" : "收起";
            box.style.width = fold ? "100px" : "260px";
        };

        let drag = false, ox, oy;
        head.onmousedown = e => { drag = true; let r = box.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; box.style.transition = "none"; };
        document.onmousemove = e => { if (!drag) return; box.style.left = e.clientX - ox + "px"; box.style.top = e.clientY - oy + "px"; box.style.right = "auto"; };
        document.onmouseup = () => { drag = false; box.style.transition = "all 0.2s"; };
    }

    // ========== 数据拦截 ==========
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
                            let user = {
                                uid: u.uid, nickname: u.nickname, following_count: u.following_count,
                                mplatform_followers_count: u.mplatform_followers_count, total_favorited: u.total_favorited,
                                unique_id: u.unique_id || u.short_id, ip_location: (u.ip_location || "").replace("IP属地：", ""),
                                gender: u.gender ? "男女"[u.gender - 1] || "" : "", city: [u.province, u.city, u.district].filter(x => x).join("·"),
                                signature: u.signature, aweme_count: u.aweme_count, create_time: Date.now()
                            };
                            user_map.set(user.uid, user);
                            current_user_id = user.uid;
                            localStorage.setItem('user_local_data', JSON.stringify(Array.from(user_map.values()).sort((a, b) => b.create_time - a.create_time).slice(0, max_author_num)));
                        } else {
                            let list = [];
                            if (d.aweme_list) list = d.aweme_list;
                            else if (d.data && d.data.length) list = d.data.map(x => x.aweme || x.aweme_info).filter(x => x);
                            if (list.length) {
                                list.forEach(item => {
                                    let a = {
                                        awemeId: item.aweme_id, item_title: item.item_title, caption: item.caption, desc: item.desc,
                                        date: timeFormat(item.create_time), create_time: item.create_time,
                                        diggCount: item.statistics?.digg_count || 0, commentCount: item.statistics?.comment_count || 0,
                                        collectCount: item.statistics?.collect_count || 0, shareCount: item.statistics?.share_count || 0,
                                        duration: formatSeconds(Math.round((item.video?.duration || 0) / 1000)),
                                        url: item.video?.play_addr?.url_list[0] || "", cover: item.video?.cover?.url_list[0] || "",
                                        images: item.images?.map(x => x.url_list.pop()) || null,
                                        uid: item.author?.uid, nickname: item.author?.nickname,
                                        tag: item.text_extra?.map(x => x.hashtag_name).filter(x => x).join("#") || "",
                                        video_tag: item.video_tag?.map(x => x.tag_name).join("->") || ""
                                    };
                                    if (a.url && a.awemeId) window.all_aweme_map.set(a.awemeId, a);
                                });
                                refreshAllDownloadStatus();
                            }
                        }
                    } catch (e) {
                        console.error("数据解析失败", e);
                    }
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

    // ========== 启动 ==========
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
        toast("抖音下载工具已加载完成（图文修复+打包恢复版）");
    });
})();