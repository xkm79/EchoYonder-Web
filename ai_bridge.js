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

    // 图片请求使用独立状态机，避免覆盖同时存在的文本请求。
    window.ai_image_status = "idle";
    window.ai_image_path = "";
    window.ai_image_error = "";
    window._ai_image_request_id = 0;

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

    function repairLegacyServiceWorker() {
        if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
            return;
        }

        var reloadKey = "echoYonderServiceWorkerRepairReloaded";
        fetch("service-worker.js", { cache: "no-store" })
            .then(function (response) {
                if (!response.ok) {
                    return "";
                }
                return response.text();
            })
            .then(function (source) {
                if (source.indexOf("echo-yonder-patch: service-worker network bypass") !== -1) {
                    return;
                }
                if (window.sessionStorage && window.sessionStorage.getItem(reloadKey) === "1") {
                    debugLog("检测到旧 Service Worker，但已刷新过一次，避免重复刷新。");
                    return;
                }

                debugLog("检测到旧 Service Worker，自动注销并刷新页面。");
                return navigator.serviceWorker.getRegistrations()
                    .then(function (registrations) {
                        return Promise.all(registrations.map(function (registration) {
                            var worker = registration.active || registration.waiting || registration.installing;
                            var scriptUrl = worker && worker.scriptURL ? worker.scriptURL : "";
                            if (scriptUrl.indexOf("/service-worker.js") === -1) {
                                return false;
                            }
                            return registration.unregister();
                        }));
                    })
                    .then(function () {
                        if (window.sessionStorage) {
                            window.sessionStorage.setItem(reloadKey, "1");
                        }
                        window.location.reload();
                    });
            })
            .catch(function (error) {
                debugLog("Service Worker 自修复检查失败（可忽略）: " + error);
            });
    }

    /**
     * 发起 AI 对话请求。
     *
     * @param {string}  userQuestion   玩家输入内容
     * @param {string}  characterName  对话角色名（对应后端 prompts.json 中的 key）
     * @param {string}  memoryContext  记忆上下文（可为空字符串）
     * @param {boolean} isJson         是否要求后端返回 JSON 格式
     */
    window.start_ai_request = function (userQuestion, characterName, memoryContext, isJson, timeoutSeconds) {
        var requestId = window._ai_request_id + 1;
        window._ai_request_id = requestId;

        // 重置状态
        window.ai_status = "loading";
        window.ai_result = "";
        window.ai_error  = "";

        var url = getBackendUrl();
        var timeoutMs = Math.max(1, Number(timeoutSeconds) || 40) * 1000;
        var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
        var timeoutHandle = null;
        if (controller) {
            timeoutHandle = window.setTimeout(function () {
                controller.abort();
            }, timeoutMs);
        }

        debugLog("发起请求 → " + url + "  角色=" + characterName + " isjson=" + isJson + " timeout=" + timeoutMs + "ms");

        var payload = {
            user_question:  userQuestion  || "",
            character_name: characterName || "default",
            memory_context: memoryContext || "",
            isjson:         !!isJson
        };

        fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
            signal:  controller ? controller.signal : undefined
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
            if (timeoutHandle !== null) {
                window.clearTimeout(timeoutHandle);
            }
            window.ai_result = data.content || "";
            window.ai_status = "done";
            debugLog("请求成功，结果长度=" + window.ai_result.length);
        })
        .catch(function (err) {
            if (requestId !== window._ai_request_id) {
                return;
            }
            if (timeoutHandle !== null) {
                window.clearTimeout(timeoutHandle);
            }
            window.ai_error  = String(err);
            window.ai_status = "error";
            debugLog("请求失败: " + window.ai_error);
        });
    };

    function getImageProxyUrl() {
        var base = (window.AI_PROXY_BASE_URL || "https://echo-yonder.onrender.com").replace(/\/$/, "");
        return base + "/api/images/volcengine/request";
    }

    function findNestedValue(value, keys) {
        if (!value || typeof value !== "object") {
            return "";
        }
        for (var i = 0; i < keys.length; i += 1) {
            var direct = value[keys[i]];
            if (typeof direct === "string" && direct) {
                return direct;
            }
            if (Array.isArray(direct) && direct.length && typeof direct[0] === "string") {
                return direct[0];
            }
        }
        var values = Array.isArray(value) ? value : Object.keys(value).map(function (key) {
            return value[key];
        });
        for (var j = 0; j < values.length; j += 1) {
            var nested = findNestedValue(values[j], keys);
            if (nested) {
                return nested;
            }
        }
        return "";
    }

    function postImageAction(action, body) {
        return fetch(getImageProxyUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: action, body: body })
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("图片代理 HTTP " + response.status);
            }
            return response.json();
        }).then(function (payload) {
            if (!payload.ok) {
                throw new Error(payload.error || "图片代理返回失败");
            }
            return payload.data || {};
        });
    }

    function delay(milliseconds) {
        return new Promise(function (resolve) {
            window.setTimeout(resolve, milliseconds);
        });
    }

    function saveImageBase64(base64Value, requestId) {
        var cleaned = String(base64Value || "").replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
        if (!cleaned) {
            throw new Error("图片接口没有返回有效 base64");
        }

        var binary = window.atob(cleaned);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }

        var extension = "png";
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
            extension = "jpg";
        } else if (
            bytes.length >= 12
            && bytes[0] === 0x52 && bytes[1] === 0x49
            && bytes[2] === 0x46 && bytes[3] === 0x46
            && bytes[8] === 0x57 && bytes[9] === 0x45
            && bytes[10] === 0x42 && bytes[11] === 0x50
        ) {
            extension = "webp";
        }

        var fs = (window.Module && window.Module.FS)
            || (typeof FS !== "undefined" ? FS : null);
        if (!fs) {
            throw new Error("Ren'Py Web 文件系统尚未就绪");
        }

        var directory = "/game/generated/ai_bad_end";
        fs.mkdirTree(directory);
        var filename = "ai_bad_ending_web_" + requestId + "_" + Date.now() + "." + extension;
        fs.writeFile(directory + "/" + filename, bytes);
        return "generated/ai_bad_end/" + filename;
    }

    window.reset_ai_image_status = function () {
        window._ai_image_request_id += 1;
        window.ai_image_status = "idle";
        window.ai_image_path = "";
        window.ai_image_error = "";
    };

    window.start_ai_image_request = function (prompt) {
        var requestId = window._ai_image_request_id + 1;
        window._ai_image_request_id = requestId;
        window.ai_image_status = "loading";
        window.ai_image_path = "";
        window.ai_image_error = "";

        var reqKey = "high_aes_general_v30l_zt2i";
        var submitBody = {
            req_key: reqKey,
            prompt: prompt || "",
            return_url: false,
            logo_info: { add_logo: false },
            width: 1920,
            height: 1080,
            scale: 2.5,
            seed: -1,
            use_pre_llm: false
        };

        debugLog("发起图片请求 → " + getImageProxyUrl());
        postImageAction("CVSync2AsyncSubmitTask", submitBody)
        .then(function (submitData) {
            var immediateBase64 = findNestedValue(
                submitData,
                ["binary_data_base64", "binaryDataBase64", "b64_json"]
            );
            if (immediateBase64) {
                return immediateBase64;
            }

            var taskId = findNestedValue(
                submitData,
                ["task_id", "taskId", "TaskId", "taskID", "TaskID"]
            );
            if (!taskId) {
                throw new Error("图片任务没有返回 task_id");
            }

            var pollBody = {
                req_key: reqKey,
                task_id: taskId,
                return_url: false
            };
            var attempts = 0;

            function poll() {
                if (requestId !== window._ai_image_request_id) {
                    throw new Error("图片请求已取消");
                }
                attempts += 1;
                return delay(2000).then(function () {
                    return postImageAction("CVSync2AsyncGetResult", pollBody);
                }).then(function (resultData) {
                    var base64Value = findNestedValue(
                        resultData,
                        ["binary_data_base64", "binaryDataBase64", "b64_json"]
                    );
                    if (base64Value) {
                        return base64Value;
                    }
                    if (attempts >= 45) {
                        throw new Error("图片任务轮询超时");
                    }
                    return poll();
                });
            }

            return poll();
        })
        .then(function (base64Value) {
            if (requestId !== window._ai_image_request_id) {
                return;
            }
            window.ai_image_path = saveImageBase64(base64Value, requestId);
            window.ai_image_status = "done";
            debugLog("图片请求成功，路径=" + window.ai_image_path);
        })
        .catch(function (error) {
            if (requestId !== window._ai_image_request_id) {
                return;
            }
            window.ai_image_error = String(error);
            window.ai_image_status = "error";
            debugLog("图片请求失败: " + window.ai_image_error);
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

    // 脚本加载后先修复旧缓存层，再触发唤醒。
    repairLegacyServiceWorker();
    window.wakeUpBackend();

    console.log("[ai_bridge] Echo Yonder AI Bridge loaded. Backend:", (window.AI_PROXY_BASE_URL || "https://echo-yonder.onrender.com"));

    // ── 修复 Web 端 #inputDiv 位置偏移到顶部的问题 ───────────────────────────
    //
    // RenPy Web 版的输入框是固定在 index.html 里的 #inputDiv（含 #inputPrompt
    // 和 #inputText），其默认 CSS 为 top:0，导致出现在画面顶部。
    // 此处在页面就绪后直接覆盖其样式，将其移到游戏画面底部对话框区域。
    (function fixRenpyInputDivPosition() {
        function applyFix() {
            var inputDiv = document.getElementById("inputDiv");
            if (!inputDiv) { return; }

            // 移除原来的 top:0，改为贴底部
            inputDiv.style.top    = "auto";
            inputDiv.style.bottom = "15%";
            // 圆角改为上方
            inputDiv.style.borderRadius = "5px 5px 0 0";

            console.log("[ai_bridge] #inputDiv position fixed to bottom.");
        }

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", applyFix);
        } else {
            applyFix();
        }
    })();
})();
