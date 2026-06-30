/**
 * ai_bridge.js — Echo Yonder Web AI Bridge
 *
 * 此文件在 Ren'Py Web 包的 index.html 中通过 <script> 标签引入。
 * Ren'Py 通过 renpy.emscripten.run_script / run_script_string 与此文件通信。
 *
 * 状态约定：
 *   idle    — 尚未请求（初始状态 / 重置后）
 *   loading — 正在请求后端
 *   done    — 请求成功，结果在 window.ai_result
 *   error   — 请求失败，错误信息在 window.ai_error
 */

(function () {
    "use strict";

    // ── 全局状态变量（供 Ren'Py 通过 run_script_string 轮询） ──────────────
    window.ai_status = "idle";
    window.ai_result = "";
    window.ai_error  = "";
    // 每次开始或重置请求都会递增。旧请求即使稍后返回，也无权覆盖新请求状态。
    window._ai_request_id = 0;

    // ── 后端地址（优先读取 Ren'Py 注入的全局变量，否则使用默认值） ──────────
    // Ren'Py 侧可在调用前执行:
    //   renpy.emscripten.run_script("window.AI_PROXY_BASE_URL='https://...'")
    function getBackendUrl() {
        var base = (window.AI_PROXY_BASE_URL || "https://echo-yonder.onrender.com").replace(/\/$/, "");
        return base + "/api/chat";
    }

    /**
     * 重置状态机到初始状态。
     * 每次新请求前由 Ren'Py 调用（或由 start_ai_request 自动调用）。
     */
    window.reset_ai_status = function () {
        window._ai_request_id += 1;
        window.ai_status = "idle";
        window.ai_result = "";
        window.ai_error  = "";
    };

    // ── 调试日志工具 ─────────────────────────────────────────────────────────
    window._ai_debug_logs = [];
    function debugLog(msg) {
        var line = "[ai_bridge] " + msg;
        console.log(line);
        window._ai_debug_logs.push(line);
        if (window._ai_debug_logs.length > 50) {
            window._ai_debug_logs.shift();
        }
    }

    /**
     * 发起 AI 对话请求。
     *
     * @param {string}  userQuestion   玩家输入内容
     * @param {string}  characterName  对话角色名（对应后端 prompts.json 中的 key）
     * @param {string}  memoryContext  记忆上下文（可为空字符串）
     * @param {boolean} isJson         是否要求后端返回 JSON 格式
     */
    window.start_ai_request = function (userQuestion, characterName, memoryContext, isJson) {
        var requestId = window._ai_request_id + 1;
        window._ai_request_id = requestId;

        // 重置状态
        window.ai_status = "loading";
        window.ai_result = "";
        window.ai_error  = "";

        var url = getBackendUrl();
        debugLog("发起请求 → " + url + "  角色=" + characterName + " isjson=" + isJson);

        var payload = {
            user_question:  userQuestion  || "",
            character_name: characterName || "default",
            memory_context: memoryContext || "",
            isjson:         !!isJson
        };

        fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload)
        })
        .then(function (response) {
            if (requestId !== window._ai_request_id) {
                return null;
            }
            debugLog("收到响应 HTTP " + response.status);
            if (!response.ok) {
                return response.text().then(function (text) {
                    throw new Error("HTTP " + response.status + ": " + text.slice(0, 200));
                });
            }
            return response.json();
        })
        .then(function (data) {
            if (requestId !== window._ai_request_id || data === null) {
                return;
            }
            window.ai_result = data.content || "";
            window.ai_status = "done";
            debugLog("请求成功，结果长度=" + window.ai_result.length);
        })
        .catch(function (err) {
            if (requestId !== window._ai_request_id) {
                return;
            }
            window.ai_error  = String(err);
            window.ai_status = "error";
            debugLog("请求失败: " + window.ai_error);
        });
    };

    // ── 唤醒 Render 后端（减少首次 AI 请求的冷启动延迟） ────────────────────
    /**
     * 向后端 /health 发送一次轻量 GET 请求，触发 Render 冷启动唤醒。
     * 失败时静默处理，不影响正常流程。
     */
    window.wakeUpBackend = function () {
        var base = (window.AI_PROXY_BASE_URL || "https://echo-yonder.onrender.com").replace(/\/$/, "");
        var url = base + "/health";
        debugLog("唤醒后端: " + url);
        fetch(url, { method: "GET" })
            .then(function (res) {
                debugLog("后端唤醒成功，HTTP " + res.status);
            })
            .catch(function (err) {
                debugLog("后端唤醒请求失败（可忽略）: " + err);
            });
    };

    // 脚本加载后立即触发唤醒
    window.wakeUpBackend();

    console.log("[ai_bridge] Echo Yonder AI Bridge loaded. Backend:", (window.AI_PROXY_BASE_URL || "https://echo-yonder.onrender.com"));
})();
