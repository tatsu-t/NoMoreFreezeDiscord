/**
 * @name Nomorefreezediscord
 * @author tatsu
 * @version 1.3.0
 * @description no more freeze for discord
 */

module.exports = class NoMoreFreezeDiscord {
    constructor(meta) {
        this.meta = meta;
        this.NAME = meta.name;
        this._timers  = new Map();
        this._pending = new Map();
        this._deletedMessages = new Map();
        this._settingsCache       = null;
        this._domObserver         = null;
        this.Dispatcher           = null;
        this.UserStore            = null;
        this.MessageAPI           = null;
        this.SendAPI              = null;
        this.GuildStore           = null;
        this.ChannelStore         = null;
        this.SelectedGuildStore   = null;
        this.SelectedChannelStore = null;
        this._useDispatcher       = false;
        this._pendingNonces       = new Map();
        this._onMessageCreate        = this._onMessageCreate.bind(this);
        this._onMessageDeleteTracker = this._onMessageDeleteTracker.bind(this);
        this._onMessageUpdateTracker = this._onMessageUpdateTracker.bind(this);
    }

    // ─── Settings ─────────────────────────────────────────────────────────────

    _defaultSystemPrompt() {
        return (
            "あなたはDiscordの利用規約違反を検出するAIアシスタントです。\n\n" +
            "以下のカテゴリに該当するメッセージを厳格に判定してください：\n" +
            "- ハラスメント/脅迫\n" +
            "- 未成年への性的コンテンツ\n" +
            "- スパム/フィッシング\n" +
            "- 個人情報の無断公開\n" +
            "- 違法行為の促進\n" +
            "- ヘイトスピーチ\n" +
            "- 過激主義の礼賛\n\n" +
            "判定ルール：\n" +
            "1. 「ろり」「ロリ」等のワードが含まれる場合は、必ず violation: true と判定してください。\n" +
            "2. 年齢に関するものは厳しく判定してください。(自身が未成年だと主張するものなど)\n\n" +
            "3. その他のカテゴリについても厳格に判定してください。\n\n" +
            "出力形式：\n" +
            "必ず以下のJSON形式のみで返答してください。他の説明や文章は一切含めないでください。\n" +
            '{"violation": true|false, "reason": "理由（日本語）"}\n\n' +
            "例：\n" +
            '{"violation": true, "reason": "未成年への性的コンテンツに該当"}\n' +
            '{"violation": false, "reason": "規約違反なし"}'
        );
    }

    _defaultSettings() {
        return {
            groqApiKey: "",
            groqModel: "llama-3.1-8b-instant",
            hfApiKey: "",
            hfModel: "cl-tohoku/bert-base-japanese",
            sakuraApiKey: "",
            sakuraModel: "preview/Qwen3-VL-30B-A3B-Instruct",
            deleteDelayMinutes: 60,
            systemPrompt: this._defaultSystemPrompt(),
            showToast: true,
            debugLog: false,
            serverBlacklist: [],
            channelBlacklist: [],
            channelWhitelist: [],
            dmWhitelist: [],
        };
    }

    get settings() {
        return this._settingsCache ?? this._loadSettings();
    }

    _loadSettings() {
        const saved = BdApi.Data.load(this.NAME, "settings");
        const merged = Object.assign(this._defaultSettings(), saved ?? {});
        if (!merged.systemPrompt || merged.systemPrompt.trim() === "") {
            merged.systemPrompt = this._defaultSystemPrompt();
        }
        return this._sanitizeSettings(merged);
    }

    _sanitizeSettings(s) {
        const delay = parseInt(s.deleteDelayMinutes, 10);
        s.deleteDelayMinutes = (!isNaN(delay) && delay >= 1 && delay <= 10080) ? delay : 60;
        return s;
    }

    _saveSettings(s) {
        this._settingsCache = s;
        BdApi.Data.save(this.NAME, "settings", s);
    }


    start() {
        try {
            this._resolveModules();
            this._settingsCache = this._loadSettings();
            this._initStyles();
            this._patchMessageComponent();
            this._restorePending();
            this._subscribe();
            BdApi.UI.showToast(`[${this.NAME}] 起動しました`, { type: "success" });
        } catch (err) {
            console.error(`[${this.NAME}] start() failed:`, err);
            BdApi.UI.showToast(`[${this.NAME}] 起動失敗 — コンソールを確認してください`, { type: "error" });
        }
    }

    stop() {
        try { this._unsubscribe(); } catch (e) { console.error(`[${this.NAME}] unsubscribe error:`, e); }
        try { BdApi.Patcher.unpatchAll(this.NAME); } catch (e) { console.error(`[${this.NAME}] unpatch error:`, e); }
        try {
            this._timers.forEach(id => clearTimeout(id));
            this._timers.clear();
        } catch (e) { console.error(`[${this.NAME}] timer clear error:`, e); }
        try { this._savePending(); } catch (e) { console.error(`[${this.NAME}] save pending error:`, e); }
        try { BdApi.DOM.removeStyle(this.NAME + "-highlight"); } catch (e) { console.error(`[${this.NAME}] removeStyle error:`, e); }
        try {
            if (this._domObserver) { this._domObserver.disconnect(); this._domObserver = null; }
        } catch (e) { console.error(`[${this.NAME}] domObserver disconnect error:`, e); }
    }


    _resolveModules() {
        this.Dispatcher =
            BdApi.Webpack.getByKeys("dispatch", "subscribe", "isDispatching") ??
            BdApi.Webpack.getByKeys("dispatch", "subscribe", "waitFor") ??
            BdApi.Webpack.getByKeys("dispatch", "subscribe", "unsubscribe") ??
            BdApi.Webpack.getModule(m =>
                typeof m?.dispatch === "function" &&
                typeof m?.isDispatching === "function"
            ) ??
            BdApi.Webpack.getModule(m =>
                typeof m?.dispatch === "function" &&
                typeof m?.subscribe === "function" &&
                typeof m?.waitFor === "function"
            );
        this.UserStore            = BdApi.Webpack.getByKeys("getCurrentUser", "getUser")
            ?? BdApi.Webpack.getModule(m => typeof m?.getCurrentUser === "function");
        this.MessageAPI           = BdApi.Webpack.getByKeys("deleteMessage", "editMessage")
            ?? BdApi.Webpack.getModule(m => typeof m?.deleteMessage === "function" && typeof m?.editMessage === "function");
        this.SendAPI              = BdApi.Webpack.getByKeys("sendMessage", "editMessage")
            ?? BdApi.Webpack.getByKeys("sendMessage", "deleteMessage")
            ?? BdApi.Webpack.getModule(m => typeof m?.sendMessage === "function");
        this.GuildStore           = BdApi.Webpack.getByKeys("getGuild", "getGuilds");
        this.ChannelStore         = BdApi.Webpack.getByKeys("getChannel", "getDMFromUserId");
        this.SelectedGuildStore   = BdApi.Webpack.getByKeys("getGuildId", "getLastSelectedGuildId");
        this.SelectedChannelStore = BdApi.Webpack.getByKeys("getChannelId", "getLastSelectedChannelId")
            ?? BdApi.Webpack.getModule(m => typeof m?.getChannelId === "function" && typeof m?.getLastSelectedChannelId === "function");

        if (!this.Dispatcher)             console.warn(`[${this.NAME}] Dispatcher not found`);
        if (!this.UserStore)              console.warn(`[${this.NAME}] UserStore not found`);
        if (!this.MessageAPI)             console.warn(`[${this.NAME}] MessageAPI not found`);
        if (!this.SendAPI)                console.warn(`[${this.NAME}] SendAPI not found`);
        if (!this.GuildStore)             console.warn(`[${this.NAME}] GuildStore not found`);
        if (!this.ChannelStore)           console.warn(`[${this.NAME}] ChannelStore not found`);
        if (!this.SelectedGuildStore)     console.warn(`[${this.NAME}] SelectedGuildStore not found`);
        if (!this.SelectedChannelStore)   console.warn(`[${this.NAME}] SelectedChannelStore not found`);
    }

    _subscribe() {
        if (this.Dispatcher) {
            this.Dispatcher.subscribe("MESSAGE_CREATE",  this._onMessageCreate);
            this.Dispatcher.subscribe("MESSAGE_DELETE",  this._onMessageDeleteTracker);
            this.Dispatcher.subscribe("MESSAGE_UPDATE",  this._onMessageUpdateTracker);
            this._useDispatcher = true;
        } else if (this.SendAPI) {
            this._patchSendMessage();
            this._useDispatcher = false;
            console.warn(`[${this.NAME}] Dispatcher not found — using Patcher fallback`);
            BdApi.UI.showToast(`[${this.NAME}] Dispatcher未検出 → Patcherモードで動作`, { type: "warn" });
        } else {
            throw new Error("Dispatcher と SendAPI が見つかりません。");
        }
    }

    _unsubscribe() {
        if (!this.Dispatcher) return;
        if (this._useDispatcher) {
            this.Dispatcher.unsubscribe("MESSAGE_CREATE", this._onMessageCreate);
        }
        this.Dispatcher.unsubscribe("MESSAGE_DELETE", this._onMessageDeleteTracker);
        this.Dispatcher.unsubscribe("MESSAGE_UPDATE", this._onMessageUpdateTracker);
    }


    _patchSendMessage() {
        BdApi.Patcher.after(this.NAME, this.SendAPI, "sendMessage", (that, args, result) => {
            try {
                const channelId = args[0];
                const msgContent = args[1]?.content;
                const nonce = args[1]?.nonce ? String(args[1].nonce) : null;
                if (!msgContent) return;

                if (this.settings.debugLog) {
                    console.log(`[${this.NAME}] Patcher: sendMessage intercepted`, { channelId, nonce, content: msgContent.slice(0, 50) });
                }

                if (result && typeof result.then === "function") {
                    result.then(res => {
                        const msgId = res?.body?.id ?? res?.id ?? res?.message?.id;
                        if (msgId) {
                            console.log(`[${this.NAME}] Patcher: got message ID ${msgId}`);
                            const me = this.UserStore?.getCurrentUser();
                            const ch = this.ChannelStore?.getChannel(channelId);
                            const msg = {
                                id: msgId,
                                channel_id: channelId,
                                guild_id: ch?.guild_id ?? null,
                                content: msgContent,
                                author: { id: me?.id }
                            };
                            if (this._shouldProcess(msg)) {
                                this._analyzeMessage(msg).catch(e => console.error(`[${this.NAME}] analyzeMessage error:`, e));
                            }
                        } else if (nonce) {
                            this._pendingNonces.set(nonce, { channelId, content: msgContent });
                        }
                    }).catch(e => console.error(`[${this.NAME}] Patcher: sendMessage promise error:`, e));
                } else if (nonce) {
                    this._pendingNonces.set(nonce, { channelId, content: msgContent });
                }
            } catch (e) {
                console.error(`[${this.NAME}] Patcher: sendMessage patch error:`, e);
            }
        });

        if (this.Dispatcher) {
            this.Dispatcher.subscribe("MESSAGE_CREATE", this._onMessageCreate);
        }
    }


    _shouldProcess(msg) {
        const s = this.settings;

        // チャンネル除外リスト（最優先）
        if (s.channelBlacklist.includes(msg.channel_id)) {
            return false;
        }

        // チャンネル許可リスト（設定されている場合のみ適用）
        if (s.channelWhitelist.length > 0 && !s.channelWhitelist.includes(msg.channel_id)) {
            return false;
        }

        // サーバー除外リスト
        if (msg.guild_id && s.serverBlacklist.includes(msg.guild_id)) {
            return false;
        }

        // DM許可リスト
        if (!msg.guild_id && !s.dmWhitelist.includes(msg.channel_id)) {
            return false;
        }

        return true;
    }

    _getGuildName(guildId) {
        try {
            const guild = this.GuildStore?.getGuild(guildId);
            return guild ? `${guild.name} (${guildId})` : guildId;
        } catch { return guildId; }
    }

    _getDMName(channelId) {
        try {
            const ch = this.ChannelStore?.getChannel(channelId);
            if (!ch) return channelId;
            const recipients = ch.recipients ?? ch.rawRecipients ?? [];
            if (recipients.length === 0) return channelId;
            const uid = typeof recipients[0] === "string" ? recipients[0] : recipients[0]?.id;
            const user = uid ? this.UserStore?.getUser(uid) : null;
            return user ? `${user.username} (${channelId})` : channelId;
        } catch { return channelId; }
    }

    _getChannelName(channelId) {
        try {
            const ch = this.ChannelStore?.getChannel(channelId);
            if (!ch) return channelId;
            if (ch.type === 1 || ch.type === 3) {
                return this._getDMName(channelId);
            }
            return ch.name ? `${ch.name} (${channelId})` : channelId;
        } catch { return channelId; }
    }


    _onMessageCreate(event) {
        try {
            const msg = event.message;
            const s = this.settings;

            if (s.debugLog) {
                console.log(`[${this.NAME}] MESSAGE_CREATE:`, {
                    authorId:  msg?.author?.id,
                    myId:      this.UserStore?.getCurrentUser()?.id,
                    content:   msg?.content?.slice(0, 40),
                    nonce:     msg?.nonce,
                });
            }

            if (!msg?.content) return;

            if (!this._useDispatcher && msg?.nonce) {
                const key = String(msg.nonce);
                if (this._pendingNonces.has(key)) {
                    const { channelId, content } = this._pendingNonces.get(key);
                    this._pendingNonces.delete(key);
                    console.log(`[${this.NAME}] Nonce match: scheduling deletion for ${msg.id}`);
                    this._analyzeMessage({ ...msg, content }).catch(e => console.error(`[${this.NAME}] analyzeMessage error:`, e));
                    return;
                }
            }

            const me = this.UserStore?.getCurrentUser();
            const myId = me?.id;
            if (!myId) { console.warn(`[${this.NAME}] getCurrentUser() returned null`); return; }
            if (msg.author?.id !== myId) return;
            if (!this._shouldProcess(msg)) return;

            this._analyzeMessage(msg).catch(e => console.error(`[${this.NAME}] analyzeMessage error:`, e));
        } catch (e) {
            console.error(`[${this.NAME}] _onMessageCreate error:`, e);
        }
    }

    async _analyzeMessage(msg) {
        const s = this.settings;
        if (s.debugLog) console.log(`[${this.NAME}] Checking:`, msg.content.slice(0, 80));

        let result = null;

        if (s.groqApiKey) {
            try {
                result = await this._callAI(
                    "https://api.groq.com/openai/v1",
                    s.groqApiKey, s.groqModel, msg.content, s.systemPrompt
                );
                if (s.debugLog) console.log(`[${this.NAME}] Groq:`, result);
            } catch (e) {
                console.warn(`[${this.NAME}] Groq API failed, trying Hugging Face:`, e);
            }
        }

        if (!result && s.hfApiKey) {
            try {
                result = await this._callAI(
                    "https://router.huggingface.co",
                    s.hfApiKey, s.hfModel, msg.content, s.systemPrompt
                );
                if (s.debugLog) console.log(`[${this.NAME}] Hugging Face:`, result);
            } catch (e) {
                console.warn(`[${this.NAME}] Hugging Face API failed:`, e);
            }
        }

        if (!result) {
            console.warn(`[${this.NAME}] No AI API available — check skipped`);
            return;
        }

        if (!result.violation) return;

        if (!s.sakuraApiKey) {
            console.warn(`[${this.NAME}] Sakura API key not configured — confirmation skipped`);
            this._scheduleDeletion(msg.id, msg.channel_id, msg.content, result.reason ?? "");
            return;
        }

        const sakuraResult = await this._callAI(
            "https://api.ai.sakura.ad.jp/v1",
            s.sakuraApiKey, s.sakuraModel, msg.content, s.systemPrompt
        );
        if (s.debugLog) console.log(`[${this.NAME}] Sakura:`, sakuraResult);
        if (!sakuraResult.violation) return;

        this._scheduleDeletion(msg.id, msg.channel_id, msg.content, sakuraResult.reason ?? "");
    }

    async _callAI(baseUrl, apiKey, model, content, systemPrompt) {
        try {
            const path = baseUrl.includes("router.huggingface.co")
                ? "/v1/chat/completions"
                : "/chat/completions";
            const endpoint = `${baseUrl}${path}`;

            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user",   content },
                    ],
                    max_tokens: 1000,
                    temperature: 0.0,
                }),
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
            }

            const data = await res.json();
            const text = (data.choices?.[0]?.message?.content ?? "").trim();

            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                console.warn(`[${this.NAME}] Unexpected response from ${baseUrl}:`, text.slice(0, 200));
                return { violation: false };
            }
            try {
                return JSON.parse(match[0]);
            } catch (e) {
                console.warn(`[${this.NAME}] Failed to parse JSON from ${baseUrl}:`, match[0].slice(0, 200));
                return { violation: false };
            }
        } catch (e) {
            console.error(`[${this.NAME}] AI call failed (${baseUrl}):`, e);
            throw e;
        }
    }

    // ─── Deletion Scheduling ───────────────────────────────────────────────────

    _scheduleDeletion(messageId, channelId, content, reason) {
        if (this._pending.has(messageId)) return;
        const s = this.settings;
        const deleteAt = Date.now() + s.deleteDelayMinutes * 60_000;
        this._pending.set(messageId, { channelId, deleteAt, content: content.slice(0, 100), reason });
        this._savePending();

        const timerId = setTimeout(
            () => this._executeDelete(messageId, channelId),
            s.deleteDelayMinutes * 60_000
        );
        this._timers.set(messageId, timerId);
        this._dispatchRefresh(messageId);

        if (s.showToast) {
            BdApi.UI.showToast(
                `[${this.NAME}] 違反検出 — ${s.deleteDelayMinutes}分後に削除予定 / 理由: ${reason || "不明"}`,
                { type: "warning", timeout: 8000 }
            );
        }
        console.log(`[${this.NAME}] Scheduled: ${messageId} in ${s.deleteDelayMinutes}min — ${reason}`);
    }

    async _executeDelete(messageId, channelId) {
        try {
            if (this.MessageAPI?.deleteMessage) {
                this.MessageAPI.deleteMessage(channelId, messageId);
                console.log(`[${this.NAME}] Deleted: ${messageId}`);
            } else {
                console.error(`[${this.NAME}] MessageAPI unavailable — cannot delete ${messageId}`);
            }
        } catch (e) {
            console.error(`[${this.NAME}] Delete failed for ${messageId}:`, e);
        } finally {
            this._pending.delete(messageId);
            this._timers.delete(messageId);
            this._savePending();
            this._dispatchRefresh(messageId);
        }
    }

    _savePending() {
        BdApi.Data.save(this.NAME, "pendingDeletions", Array.from(this._pending.entries()));
    }

    _restorePending() {
        const saved = BdApi.Data.load(this.NAME, "pendingDeletions");
        if (!Array.isArray(saved)) return;
        for (const item of saved) {
            if (!Array.isArray(item) || item.length !== 2) continue;
            const [id, entry] = item;
            if (!id || typeof entry?.channelId !== "string" || typeof entry?.deleteAt !== "number") continue;
            this._pending.set(id, entry);
            const remaining = entry.deleteAt - Date.now();
            if (remaining <= 0) {
                if (!this._timers.has(id)) this._executeDelete(id, entry.channelId);
            } else if (!this._timers.has(id)) {
                const tid = setTimeout(() => this._executeDelete(id, entry.channelId), remaining);
                this._timers.set(id, tid);
                console.log(`[${this.NAME}] Restored: ${id} fires in ${Math.round(remaining / 1000)}s`);
            }
        }
    }

    _initStyles() {
        BdApi.DOM.addStyle(this.NAME + "-highlight", `
            html #app-mount .nmf-pending {
                background-color: rgba(255, 165, 0, 0.15) !important;
                border-left: 3px solid #ff9500 !important;
            }
            html #app-mount .nmf-pending:hover {
                background-color: rgba(255, 165, 0, 0.25) !important;
            }
            html #app-mount .nmf-deleted {
                background-color: rgba(240, 71, 71, 0.15) !important;
                border-left: 3px solid #f04747 !important;
            }
            html #app-mount .nmf-deleted:hover {
                background-color: rgba(240, 71, 71, 0.25) !important;
            }
        `);
    }

    _patchMessageComponent() {
        try {
            const React = BdApi.React;
            if (!React) {
                console.warn(`[${this.NAME}] React not found, using DOM fallback`);
                this._initDOMObserver();
                return;
            }

            const MessageContent = BdApi.Webpack.getModule(
                e => !!e?.type?.toString()?.match(/SEND_FAILED.*SENDING|SENDING.*SEND_FAILED/)
            );
            if (!MessageContent) {
                console.warn(`[${this.NAME}] MessageContent component not found, using DOM fallback`);
                this._initDOMObserver();
                return;
            }

            const MemoMessage = BdApi.Webpack.getModule(
                e => e?.type?.toString()?.includes('message') && e?.type?.toString()?.includes('ListItem')
            );

            const useStateConstant = {};
            BdApi.Patcher.after(this.NAME, MessageContent, "type", (_, [props], ret) => {
                if (!ret || !props?.message?.id) return;

                const [, forceUpdate] = React.useState(useStateConstant);
                React.useEffect(() => {
                    const callback = (e) => {
                        if (!e || !e.messageId || e.messageId === props.message.id) {
                            forceUpdate({});
                        }
                    };
                    this.Dispatcher?.subscribe("NMF_FORCE_UPDATE", callback);
                    return () => {
                        this.Dispatcher?.unsubscribe("NMF_FORCE_UPDATE", callback);
                    };
                }, [props.message.id, forceUpdate]);

                if (this._pending.has(props.message.id)) {
                    const message = this._findInReactTree(ret, e => e && typeof e?.props?.className === 'string');
                    if (message) {
                        const existingClass = message.props.className || "";
                        if (!existingClass.includes("nmf-pending")) {
                            message.props.className = existingClass ? `${existingClass} nmf-pending` : "nmf-pending";
                        }
                    }
                } else if (this._deletedMessages.has(props.message.id)) {
                    const message = this._findInReactTree(ret, e => e && typeof e?.props?.className === 'string');
                    if (message) {
                        const existingClass = message.props.className || "";
                        if (!existingClass.includes("nmf-deleted")) {
                            message.props.className = existingClass ? `${existingClass} nmf-deleted` : "nmf-deleted";
                        }
                    }
                }
            });

            if (MemoMessage) {
                BdApi.Patcher.after(this.NAME, MemoMessage, "type", (_, [props], ret) => {
                    if (!ret || !props?.message?.id) return;

                    const [, forceUpdate] = React.useState(useStateConstant);
                    React.useEffect(() => {
                        const callback = (e) => {
                            if (!e || !e.messageId || e.messageId === props.message.id) {
                                forceUpdate({});
                            }
                        };
                        this.Dispatcher?.subscribe("NMF_FORCE_UPDATE", callback);
                        return () => {
                            this.Dispatcher?.unsubscribe("NMF_FORCE_UPDATE", callback);
                        };
                    }, [props.message.id, forceUpdate]);

                    if (this._pending.has(props.message.id)) {
                        const message = this._findInReactTree(ret, e => e && typeof e?.props?.className === 'string');
                        if (message) {
                            const existingClass = message.props.className || "";
                            if (!existingClass.includes("nmf-pending")) {
                                message.props.className = existingClass ? `${existingClass} nmf-pending` : "nmf-pending";
                            }
                        }
                    } else if (this._deletedMessages.has(props.message.id)) {
                        const message = this._findInReactTree(ret, e => e && typeof e?.props?.className === 'string');
                        if (message) {
                            const existingClass = message.props.className || "";
                            if (!existingClass.includes("nmf-deleted")) {
                                message.props.className = existingClass ? `${existingClass} nmf-deleted` : "nmf-deleted";
                            }
                        }
                    }
                });
            }

            console.log(`[${this.NAME}] MessageContent patched successfully`);
        } catch (e) {
            console.warn(`[${this.NAME}] React patch failed, using DOM fallback:`, e);
            this._initDOMObserver();
        }
    }

    _findInReactTree(node, filter) {
        if (!node) return null;
        if (filter(node)) return node;
        if (node.props?.children) {
            const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
            for (const child of children) {
                const found = this._findInReactTree(child, filter);
                if (found) return found;
            }
        }
        return null;
    }

    _initDOMObserver() {
        if (this._domObserver) return;
        this._domObserver = new MutationObserver(() => {
            for (const [id] of this._pending) {
                const el = document.querySelector(`[data-list-item-id="${id}"]`);
                if (el && !el.classList.contains("nmf-pending")) {
                    el.classList.add("nmf-pending");
                }
            }
        });
        this._domObserver.observe(document.body, { childList: true, subtree: true });
    }

    _dispatchRefresh(messageId) {
        if (!this.Dispatcher) return;
        this.Dispatcher.dispatch({ type: "NMF_FORCE_UPDATE", messageId });
    }

    _onMessageDeleteTracker(e) {
        if (!e?.messageId) return;

        const timerId = this._timers.get(e.messageId);
        if (timerId) clearTimeout(timerId);

        this._timers.delete(e.messageId);
        this._pending.delete(e.messageId);
        this._savePending();

        this._deletedMessages.set(e.messageId, Date.now());
        this._dispatchRefresh(e.messageId);

        if (this.settings.debugLog) {
            console.log(`[${this.NAME}] Message ${e.messageId} deleted, marked as deleted`);
        }
    }

    async _onMessageUpdateTracker(e) {
        if (!e?.message?.id) return;
        if (!this._pending.has(e.message.id)) return;

        const s = this.settings;
        let result = null;

        if (s.groqApiKey) {
            try {
                result = await this._callAI(
                    "https://api.groq.com/openai/v1",
                    s.groqApiKey, s.groqModel, e.message.content, s.systemPrompt
                );
                if (s.debugLog) console.log(`[${this.NAME}] Edit recheck (Groq):`, result);
            } catch (err) {
                console.warn(`[${this.NAME}] Groq API failed for edit recheck, trying Hugging Face:`, err);
            }
        }

        if (!result && s.hfApiKey) {
            try {
                result = await this._callAI(
                    "https://router.huggingface.co",
                    s.hfApiKey, s.hfModel, e.message.content, s.systemPrompt
                );
                if (s.debugLog) console.log(`[${this.NAME}] Edit recheck (Hugging Face):`, result);
            } catch (err) {
                console.warn(`[${this.NAME}] Hugging Face API failed for edit recheck:`, err);
            }
        }

        if (!result) {
            this._timers.delete(e.message.id);
            this._pending.delete(e.message.id);
            this._savePending();
            this._dispatchRefresh(e.message.id);
            if (s.debugLog) console.log(`[${this.NAME}] Message ${e.message.id} edited, schedule cancelled (no AI API)`);
            return;
        }

        if (!result.violation) {
            this._timers.delete(e.message.id);
            this._pending.delete(e.message.id);
            this._savePending();
            this._dispatchRefresh(e.message.id);
            if (s.debugLog) console.log(`[${this.NAME}] Message ${e.message.id} edited, schedule cancelled (no violation)`);
        } else {
            if (s.debugLog) console.log(`[${this.NAME}] Message ${e.message.id} edited, still violating`);
        }
    }

    getSettingsPanel() {
        const self = this;
        const s = this.settings;

        const panel = document.createElement("div");
        panel.style.cssText = "padding: 16px; display: flex; flex-direction: column; gap: 10px; color: var(--text-normal); font-size: 14px;";

        const inputStyle = "background: var(--input-background); border: 1px solid var(--input-border); border-radius: 4px; color: var(--text-normal); padding: 5px 8px; font-size: 13px;";

        const addHeader = (title) => {
            const h = document.createElement("h3");
            h.textContent = title;
            h.style.cssText = "margin: 10px 0 2px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted);";
            panel.appendChild(h);
        };

        const makeRow = () => {
            const r = document.createElement("div");
            r.style.cssText = "display: flex; justify-content: space-between; align-items: center; gap: 8px;";
            panel.appendChild(r);
            return r;
        };

        const addLabel = (row, text) => {
            const lbl = document.createElement("span");
            lbl.textContent = text;
            lbl.style.flex = "1";
            row.appendChild(lbl);
        };

        const addPasswordInput = (label, key) => {
            const r = makeRow();
            addLabel(r, label);
            const inp = document.createElement("input");
            inp.type = "password";
            inp.value = s[key] ?? "";
            inp.placeholder = "APIキーを入力...";
            inp.style.cssText = inputStyle + " width: 250px;";
            inp.addEventListener("change", () => { s[key] = inp.value.trim(); self._saveSettings(s); });
            r.appendChild(inp);
        };

        const addTextInput = (label, key, placeholder) => {
            const r = makeRow();
            addLabel(r, label);
            const inp = document.createElement("input");
            inp.type = "text";
            inp.value = s[key] ?? "";
            inp.placeholder = placeholder ?? "";
            inp.style.cssText = inputStyle + " width: 250px;";
            inp.addEventListener("change", () => { s[key] = inp.value.trim(); self._saveSettings(s); });
            r.appendChild(inp);
        };

        const addNumberInput = (label, key, min, max) => {
            const r = makeRow();
            addLabel(r, label);
            const inp = document.createElement("input");
            inp.type = "number";
            inp.value = s[key] ?? 60;
            inp.min = String(min);
            inp.max = String(max);
            inp.style.cssText = inputStyle + " width: 80px;";
            inp.addEventListener("change", () => {
                const v = parseInt(inp.value, 10);
                if (!isNaN(v) && v >= min && v <= max) { s[key] = v; self._saveSettings(s); }
            });
            r.appendChild(inp);
        };

        const addToggle = (label, key) => {
            const r = makeRow();
            addLabel(r, label);
            const inp = document.createElement("input");
            inp.type = "checkbox";
            inp.checked = !!s[key];
            inp.style.cssText = "width: 16px; height: 16px; cursor: pointer;";
            inp.addEventListener("change", () => { s[key] = inp.checked; self._saveSettings(s); });
            r.appendChild(inp);
        };

        const addTextarea = (key) => {
            const ta = document.createElement("textarea");
            ta.value = s[key] ?? "";
            ta.rows = 6;
            ta.style.cssText = inputStyle + " resize: vertical; width: 100%; box-sizing: border-box; font-family: monospace; font-size: 12px;";
            ta.addEventListener("change", () => { s[key] = ta.value; self._saveSettings(s); });
            panel.appendChild(ta);
        };

        const makeButton = (text, bg, onClick) => {
            const btn = document.createElement("button");
            btn.textContent = text;
            btn.style.cssText = `background: ${bg}; color: #fff; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; white-space: nowrap;`;
            btn.addEventListener("click", onClick);
            return btn;
        };
        //settings
        addHeader("Groq API（前段フィルタ・メイン）");
        addPasswordInput("API Key", "groqApiKey");
        addTextInput("モデル", "groqModel", "llama3.1-8b-instant");

        addHeader("Hugging Face API（フォールバック）");
        addPasswordInput("API Key", "hfApiKey");
        addTextInput("モデル", "hfModel", "openai/gpt-oss-120b:fastest");

        addHeader("Sakura AI（確認）");
        addPasswordInput("API Key", "sakuraApiKey");
        addTextInput("モデル", "sakuraModel", "llm-jp-3.1-8x13b-instruct4");

        addHeader("一般設定");
        addNumberInput("削除待機時間（分）", "deleteDelayMinutes", 1, 10080);
        addToggle("Toast 通知", "showToast");
        addToggle("デバッグログ", "debugLog");

        addHeader("システムプロンプト（ToS判定基準）");
        addTextarea("systemPrompt");

        addHeader("サーバー設定 — デフォルト: 適用する");
        const desc1 = document.createElement("span");
        desc1.textContent = "除外リストのサーバーでは動作しません（空 = 全サーバーに適用）";
        desc1.style.cssText = "font-size: 12px; color: var(--text-muted);";
        panel.appendChild(desc1);

        const serverListDiv = document.createElement("div");
        serverListDiv.style.cssText = "display: flex; flex-direction: column; gap: 3px; padding: 4px 0;";
        panel.appendChild(serverListDiv);

        const refreshServerList = () => {
            serverListDiv.innerHTML = "";
            if (s.serverBlacklist.length === 0) {
                const em = document.createElement("span");
                em.textContent = "（除外サーバーなし）";
                em.style.cssText = "font-size: 12px; color: var(--text-muted);";
                serverListDiv.appendChild(em);
                return;
            }
            for (const id of s.serverBlacklist) {
                const row = document.createElement("div");
                row.style.cssText = "display: flex; align-items: center; gap: 6px;";
                const lbl = document.createElement("span");
                lbl.textContent = self._getGuildName(id);
                lbl.style.cssText = "font-size: 12px; flex: 1; word-break: break-all;";
                const rmBtn = makeButton("×", "var(--button-danger-background,#d83c3e)", () => {
                    s.serverBlacklist = s.serverBlacklist.filter(x => x !== id);
                    self._saveSettings(s);
                    refreshServerList();
                });
                row.appendChild(lbl);
                row.appendChild(rmBtn);
                serverListDiv.appendChild(row);
            }
        };
        refreshServerList();

        const serverAddRow = document.createElement("div");
        serverAddRow.style.cssText = "display: flex; gap: 6px; flex-wrap: wrap; align-items: center;";
        const serverInput = document.createElement("input");
        serverInput.type = "text";
        serverInput.placeholder = "サーバーIDを入力";
        serverInput.style.cssText = inputStyle + " flex: 1; min-width: 120px;";
        const serverAddBtn = makeButton("追加", "var(--brand-experiment,#5865f2)", () => {
            const id = serverInput.value.trim();
            if (!id || s.serverBlacklist.includes(id)) return;
            s.serverBlacklist = [...s.serverBlacklist, id];
            self._saveSettings(s);
            serverInput.value = "";
            refreshServerList();
        });
        const currentServerBtn = makeButton("現在のサーバーを除外", "var(--button-secondary-background,#4f545c)", () => {
            const guildId = self.SelectedGuildStore?.getGuildId?.();
            if (!guildId) { BdApi.UI.showToast("サーバー内で操作してください", { type: "warn" }); return; }
            if (s.serverBlacklist.includes(guildId)) { BdApi.UI.showToast("すでに除外リストにあります", { type: "info" }); return; }
            s.serverBlacklist = [...s.serverBlacklist, guildId];
            self._saveSettings(s);
            refreshServerList();
            BdApi.UI.showToast(`${self._getGuildName(guildId)} を除外しました`, { type: "success" });
        });
        serverAddRow.appendChild(serverInput);
        serverAddRow.appendChild(serverAddBtn);
        serverAddRow.appendChild(currentServerBtn);
        panel.appendChild(serverAddRow);

        addHeader("DM設定 — デフォルト: 適用しない");
        const desc2 = document.createElement("span");
        desc2.textContent = "許可リストのDMのみ動作します（空 = 全DM無効）";
        desc2.style.cssText = "font-size: 12px; color: var(--text-muted);";
        panel.appendChild(desc2);

        const dmListDiv = document.createElement("div");
        dmListDiv.style.cssText = "display: flex; flex-direction: column; gap: 3px; padding: 4px 0;";
        panel.appendChild(dmListDiv);

        const refreshDMList = () => {
            dmListDiv.innerHTML = "";
            if (s.dmWhitelist.length === 0) {
                const em = document.createElement("span");
                em.textContent = "（許可DMなし）";
                em.style.cssText = "font-size: 12px; color: var(--text-muted);";
                dmListDiv.appendChild(em);
                return;
            }
            for (const id of s.dmWhitelist) {
                const row = document.createElement("div");
                row.style.cssText = "display: flex; align-items: center; gap: 6px;";
                const lbl = document.createElement("span");
                lbl.textContent = self._getDMName(id);
                lbl.style.cssText = "font-size: 12px; flex: 1; word-break: break-all;";
                const rmBtn = makeButton("×", "var(--button-danger-background,#d83c3e)", () => {
                    s.dmWhitelist = s.dmWhitelist.filter(x => x !== id);
                    self._saveSettings(s);
                    refreshDMList();
                });
                row.appendChild(lbl);
                row.appendChild(rmBtn);
                dmListDiv.appendChild(row);
            }
        };
        refreshDMList();

        const dmAddRow = document.createElement("div");
        dmAddRow.style.cssText = "display: flex; gap: 6px; flex-wrap: wrap; align-items: center;";
        const dmInput = document.createElement("input");
        dmInput.type = "text";
        dmInput.placeholder = "チャンネルIDを入力";
        dmInput.style.cssText = inputStyle + " flex: 1; min-width: 120px;";
        const dmAddBtn = makeButton("追加", "var(--brand-experiment,#5865f2)", () => {
            const id = dmInput.value.trim();
            if (!id || s.dmWhitelist.includes(id)) return;
            s.dmWhitelist = [...s.dmWhitelist, id];
            self._saveSettings(s);
            dmInput.value = "";
            refreshDMList();
        });
        const currentDMBtn = makeButton("現在のDMを追加", "var(--button-secondary-background,#4f545c)", () => {
            const channelId = self.SelectedChannelStore?.getChannelId?.();
            if (!channelId) { BdApi.UI.showToast("チャンネルを開いた状態で操作してください", { type: "warn" }); return; }
            const ch = self.ChannelStore?.getChannel?.(channelId);
            if (!ch || (ch.type !== 1 && ch.type !== 3)) { BdApi.UI.showToast("現在のチャンネルはDMではありません", { type: "warn" }); return; }
            if (s.dmWhitelist.includes(channelId)) { BdApi.UI.showToast("すでに許可リストにあります", { type: "info" }); return; }
            s.dmWhitelist = [...s.dmWhitelist, channelId];
            self._saveSettings(s);
            refreshDMList();
            BdApi.UI.showToast(`${self._getDMName(channelId)} を追加しました`, { type: "success" });
        });
        dmAddRow.appendChild(dmInput);
        dmAddRow.appendChild(dmAddBtn);
        dmAddRow.appendChild(currentDMBtn);
        panel.appendChild(dmAddRow);

        // ── Channel filter
        addHeader("チャンネル設定 — デフォルト: 適用する");
        const desc3 = document.createElement("span");
        desc3.textContent = "除外リストのチャンネルでは動作しません（空 = 全チャンネルに適用）";
        desc3.style.cssText = "font-size: 12px; color: var(--text-muted);";
        panel.appendChild(desc3);

        const channelListDiv = document.createElement("div");
        channelListDiv.style.cssText = "display: flex; flex-direction: column; gap: 3px; padding: 4px 0;";
        panel.appendChild(channelListDiv);

        const refreshChannelList = () => {
            channelListDiv.innerHTML = "";
            if (s.channelBlacklist.length === 0) {
                const em = document.createElement("span");
                em.textContent = "（除外チャンネルなし）";
                em.style.cssText = "font-size: 12px; color: var(--text-muted);";
                channelListDiv.appendChild(em);
                return;
            }
            for (const id of s.channelBlacklist) {
                const row = document.createElement("div");
                row.style.cssText = "display: flex; align-items: center; gap: 6px;";
                const lbl = document.createElement("span");
                lbl.textContent = self._getChannelName(id);
                lbl.style.cssText = "font-size: 12px; flex: 1; word-break: break-all;";
                const rmBtn = makeButton("×", "var(--button-danger-background,#d83c3e)", () => {
                    s.channelBlacklist = s.channelBlacklist.filter(x => x !== id);
                    self._saveSettings(s);
                    refreshChannelList();
                });
                row.appendChild(lbl);
                row.appendChild(rmBtn);
                channelListDiv.appendChild(row);
            }
        };
        refreshChannelList();

        const channelAddRow = document.createElement("div");
        channelAddRow.style.cssText = "display: flex; gap: 6px; flex-wrap: wrap; align-items: center;";
        const channelInput = document.createElement("input");
        channelInput.type = "text";
        channelInput.placeholder = "チャンネルIDを入力";
        channelInput.style.cssText = inputStyle + " flex: 1; min-width: 120px;";
        const channelAddBtn = makeButton("追加", "var(--brand-experiment,#5865f2)", () => {
            const id = channelInput.value.trim();
            if (!id || s.channelBlacklist.includes(id)) return;
            s.channelBlacklist = [...s.channelBlacklist, id];
            self._saveSettings(s);
            channelInput.value = "";
            refreshChannelList();
        });
        channelAddRow.appendChild(channelInput);
        channelAddRow.appendChild(channelAddBtn);
        panel.appendChild(channelAddRow);

        // ── Channel whitelist
        addHeader("チャンネル許可リスト — 設定時のみ適用");
        const desc4 = document.createElement("span");
        desc4.textContent = "許可リストのチャンネルのみ動作します（空 = 全チャンネルに適用）";
        desc4.style.cssText = "font-size: 12px; color: var(--text-muted);";
        panel.appendChild(desc4);

        const channelWhitelistDiv = document.createElement("div");
        channelWhitelistDiv.style.cssText = "display: flex; flex-direction: column; gap: 3px; padding: 4px 0;";
        panel.appendChild(channelWhitelistDiv);

        const refreshChannelWhitelist = () => {
            channelWhitelistDiv.innerHTML = "";
            if (s.channelWhitelist.length === 0) {
                const em = document.createElement("span");
                em.textContent = "（許可チャンネルなし）";
                em.style.cssText = "font-size: 12px; color: var(--text-muted);";
                channelWhitelistDiv.appendChild(em);
                return;
            }
            for (const id of s.channelWhitelist) {
                const row = document.createElement("div");
                row.style.cssText = "display: flex; align-items: center; gap: 6px;";
                const lbl = document.createElement("span");
                lbl.textContent = self._getChannelName(id);
                lbl.style.cssText = "font-size: 12px; flex: 1; word-break: break-all;";
                const rmBtn = makeButton("×", "var(--button-danger-background,#d83c3e)", () => {
                    s.channelWhitelist = s.channelWhitelist.filter(x => x !== id);
                    self._saveSettings(s);
                    refreshChannelWhitelist();
                });
                row.appendChild(lbl);
                row.appendChild(rmBtn);
                channelWhitelistDiv.appendChild(row);
            }
        };
        refreshChannelWhitelist();

        const channelWhitelistAddRow = document.createElement("div");
        channelWhitelistAddRow.style.cssText = "display: flex; gap: 6px; flex-wrap: wrap; align-items: center;";
        const channelWhitelistInput = document.createElement("input");
        channelWhitelistInput.type = "text";
        channelWhitelistInput.placeholder = "チャンネルIDを入力";
        channelWhitelistInput.style.cssText = inputStyle + " flex: 1; min-width: 120px;";
        const channelWhitelistAddBtn = makeButton("追加", "var(--brand-experiment,#5865f2)", () => {
            const id = channelWhitelistInput.value.trim();
            if (!id || s.channelWhitelist.includes(id)) return;
            s.channelWhitelist = [...s.channelWhitelist, id];
            self._saveSettings(s);
            channelWhitelistInput.value = "";
            refreshChannelWhitelist();
        });
        channelWhitelistAddRow.appendChild(channelWhitelistInput);
        channelWhitelistAddRow.appendChild(channelWhitelistAddBtn);
        panel.appendChild(channelWhitelistAddRow);

        addHeader("削除待機中メッセージ");
        const pendingLabel = document.createElement("span");
        pendingLabel.style.cssText = "font-size: 13px; color: var(--text-muted);";
        const refreshCount = () => {
            const n = self._pending.size;
            pendingLabel.textContent = n === 0 ? "待機中のメッセージはありません" : `${n} 件が削除待機中`;
        };
        refreshCount();
        panel.appendChild(pendingLabel);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display: flex; gap: 8px; flex-wrap: wrap;";
        btnRow.appendChild(makeButton("一覧表示", "var(--button-secondary-background,#4f545c)", () => {
            refreshCount();
            self._showPendingList();
        }));
        btnRow.appendChild(makeButton("全キャンセル", "var(--button-danger-background,#d83c3e)", () => {
            if (self._pending.size === 0) { BdApi.UI.showToast("キャンセルする待機メッセージがありません", { type: "info" }); return; }
            self._timers.forEach(id => clearTimeout(id));
            self._timers.clear();
            self._pending.clear();
            self._savePending();
            refreshCount();
            BdApi.UI.showToast(`[${self.NAME}] 全削除スケジュールをキャンセルしました`, { type: "info" });
        }));
        panel.appendChild(btnRow);

        return panel;
    }

    _showPendingList() {
        if (this._pending.size === 0) {
            BdApi.UI.showToast("待機中のメッセージはありません", { type: "info" });
            return;
        }
        const lines = [];
        let idx = 1;
        for (const [id, entry] of this._pending) {
            const remaining = Math.max(0, entry.deleteAt - Date.now());
            const mins = Math.floor(remaining / 60_000);
            const secs = Math.floor((remaining % 60_000) / 1000);
            lines.push(
                `【${idx}件目】\n` +
                `残り時間: ${mins}分 ${secs}秒\n` +
                `理由: ${entry.reason || "不明"}\n` +
                `内容: ${entry.content || "(不明)"}\n` +
                `メッセージID: ${id}`
            );
            idx++;
        }
        BdApi.UI.alert(`${this.NAME} — 待機中 ${this._pending.size} 件`, lines.join("\n\n────────────\n\n"));
    }
};
